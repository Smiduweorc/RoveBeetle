import type { McpServer, OAuth2Auth } from "./call.js";
import { RoveError } from "./errors.js";

// The client half of the Model Context Protocol: JSON-RPC 2.0 sessions over
// stdio (one message per line) and Streamable HTTP. Only what calling and
// listing tools needs: `initialize`, `tools/list`, `tools/call`,
// `resources/list`, `resources/read`. This client declares no capabilities,
// so a server request for sampling, roots or elicitation is answered with
// "method not found", and `ping` with an empty result.

/**
 * Protocol revisions this client speaks, newest first. The first is offered
 * in `initialize`; a server answering with any of them is accepted. These
 * are the revisions `@modelcontextprotocol/sdk` 1.32.2 supports, which the
 * conformance tests run against.
 */
export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"] as const;

/** One JSON-RPC message, as parsed. */
type Message = Record<string, unknown>;

/** Moves messages for one session. */
export interface McpTransport {
	/** Sends one message. Responses may arrive on `receive` or come back from this call. */
	send(message: Message, signal: AbortSignal | undefined): Promise<void>;
	/** Called with every message the server sends. Set once, before the first send. */
	onMessage: ((message: Message) => void) | undefined;
	/** Called once when the transport ends, with the reason if it failed. */
	onClose: ((error: RoveError | undefined) => void) | undefined;
	close(): Promise<void>;
}

interface Pending {
	readonly resolve: (result: unknown) => void;
	readonly reject: (error: unknown) => void;
	readonly method: string;
}

/**
 * One initialized session with one server.
 *
 * Requests are matched to responses by id, so concurrent calls share it.
 * When the transport ends, every pending request fails with its error.
 */
export class McpSession {
	readonly #transport: McpTransport;
	readonly #target: string;
	readonly #tool: string;
	readonly #pending = new Map<number, Pending>();
	#nextId = 1;
	#closed: RoveError | undefined;
	protocolVersion: string = PROTOCOL_VERSIONS[0];

	private constructor(transport: McpTransport, target: string, tool: string) {
		this.#transport = transport;
		this.#target = target;
		this.#tool = tool;
		transport.onMessage = (message) => this.#receive(message);
		transport.onClose = (error) => this.#end(
			error ?? new RoveError(`the MCP server ${target} closed the session`, { code: "transport_failed", tool, target })
		);
	}

	/**
	 * Opens a session: `initialize`, a version check, `notifications/initialized`.
	 *
	 * @throws {RoveError} `protocol_error` for a protocol revision this client
	 * does not speak, `status` for an error response, and the transport's errors.
	 */
	static async open(
		transport: McpTransport,
		target: string,
		tool: string,
		clientVersion: string,
		signal: AbortSignal | undefined
	): Promise<McpSession> {
		const session = new McpSession(transport, target, tool);
		try {
			const result = (await session.request(
				"initialize",
				{
					protocolVersion: PROTOCOL_VERSIONS[0],
					capabilities: {},
					clientInfo: { name: "rovebeetle", version: clientVersion },
				},
				signal
			)) as { protocolVersion?: unknown };
			const version = result.protocolVersion;
			if (typeof version !== "string" || !(PROTOCOL_VERSIONS as readonly string[]).includes(version)) {
				throw new RoveError(
					`the MCP server ${target} speaks protocol ${JSON.stringify(version)}; this client speaks ${PROTOCOL_VERSIONS.join(", ")}`,
					{ code: "protocol_error", tool, target }
				);
			}
			session.protocolVersion = version;
			await transport.send({ jsonrpc: "2.0", method: "notifications/initialized" }, signal);
			return session;
		} catch (error) {
			await transport.close().catch(() => undefined);
			throw error;
		}
	}

	/** Whether the transport has ended; a closed session is replaced, never reused. */
	get closed(): boolean {
		return this.#closed !== undefined;
	}

	/**
	 * Sends a request and resolves with its result.
	 *
	 * Aborting sends `notifications/cancelled` for it and rejects with the
	 * signal's reason.
	 *
	 * @throws {RoveError} `status` for a JSON-RPC error (`status` is its code,
	 * `body` the error as JSON), and the transport's errors.
	 */
	async request(method: string, params: Record<string, unknown>, signal: AbortSignal | undefined): Promise<unknown> {
		signal?.throwIfAborted();
		if (this.#closed !== undefined) {
			throw this.#closed;
		}

		const id = this.#nextId;
		this.#nextId += 1;
		const response = new Promise<unknown>((resolve, reject) => {
			this.#pending.set(id, { resolve, reject, method });
		});
		// The transport may fail the request before anyone awaits it.
		response.catch(() => undefined);

		const onAbort = (): void => {
			const pending = this.#pending.get(id);
			if (pending === undefined) {
				return;
			}
			this.#pending.delete(id);
			pending.reject(signal?.reason);
			this.#transport
				.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: "cancelled by the caller" } }, undefined)
				.catch(() => undefined);
		};
		signal?.addEventListener("abort", onAbort, { once: true });

		try {
			await this.#transport.send({ jsonrpc: "2.0", id, method, params }, signal);
			return await response;
		} catch (error) {
			this.#pending.delete(id);
			throw error;
		} finally {
			signal?.removeEventListener("abort", onAbort);
		}
	}

	async close(): Promise<void> {
		this.#end(new RoveError(`the session with ${this.#target} was closed`, { code: "transport_failed", tool: this.#tool, target: this.#target }));
		await this.#transport.close();
	}

	#receive(message: Message): void {
		if (message.jsonrpc !== "2.0") {
			return;
		}
		const { id, method } = message;

		if (typeof method === "string") {
			// A request from the server, or a notification (no id).
			if (id === undefined || id === null) {
				return;
			}
			const reply =
				method === "ping"
					? { jsonrpc: "2.0", id, result: {} }
					: { jsonrpc: "2.0", id, error: { code: -32601, message: `this client does not support ${method}` } };
			this.#transport.send(reply, undefined).catch(() => undefined);
			return;
		}

		if (typeof id !== "number") {
			return;
		}
		const pending = this.#pending.get(id);
		if (pending === undefined) {
			return;
		}
		this.#pending.delete(id);

		if ("error" in message) {
			const error = message.error as { code?: unknown; message?: unknown } | undefined;
			const code = typeof error?.code === "number" ? error.code : undefined;
			const text = typeof error?.message === "string" ? error.message : "an error";
			pending.reject(
				new RoveError(`the MCP server ${this.#target} answered ${pending.method} with ${text}`, {
					code: "status",
					tool: this.#tool,
					target: this.#target,
					body: JSON.stringify(message.error),
					...(code === undefined ? {} : { status: code }),
				})
			);
			return;
		}
		pending.resolve(message.result);
	}

	#end(error: RoveError): void {
		if (this.#closed !== undefined) {
			return;
		}
		this.#closed = error;
		for (const pending of this.#pending.values()) {
			pending.reject(error);
		}
		this.#pending.clear();
	}
}

/**
 * A key for a server's resolved configuration, so calls to the same server
 * share a session. The auth configuration is part of it, never a token, so a
 * refreshed token keeps the session. It embeds secrets: a map key, never logged.
 */
export function serverKey(name: string, server: McpServer, auth: OAuth2Auth | undefined): string {
	return JSON.stringify([name, server, auth ?? null]);
}
