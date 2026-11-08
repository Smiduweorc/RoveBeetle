import { applyAuth } from "../auth.js";
import type { CallOptions, GraphqlTemplate, ToolCall } from "../call.js";
import { RoveError } from "../errors.js";
import { checkLimit, readLimited, utf8, type ResponseLimit } from "../limit.js";
import { ensureOk, prepareRequest, send, setHeaderFields } from "../request.js";
import { secureUrl, WS_SCHEMES } from "../secure.js";
import { Session, type ClientOptions } from "../session.js";
import { globalWebSocket, openConnection, type WebSocketFactory } from "../socket.js";

/** Options for a {@link GraphqlClient}. `maxResponseBytes` bounds a response or one subscription message. */
export interface GraphqlClientOptions<TVariables extends string> extends ClientOptions<TVariables>, ResponseLimit {
	/** Opens subscription connections. Defaults to the global `WebSocket`, looked up at call time. */
	readonly webSocket?: WebSocketFactory;
}

/** The subprotocol of the `graphql-ws` library's protocol, which subscriptions speak. */
const SUBPROTOCOL = "graphql-transport-ws";

/** The argument name the request body travels under; no tool argument can collide with it. */
const BODY = "\u0000graphql request";

/**
 * Calls `graphql` tools. Queries and mutations are one HTTP `POST`
 * (GraphQL over HTTP); subscriptions use the `graphql-transport-ws` protocol
 * over a WebSocket at the same URL.
 *
 * Arguments other than header fields are the operation's variables. The
 * query document comes from the manual or, for a discovered schema, from the
 * generator; it is never built at call time.
 */
export class GraphqlClient<TVariables extends string = never> {
	readonly #session: Session;
	readonly #limit: number;
	readonly #factory: WebSocketFactory;

	constructor(options: GraphqlClientOptions<TVariables>) {
		this.#session = new Session(options, options?.maxResponseBytes);
		this.#limit = checkLimit(options);
		this.#factory = options.webSocket ?? globalWebSocket;
	}

	/**
	 * Runs a query or mutation and resolves with the response's `data`.
	 *
	 * A response with a non-empty `errors` array fails, even when it also
	 * carries partial `data`: the tool did not do all of what was asked.
	 *
	 * @throws {RoveError} `status` (non-2xx, or GraphQL `errors`, with the
	 * response as `body`), `decode_failed`, `unsupported_value` for a
	 * subscription, and the request errors. An abort rejects with the
	 * signal's reason.
	 */
	async call<TResult>(call: ToolCall<"graphql", TResult, TVariables>, options: CallOptions = {}): Promise<TResult> {
		const template = this.#session.resolve(call, ["graphql"]);
		if (template.operationType === "subscription") {
			throw new RoveError(`tool ${call.tool} is a subscription; use stream()`, { code: "unsupported_value", tool: call.tool });
		}

		const body = { query: template.query, variables: variablesOf(template, call.args), ...operationName(template) };
		const prepared = await prepareRequest(
			{
				url: template.url,
				pathFields: [],
				method: "POST",
				headers: {
					accept: "application/graphql-response+json, application/json;q=0.9",
					"content-type": "application/json",
					...template.headers,
				},
				headerFields: template.headerFields,
				bodyField: BODY,
				contentType: "application/json",
				...(template.auth === undefined ? {} : { auth: template.auth }),
			},
			{ ...headerArgs(template, call.args), [BODY]: body },
			this.#session.tokens,
			call.tool,
			options.signal
		);
		const target = prepared.url.toString();
		const response = await send(prepared, this.#session.transport, "same-origin", call.tool, options.signal);

		await ensureOk(response, prepared, call.tool, this.#limit);

		const text = utf8(await readLimited(response, this.#limit, call.tool, target, options.signal));
		return payloadData(parse(text, call.tool, target), text, call.tool, target, response.status) as TResult;
	}

	/**
	 * Runs a subscription and yields each result's `data` until the server
	 * completes it. Breaking out of the loop sends `complete` and closes the
	 * connection.
	 *
	 * @throws {RoveError} `status` for an `error` message or a result with
	 * `errors`, `protocol_error` for a message outside the protocol,
	 * `unsupported_value` for a query or mutation, and the connection errors
	 * of the `websocket` client. An abort rejects with the signal's reason.
	 */
	async *stream<TEvent>(call: ToolCall<"graphql", TEvent, TVariables>, options: CallOptions = {}): AsyncGenerator<TEvent, void, undefined> {
		const template = this.#session.resolve(call, ["graphql"]);
		if (template.operationType !== "subscription") {
			throw new RoveError(`tool ${call.tool} is a ${template.operationType}; use call()`, { code: "unsupported_value", tool: call.tool });
		}

		const httpUrl = new URL(template.url);
		httpUrl.protocol = httpUrl.protocol === "https:" ? "wss:" : httpUrl.protocol === "http:" ? "ws:" : httpUrl.protocol;
		const url = secureUrl(httpUrl.toString(), WS_SCHEMES, call.tool);
		const target = url.toString();

		const headers = new Headers(template.headers);
		setHeaderFields(headers, template.headerFields, call.args, call.tool);
		if (template.auth !== undefined) {
			await applyAuth(template.auth, { headers, url }, this.#session.tokens, call.tool, options.signal);
		}

		const connection = await openConnection(
			this.#factory,
			url.toString(),
			{ protocols: [SUBPROTOCOL], headers: Object.fromEntries(headers) },
			this.#limit,
			call.tool,
			options.signal
		);

		const id = "1";
		let completed = false;
		const next = async (): Promise<Record<string, unknown> | undefined> => {
			for (;;) {
				const raw = await connection.next();
				if (raw === undefined) {
					return undefined;
				}
				const message = parse(typeof raw === "string" ? raw : utf8(raw), call.tool, target);
				if (typeof message !== "object" || message === null || typeof (message as { type?: unknown }).type !== "string") {
					throw new RoveError(`${target} sent a message with no type`, { code: "protocol_error", tool: call.tool, target });
				}
				const typed = message as Record<string, unknown>;
				if (typed.type === "ping") {
					connection.send(JSON.stringify({ type: "pong" }));
					continue;
				}
				if (typed.type === "pong") {
					continue;
				}
				return typed;
			}
		};

		try {
			connection.send(JSON.stringify({ type: "connection_init" }));
			const ack = await next();
			if (ack?.type !== "connection_ack") {
				throw new RoveError(`${target} did not acknowledge the connection`, { code: "protocol_error", tool: call.tool, target });
			}

			connection.send(
				JSON.stringify({
					id,
					type: "subscribe",
					payload: { query: template.query, variables: variablesOf(template, call.args), ...operationName(template) },
				})
			);

			for (;;) {
				const message = await next();
				if (message === undefined) {
					throw new RoveError(`${target} closed the subscription without completing it`, {
						code: "protocol_error",
						tool: call.tool,
						target,
					});
				}
				if (message.id !== id) {
					throw new RoveError(`${target} sent a ${String(message.type)} message for another operation`, {
						code: "protocol_error",
						tool: call.tool,
						target,
					});
				}
				switch (message.type) {
				case "next":
					yield payloadData(message.payload, JSON.stringify(message.payload), call.tool, target, undefined) as TEvent;
					break;
				case "error":
					completed = true;
					throw new RoveError(`subscription ${call.tool} failed`, {
						code: "status",
						tool: call.tool,
						target,
						body: JSON.stringify(message.payload),
					});
				case "complete":
					completed = true;
					return;
				default:
					throw new RoveError(`${target} sent an unexpected ${String(message.type)} message`, {
						code: "protocol_error",
						tool: call.tool,
						target,
					});
				}
			}
		} finally {
			if (!completed) {
				try {
					connection.send(JSON.stringify({ id, type: "complete" }));
				} catch {
					// The connection is already gone; closing it below is all that is left.
				}
			}
			connection.close();
		}
	}
}

/** The arguments sent as headers. */
function headerArgs(template: GraphqlTemplate, args: Readonly<Record<string, unknown>>): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(args).filter(([name, value]) => template.headerFields.includes(name) && value !== undefined && value !== null)
	);
}

/** Every argument that is not a header, as GraphQL variables. Absent ones are left out. */
function variablesOf(template: GraphqlTemplate, args: Readonly<Record<string, unknown>>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(args).filter(([name, value]) => !template.headerFields.includes(name) && value !== undefined));
}

function operationName(template: GraphqlTemplate): { operationName?: string } {
	return template.operationName === undefined ? {} : { operationName: template.operationName };
}

function parse(text: string, tool: string, target: string): unknown {
	try {
		return JSON.parse(text) as unknown;
	} catch (cause) {
		throw new RoveError(`${target} answered with a body that is not JSON`, { code: "decode_failed", tool, target, body: text, cause });
	}
}

/**
 * The `data` of a GraphQL result, or a `status` error when the result
 * carries `errors`.
 */
function payloadData(payload: unknown, raw: string, tool: string, target: string, status: number | undefined): unknown {
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
		throw new RoveError(`${target} answered with a GraphQL result that is not an object`, { code: "decode_failed", tool, target, body: raw });
	}
	const { data, errors } = payload as { data?: unknown; errors?: unknown };
	if (Array.isArray(errors) && errors.length > 0) {
		const first = errors[0] as { message?: unknown } | undefined;
		const detail = typeof first?.message === "string" ? `: ${first.message}` : "";
		throw new RoveError(`${tool} returned GraphQL errors${detail}`, { code: "status", tool, target, body: raw, ...(status === undefined ? {} : { status }) });
	}
	if (!("data" in payload)) {
		throw new RoveError(`${target} answered with a GraphQL result that has neither data nor errors`, {
			code: "decode_failed",
			tool,
			target,
			body: raw,
		});
	}
	return data;
}
