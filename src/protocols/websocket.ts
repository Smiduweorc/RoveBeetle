import { applyAuth } from "../auth.js";
import type { CallOptions, ToolCall } from "../call.js";
import { decodeData } from "../decode.js";
import { RoveError } from "../errors.js";
import { checkLimit, utf8, type ResponseLimit } from "../limit.js";
import { fillPlaceholders } from "../placeholders.js";
import { setHeaderFields } from "../request.js";
import { secureUrl, WS_SCHEMES } from "../secure.js";
import { Session, type ClientOptions } from "../session.js";
import { globalWebSocket, openConnection, type Connection, type SocketMessage, type WebSocketFactory } from "../socket.js";

/** Options for a {@link WebSocketClient}. `maxResponseBytes` bounds each message. */
export interface WebSocketClientOptions<TVariables extends string> extends ClientOptions<TVariables>, ResponseLimit {
	/**
	 * Opens connections. Defaults to the global `WebSocket`, looked up at call
	 * time, which sends handshake headers in Node and Bun and cannot in a
	 * browser.
	 */
	readonly webSocket?: WebSocketFactory;
}

/**
 * Calls `websocket` tools. Each call opens its own connection, so two calls
 * never read each other's replies, and closes it when the call is done.
 *
 * A manual's `keep_alive` and `timeout` are in each tool's doc comment and not
 * applied.
 */
export class WebSocketClient<TVariables extends string = never> {
	readonly #session: Session;
	readonly #limit: number;
	readonly #factory: WebSocketFactory;

	constructor(options: WebSocketClientOptions<TVariables>) {
		this.#session = new Session(options, options?.maxResponseBytes);
		this.#limit = checkLimit(options);
		this.#factory = options.webSocket ?? globalWebSocket;
	}

	/**
	 * Sends the call's message and resolves with the first message back.
	 *
	 * | `response_format` | Text message | Binary message |
	 * | --- | --- | --- |
	 * | `json` | parsed, `decode_failed` if it is not JSON | decoded as UTF-8, then parsed |
	 * | `text` | as received | decoded as UTF-8 |
	 * | `raw` or absent | as received | a `Uint8Array` |
	 *
	 * @throws {RoveError} `transport_failed` (connection failed or closed with
	 * an error code), `protocol_error` (closed before replying, a message over
	 * `maxResponseBytes`), `decode_failed`, and the request errors. An abort
	 * rejects with the signal's reason.
	 */
	async call<TResult>(call: ToolCall<"websocket", TResult, TVariables>, options: CallOptions = {}): Promise<TResult> {
		const { connection, url, format } = await this.#open(call, options);
		try {
			const message = await connection.next();
			if (message === undefined) {
				throw new RoveError(`${url} closed the connection without replying`, { code: "protocol_error", tool: call.tool, target: url });
			}
			return decode(message, format, call.tool, url) as TResult;
		} finally {
			connection.close();
		}
	}

	/**
	 * Sends the call's message and yields every message back, decoded as for
	 * {@link WebSocketClient.call}, until the server closes the connection.
	 * Breaking out of the loop closes it from this side. The reference
	 * implementation's `stream_end` envelope is not part of the spec and is
	 * not interpreted.
	 */
	async *stream<TMessage>(call: ToolCall<"websocket", TMessage, TVariables>, options: CallOptions = {}): AsyncGenerator<TMessage, void, undefined> {
		const { connection, url, format } = await this.#open(call, options);
		try {
			for (;;) {
				const message = await connection.next();
				if (message === undefined) {
					return;
				}
				yield decode(message, format, call.tool, url) as TMessage;
			}
		} finally {
			connection.close();
		}
	}

	async #open(
		call: ToolCall<"websocket", unknown, TVariables>,
		options: CallOptions
	): Promise<{ connection: Connection; url: string; format: "json" | "text" | "raw" }> {
		const template = this.#session.resolve(call, ["websocket"]);
		const url = secureUrl(template.url, WS_SCHEMES, call.tool);
		const headers = new Headers(template.headers);
		setHeaderFields(headers, template.headerFields, call.args, call.tool);
		if (template.auth !== undefined) {
			await applyAuth(template.auth, { headers, url }, this.#session.tokens, call.tool, options.signal);
		}

		const message =
			template.message === undefined
				? JSON.stringify(Object.fromEntries(Object.entries(call.args).filter(([name]) => !template.headerFields.includes(name))))
				: fillPlaceholders(template.message, template.messageFields, call.args, call.tool);

		const connection = await openConnection(
			this.#factory,
			url.toString(),
			{ protocols: template.protocol === undefined ? [] : [template.protocol], headers: Object.fromEntries(headers) },
			this.#limit,
			call.tool,
			options.signal
		);
		try {
			connection.send(message);
		} catch (cause) {
			connection.close();
			throw new RoveError(`could not send to ${url.toString()}`, { code: "transport_failed", tool: call.tool, target: url.toString(), cause });
		}
		return { connection, url: url.toString(), format: template.responseFormat ?? "raw" };
	}
}

function decode(message: SocketMessage, format: "json" | "text" | "raw", tool: string, target: string): unknown {
	if (format === "raw") {
		return message;
	}
	const text = typeof message === "string" ? message : utf8(message);
	return format === "text" ? text : decodeData(text, "json", tool, target);
}
