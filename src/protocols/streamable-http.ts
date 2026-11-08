import type { CallOptions, ToolCall } from "../call.js";
import { decodeData } from "../decode.js";
import { checkLimit, nextChunk, readLimited, utf8, type ResponseLimit } from "../limit.js";
import { readLines } from "../lines.js";
import { ensureOk, mediaType, prepareRequest, send } from "../request.js";
import { Session, type ClientOptions } from "../session.js";

/**
 * Options for a {@link StreamableHttpClient}. `maxResponseBytes` bounds one
 * NDJSON line or a whole JSON body; byte chunks are passed on as they arrive.
 */
export interface StreamableHttpClientOptions<TVariables extends string>
	extends ClientOptions<TVariables>,
		ResponseLimit {}

/**
 * Calls `streamable_http` tools: one request, and a response read as it
 * arrives.
 *
 * A manual's `timeout` and `chunk_size` are in each tool's doc comment and
 * not applied: pass a signal for a timeout, and chunks are as large as the
 * network delivers them.
 */
export class StreamableHttpClient<TVariables extends string = never> {
	readonly #session: Session;
	readonly #limit: number;

	constructor(options: StreamableHttpClientOptions<TVariables>) {
		this.#session = new Session(options, options?.maxResponseBytes);
		this.#limit = checkLimit(options);
	}

	/**
	 * Sends the call and yields the response as it arrives, by content type:
	 *
	 * | Response content type | Yields |
	 * | --- | --- |
	 * | `application/x-ndjson` | each non-blank line, parsed as JSON |
	 * | `application/json`, `*+json` | the whole body, parsed, once |
	 * | anything else | each `Uint8Array` chunk as it arrives |
	 *
	 * Nothing is sent until the first value is asked for. Breaking out of the
	 * loop, or aborting the signal, closes the connection. Redirects are
	 * refused.
	 *
	 * @throws {RoveError} `status`, `decode_failed` for a line or body that is
	 * not JSON, `protocol_error` over `maxResponseBytes`,
	 * `redirect_not_followed`, and the request errors. An abort rejects with
	 * the signal's reason.
	 */
	async *stream<TChunk>(
		call: ToolCall<"streamable_http", TChunk, TVariables>,
		options: CallOptions = {}
	): AsyncGenerator<TChunk | Uint8Array, void, undefined> {
		const template = this.#session.resolve(call, ["streamable_http"]);
		const prepared = await prepareRequest(template, call.args, this.#session.tokens, call.tool, options.signal);
		const target = prepared.url.toString();
		const response = await send(prepared, this.#session.transport, "never", call.tool, options.signal);

		await ensureOk(response, prepared, call.tool, this.#limit);

		const media = mediaType(response);
		if (response.body === null) {
			return;
		}

		if (media === "application/x-ndjson") {
			for await (const line of readLines(response.body, this.#limit, call.tool, target, options.signal)) {
				yield decodeData(line, "json", call.tool, target) as TChunk;
			}
			return;
		}

		if (media === "application/json" || media.endsWith("+json")) {
			const text = utf8(await readLimited(response, this.#limit, call.tool, target, options.signal));
			if (text.length > 0) {
				yield decodeData(text, "json", call.tool, target) as TChunk;
			}
			return;
		}

		const reader = response.body.getReader();
		try {
			for (;;) {
				const chunk = await nextChunk(reader, call.tool, target, options.signal);
				if (chunk.done) {
					return;
				}
				yield chunk.value;
			}
		} finally {
			await reader.cancel().catch(() => undefined);
		}
	}
}
