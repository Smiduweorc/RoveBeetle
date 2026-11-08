import type { Transport } from "../auth.js";
import type { CallOptions, McpServer, McpTemplate, OAuth2Auth, ToolCall } from "../call.js";
import { decodeData } from "../decode.js";
import { RoveError } from "../errors.js";
import { checkLimit, readLimited, utf8, type ResponseLimit } from "../limit.js";
import { readLines } from "../lines.js";
import { McpSession, serverKey, type McpTransport } from "../mcp.js";
import { mediaType, send } from "../request.js";
import { HTTP_SCHEMES, secureUrl } from "../secure.js";
import { Session, type ClientOptions } from "../session.js";
import { readEvents } from "../sse.js";
import { DEFAULT_INHERITED } from "../environment.js";

/** Options for an {@link McpClient}. `maxResponseBytes` bounds each message from a server. */
export interface McpClientOptions<TVariables extends string> extends ClientOptions<TVariables>, ResponseLimit {
	/**
	 * The environment stdio servers may inherit from, as for the `cli`
	 * client: usually `process.env`, or `{}`. Only the spec's default list
	 * (`DEFAULT_INHERITED`) reaches the server, plus the server's own `env`.
	 * Required even for HTTP servers, so a manual that later gains a stdio
	 * server cannot start one with an environment you never chose.
	 */
	readonly environment: Readonly<Record<string, string | undefined>>;
}

/** Reported to servers as `clientInfo.version`. */
const CLIENT_VERSION = "0.1.0";

/**
 * Calls `mcp` tools. Sessions belong to this client: the first call to a
 * server opens one (spawning a stdio server, or initializing over HTTP), and
 * later calls reuse it until {@link close}. Concurrent calls share a session.
 *
 * A stdio server needs Node (`node:child_process`, loaded only when one is
 * used); an HTTP server needs only `fetch`. The legacy HTTP+SSE transport of
 * protocol 2024-11-05 is not supported.
 */
export class McpClient<TVariables extends string = never> {
	readonly #session: Session;
	readonly #limit: number;
	readonly #environment: Readonly<Record<string, string | undefined>>;
	readonly #sessions = new Map<string, Promise<McpSession>>();

	constructor(options: McpClientOptions<TVariables>) {
		this.#session = new Session(options, options?.maxResponseBytes);
		this.#limit = checkLimit(options);
		if (typeof options.environment !== "object" || options.environment === null) {
			throw new RoveError("environment is required: pass process.env for stdio servers to inherit from, or {}", {
				code: "unsupported_value",
			});
		}
		this.#environment = options.environment;
	}

	/**
	 * Calls the tool (`tools/call`) or reads the resource (`resources/read`)
	 * and resolves with the result.
	 *
	 * | Result | Resolves to |
	 * | --- | --- |
	 * | `isError: true` | rejects with `status`, the text content as `body` |
	 * | `structuredContent` | it, or its `result` when the schema marks FastMCP's wrapper |
	 * | one text content | the text, decoded as the template says |
	 * | other content | the `content` array as sent |
	 * | a resource | the `contents` array as sent |
	 *
	 * @throws {RoveError} `status` (a JSON-RPC error or `isError`),
	 * `protocol_error`, `transport_failed`, `decode_failed`, and the request
	 * errors for HTTP servers. An abort sends `notifications/cancelled` and
	 * rejects with the signal's reason.
	 */
	async call<TResult>(call: ToolCall<"mcp", TResult, TVariables>, options: CallOptions = {}): Promise<TResult> {
		const template = this.#session.resolve(call, ["mcp"]);
		const session = await this.#open(template, call.tool, options.signal);

		if (template.resourceUri !== undefined) {
			const result = (await session.request("resources/read", { uri: template.resourceUri }, options.signal)) as { contents?: unknown };
			return result.contents as TResult;
		}

		const args = Object.fromEntries(Object.entries(call.args).filter(([, value]) => value !== undefined));
		const result = (await session.request("tools/call", { name: template.toolName, arguments: args }, options.signal)) as {
			content?: unknown;
			structuredContent?: unknown;
			isError?: unknown;
		};
		const target = template.serverName;

		if (result.isError === true) {
			throw new RoveError(`tool ${call.tool} reported an error`, { code: "status", tool: call.tool, target, body: textOf(result.content) });
		}
		if (result.structuredContent !== undefined) {
			const structured = result.structuredContent;
			if (template.unwrapResult && typeof structured === "object" && structured !== null && "result" in structured) {
				return (structured as { result: unknown }).result as TResult;
			}
			return structured as TResult;
		}
		const content = result.content;
		if (Array.isArray(content) && content.length === 1) {
			const [only] = content as { type?: unknown; text?: unknown }[];
			if (only?.type === "text" && typeof only.text === "string") {
				return decodeData(only.text, template.dataFormat, call.tool, target) as TResult;
			}
		}
		return content as TResult;
	}

	/**
	 * Lists every tool a server offers, following `nextCursor` to the end.
	 * Used by the generator to discover a manual.
	 */
	async listTools(template: McpTemplate, signal?: AbortSignal): Promise<readonly Record<string, unknown>[]> {
		return this.#list(template, "tools/list", "tools", signal);
	}

	/** Lists every resource a server offers, following `nextCursor` to the end. */
	async listResources(template: McpTemplate, signal?: AbortSignal): Promise<readonly Record<string, unknown>[]> {
		return this.#list(template, "resources/list", "resources", signal);
	}

	/** Ends every session this client opened, stopping stdio servers. */
	async close(): Promise<void> {
		const sessions = [...this.#sessions.values()];
		this.#sessions.clear();
		await Promise.all(sessions.map(async (pending) => (await pending.catch(() => undefined))?.close()));
	}

	async #list(template: McpTemplate, method: string, key: string, signal: AbortSignal | undefined): Promise<Record<string, unknown>[]> {
		const session = await this.#open(template, template.serverName, signal);
		const items: Record<string, unknown>[] = [];
		let cursor: string | undefined;
		do {
			const page = (await session.request(method, cursor === undefined ? {} : { cursor }, signal)) as Record<string, unknown>;
			const list = page[key];
			if (!Array.isArray(list)) {
				throw new RoveError(`the MCP server ${template.serverName} answered ${method} without ${key}`, {
					code: "protocol_error",
					target: template.serverName,
				});
			}
			items.push(...(list as Record<string, unknown>[]));
			cursor = typeof page.nextCursor === "string" && page.nextCursor.length > 0 ? page.nextCursor : undefined;
		} while (cursor !== undefined);
		return items;
	}

	async #open(template: McpTemplate, tool: string, signal: AbortSignal | undefined): Promise<McpSession> {
		const key = serverKey(template.serverName, template.server, template.auth);
		const existing = this.#sessions.get(key);
		if (existing !== undefined) {
			const session = await existing.catch(() => undefined);
			if (session !== undefined && !session.closed) {
				return session;
			}
			this.#sessions.delete(key);
		}

		const opening = (async (): Promise<McpSession> => {
			const transport =
				template.server.transport === "stdio"
					? await stdioTransport(template.server, this.#environment, this.#limit, tool, template.serverName)
					: httpTransport(template.server, template.auth, this.#session, this.#limit, tool);
			return McpSession.open(transport, template.serverName, tool, CLIENT_VERSION, signal);
		})();
		this.#sessions.set(key, opening);
		opening.catch(() => {
			if (this.#sessions.get(key) === opening) {
				this.#sessions.delete(key);
			}
		});
		return opening;
	}
}

/** The text of every text content item, for an error body. */
function textOf(content: unknown): string {
	if (!Array.isArray(content)) {
		return JSON.stringify(content);
	}
	return content
		.map((item: { type?: unknown; text?: unknown }) => (item.type === "text" && typeof item.text === "string" ? item.text : JSON.stringify(item)))
		.join("\n");
}

function parseMessage(text: string, tool: string, target: string): Record<string, unknown> | undefined {
	try {
		const value = JSON.parse(text) as unknown;
		return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
	} catch (cause) {
		throw new RoveError(`the MCP server ${target} sent a message that is not JSON`, { code: "protocol_error", tool, target, body: text, cause });
	}
}

async function stdioTransport(
	server: Extract<McpServer, { transport: "stdio" }>,
	environment: Readonly<Record<string, string | undefined>>,
	limit: number,
	tool: string,
	target: string
): Promise<McpTransport> {
	// Loaded here so the subpath imports no `node:` module until a stdio
	// server is used; an HTTP-only consumer can run it in a browser.
	const { spawn } = await import("node:child_process");
	const windows = process.platform === "win32";

	const env: Record<string, string> = {};
	for (const name of DEFAULT_INHERITED[windows ? "windows" : "unix"]) {
		const value = environment[name];
		if (value !== undefined) {
			env[name] = value;
		}
	}
	Object.assign(env, server.env);

	const child = spawn(server.command, [...server.args], {
		env,
		cwd: server.cwd,
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
		detached: !windows,
	});
	let stderr = "";
	child.stderr.on("data", (chunk: Uint8Array) => {
		if (stderr.length < limit) {
			stderr += utf8(chunk).slice(0, limit - stderr.length);
		}
	});

	const transport: McpTransport = {
		onMessage: undefined,
		onClose: undefined,
		send: (message) =>
			new Promise((resolve, reject) => {
				if (!child.stdin.writable) {
					reject(new RoveError(`the MCP server ${target} is not running`, { code: "transport_failed", tool, target, body: stderr }));
					return;
				}
				child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
					if (error === null || error === undefined) {
						resolve();
					} else {
						reject(new RoveError(`could not write to the MCP server ${target}`, { code: "transport_failed", tool, target, cause: error }));
					}
				});
			}),
		close: async () => {
			child.stdin.end();
			if (child.exitCode === null && child.pid !== undefined) {
				const exited = new Promise((resolve) => child.once("close", resolve));
				try {
					if (windows) {
						spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
					} else {
						process.kill(-child.pid, "SIGTERM");
					}
				} catch {
					// Already gone.
				}
				await exited;
			}
		},
	};

	const started = new Promise<void>((resolve, reject) => {
		child.once("spawn", () => resolve());
		child.once("error", (cause) =>
			reject(new RoveError(`could not start the MCP server ${target}`, { code: "transport_failed", tool, target, cause }))
		);
	});

	child.on("close", (code) => {
		transport.onClose?.(
			new RoveError(`the MCP server ${target} exited${code === null ? "" : ` with status ${code}`}`, {
				code: "transport_failed",
				tool,
				target,
				body: stderr,
				...(code === null ? {} : { status: code }),
			})
		);
	});

	await started;

	const stdout = new ReadableStream<Uint8Array>({
		start(controller) {
			child.stdout.on("data", (chunk: Uint8Array) => controller.enqueue(new Uint8Array(chunk)));
			child.stdout.on("end", () => controller.close());
			child.stdout.on("error", (error) => controller.error(error));
		},
	});
	void (async () => {
		try {
			for await (const line of readLines(stdout, limit, tool, target, undefined)) {
				const message = parseMessage(line, tool, target);
				if (message !== undefined) {
					transport.onMessage?.(message);
				}
			}
		} catch (error) {
			transport.onClose?.(error instanceof RoveError ? error : undefined);
			await transport.close().catch(() => undefined);
		}
	})();

	return transport;
}

function httpTransport(
	server: Extract<McpServer, { transport: "http" }>,
	auth: OAuth2Auth | undefined,
	session: Session,
	limit: number,
	tool: string
): McpTransport {
	const url = secureUrl(server.url, HTTP_SCHEMES, tool);
	const target = url.toString();
	const fetchVia: Transport = session.transport;
	let sessionId: string | undefined;
	let protocolVersion: string | undefined;

	const headersFor = async (signal: AbortSignal | undefined): Promise<Headers> => {
		const headers = new Headers(server.headers);
		headers.set("accept", "application/json, text/event-stream");
		headers.set("content-type", "application/json");
		if (sessionId !== undefined) {
			headers.set("mcp-session-id", sessionId);
		}
		if (protocolVersion !== undefined) {
			headers.set("mcp-protocol-version", protocolVersion);
		}
		if (auth !== undefined) {
			headers.set("authorization", `Bearer ${await session.tokens.token(auth, tool, signal)}`);
		}
		return headers;
	};

	const transport: McpTransport = {
		onMessage: undefined,
		onClose: undefined,
		send: async (message, signal) => {
			const response = await send(
				{ url, method: "POST", headers: await headersFor(signal), body: JSON.stringify(message) },
				fetchVia,
				"same-origin",
				tool,
				signal
			);

			if (response.status === 404 && sessionId !== undefined) {
				await response.body?.cancel();
				const expired = new RoveError(`the MCP server ${target} no longer knows this session; the next call opens a new one`, {
					code: "transport_failed",
					tool,
					target,
					status: 404,
				});
				transport.onClose?.(expired);
				throw expired;
			}
			if (!response.ok) {
				const body = await readLimited(response, limit, tool, target, signal).then(utf8, () => undefined);
				throw new RoveError(`the MCP server ${target} answered HTTP ${response.status}`, {
					code: "status",
					tool,
					target,
					status: response.status,
					headers: response.headers,
					body,
				});
			}

			const id = response.headers.get("mcp-session-id");
			if (id !== null && message.method === "initialize") {
				sessionId = id;
			}

			if (response.status === 202 || response.body === null) {
				await response.body?.cancel();
				return;
			}
			const media = mediaType(response);
			if (media === "text/event-stream") {
				for await (const event of readEvents(response.body, limit, tool, target, signal)) {
					const parsed = parseMessage(event.data, tool, target);
					if (parsed !== undefined) {
						noteVersion(parsed);
						transport.onMessage?.(parsed);
					}
				}
				return;
			}
			if (media === "application/json") {
				const text = utf8(await readLimited(response, limit, tool, target, signal));
				const parsed = parseMessage(text, tool, target);
				if (parsed !== undefined) {
					noteVersion(parsed);
					transport.onMessage?.(parsed);
				}
				return;
			}
			await response.body.cancel();
			throw new RoveError(`the MCP server ${target} answered ${JSON.stringify(media)}`, { code: "protocol_error", tool, target });
		},
		close: async () => {
			if (sessionId === undefined) {
				return;
			}
			// Best effort: a server may refuse DELETE with 405, and the session
			// expires on its own.
			const headers = await headersFor(undefined).catch(() => undefined);
			if (headers !== undefined) {
				await fetchVia(new Request(url, { method: "DELETE", headers, redirect: "manual" }))
					.then((response) => response.body?.cancel())
					.catch(() => undefined);
			}
			sessionId = undefined;
		},
	};

	/** Later requests carry the negotiated revision in `MCP-Protocol-Version`. */
	function noteVersion(message: Record<string, unknown>): void {
		const result = message.result as { protocolVersion?: unknown } | undefined;
		if (typeof result?.protocolVersion === "string" && protocolVersion === undefined) {
			protocolVersion = result.protocolVersion;
		}
	}

	return transport;
}
