import type { CallOptions, ToolCall } from "../call.js";
import { decodeData } from "../decode.js";
import { RoveError } from "../errors.js";
import { checkLimit, type ResponseLimit } from "../limit.js";
import { ensureOk, mediaType, prepareRequest, send } from "../request.js";
import { Session, type ClientOptions } from "../session.js";
import { readEvents } from "../sse.js";

/** Options for an {@link SseClient}. `maxResponseBytes` bounds each event. */
export interface SseClientOptions<TVariables extends string> extends ClientOptions<TVariables>, ResponseLimit {}

/**
 * Calls `sse` tools: one request, then the events the server sends until it
 * closes the stream.
 *
 * It never reconnects. A manual's `reconnect` and `retry_timeout` are in each
 * tool's doc comment; reconnecting is a retry, which belongs to the caller.
 */
export class SseClient<TVariables extends string = never> {
	readonly #session: Session;
	readonly #limit: number;

	constructor(options: SseClientOptions<TVariables>) {
		this.#session = new Session(options, options?.maxResponseBytes);
		this.#limit = checkLimit(options);
	}

	/**
	 * Opens the stream and yields each event's data, decoded as the template
	 * says. Nothing is sent until the first value is asked for. Breaking out
	 * of the loop, or aborting the signal, closes the connection.
	 *
	 * The request is a `GET`, or a `POST` when the call has a body (sent as
	 * JSON unless the template's headers name another content type), with
	 * `Accept: text/event-stream`. Redirects are refused: point the template
	 * at the final URL.
	 *
	 * Only events of the template's `eventType` are yielded, `message` when it
	 * names none. Events without `data` are skipped.
	 *
	 * @throws {RoveError} `status`, `protocol_error` (wrong content type, an
	 * event over `maxResponseBytes`), `decode_failed`, `redirect_not_followed`,
	 * and the request errors. An abort rejects with the signal's reason.
	 */
	async *stream<TEvent>(call: ToolCall<"sse", TEvent, TVariables>, options: CallOptions = {}): AsyncGenerator<TEvent, void, undefined> {
		const template = this.#session.resolve(call, ["sse"]);
		const hasBody = template.bodyField !== undefined && call.args[template.bodyField] !== undefined;
		const prepared = await prepareRequest(
			{
				...template,
				method: hasBody ? "POST" : "GET",
				contentType: "application/json",
				headers: { accept: "text/event-stream", ...template.headers },
			},
			call.args,
			this.#session.tokens,
			call.tool,
			options.signal
		);
		const target = prepared.url.toString();
		const response = await send(prepared, this.#session.transport, "never", call.tool, options.signal);

		await ensureOk(response, prepared, call.tool, this.#limit);

		if (mediaType(response) !== "text/event-stream" || response.body === null) {
			await response.body?.cancel();
			throw new RoveError(
				`${target} answered ${JSON.stringify(response.headers.get("content-type") ?? "")} instead of text/event-stream`,
				{ code: "protocol_error", tool: call.tool, target, status: response.status, headers: response.headers }
			);
		}

		const wanted = template.eventType ?? "message";
		for await (const event of readEvents(response.body, this.#limit, call.tool, target, options.signal)) {
			if (event.type === wanted) {
				yield decodeData(event.data, template.dataFormat, call.tool, target) as TEvent;
			}
		}
	}
}
