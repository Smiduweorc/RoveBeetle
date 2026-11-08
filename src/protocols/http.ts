import type { CallOptions, ToolCall } from "../call.js";
import { RoveError } from "../errors.js";
import { checkLimit, readLimited, utf8, type ResponseLimit } from "../limit.js";
import { ensureOk, mediaType, prepareRequest, send } from "../request.js";
import { Session, type ClientOptions } from "../session.js";

/** Options for an {@link HttpClient}. */
export interface HttpClientOptions<TVariables extends string> extends ClientOptions<TVariables>, ResponseLimit {}

/**
 * Calls `http` tools: one request, one response.
 *
 * Constructing one opens nothing and reads no environment. It holds this
 * client's OAuth2 tokens, so construct it once and share it.
 */
export class HttpClient<TVariables extends string = never> {
	readonly #session: Session;
	readonly #limit: number;

	constructor(options: HttpClientOptions<TVariables>) {
		// Variables first: a missing options object is reported as the
		// missing variables, the first thing the caller has to decide.
		this.#session = new Session(options, options?.maxResponseBytes);
		this.#limit = checkLimit(options);
	}

	/**
	 * Sends the call once and resolves with the response body.
	 *
	 * | Response | Resolves to |
	 * | --- | --- |
	 * | 204, 205, or an empty JSON body | `undefined` |
	 * | `application/json` or `*+json` | the parsed JSON, unchecked against the result type |
	 * | anything else | the body as text |
	 *
	 * Redirects within the origin are followed; one to another origin is
	 * refused, so credentials stay where the template sends them.
	 *
	 * @throws {RoveError} `status` for a non-2xx response, `decode_failed` for
	 * malformed JSON, `protocol_error` for a body over `maxResponseBytes`, and
	 * the request errors (`transport_failed`,
	 * `insecure_url`, `unsupported_value`, `cross_origin_redirect`,
	 * `token_request_failed`, `variable_missing`). An abort rejects with the
	 * signal's reason.
	 */
	async call<TResult>(call: ToolCall<"http", TResult, TVariables>, options: CallOptions = {}): Promise<TResult> {
		const template = this.#session.resolve(call, ["http"]);
		const prepared = await prepareRequest(template, call.args, this.#session.tokens, call.tool, options.signal);
		const response = await send(prepared, this.#session.transport, "same-origin", call.tool, options.signal);

		await ensureOk(response, prepared, call.tool, this.#limit);

		if (response.status === 204 || response.status === 205) {
			await response.body?.cancel();
			return undefined as TResult;
		}

		const target = prepared.url.toString();
		const text = utf8(await readLimited(response, this.#limit, call.tool, target, options.signal));
		const media = mediaType(response);

		if (media !== "application/json" && !media.endsWith("+json")) {
			return text as TResult;
		}
		if (text.length === 0) {
			return undefined as TResult;
		}
		try {
			return JSON.parse(text) as TResult;
		} catch (cause) {
			throw new RoveError(`${target} answered ${media} that is not valid JSON`, {
				code: "decode_failed",
				tool: call.tool,
				target,
				status: response.status,
				headers: response.headers,
				body: text,
				cause,
			});
		}
	}
}
