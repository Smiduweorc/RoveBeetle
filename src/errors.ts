/**
 * Every way a call can fail that this package reports itself.
 *
 * | Code | Raised when |
 * | --- | --- |
 * | `variable_missing` | A template needs a variable the client was not given, or was given as an empty string |
 * | `insecure_url` | A URL is not `https:` (or `wss:`) and its host is not loopback |
 * | `unsupported_value` | An argument cannot be put where the template sends it, such as an object in a query string |
 * | `cross_origin_redirect` | A call carrying credentials was redirected to another origin |
 * | `redirect_not_followed` | The runtime hid a redirect (a browser's opaque redirect) so it could not be checked |
 * | `token_request_failed` | The OAuth2 token endpoint failed, answered non-2xx, or sent no `access_token` |
 * | `transport_failed` | No response arrived: DNS, refused or reset connection, TLS, a closed socket |
 * | `status` | The provider answered with a failure status (HTTP non-2xx, a GraphQL `errors` array, a non-zero exit) |
 * | `decode_failed` | A response arrived but could not be read the way the template says it is encoded |
 * | `protocol_error` | The provider broke its own protocol: a malformed frame, an MCP error result, a response over the size limit |
 *
 * The caller's own errors are never wrapped: an aborted call rejects with the
 * signal's `reason` exactly as the caller gave it.
 */
export type RoveErrorCode =
	| "variable_missing"
	| "insecure_url"
	| "unsupported_value"
	| "cross_origin_redirect"
	| "redirect_not_followed"
	| "token_request_failed"
	| "transport_failed"
	| "status"
	| "decode_failed"
	| "protocol_error";

/** What a {@link RoveError} carries besides its code. Fields that do not apply are absent. */
export interface RoveErrorInit {
	readonly code: RoveErrorCode;

	/** The tool being called, as the manual names it. Absent for refusals before a call. */
	readonly tool?: string;

	/** Where the call went: a URL, `host:port`, a command, an MCP server name. */
	readonly target?: string;

	/** HTTP status, process exit code, or `undefined` where the protocol has none. */
	readonly status?: number;

	/** Response headers, for HTTP-based protocols. */
	readonly headers?: Headers;

	/** The raw response body, stderr, or error payload, as text. */
	readonly body?: string;

	/** What failed underneath, when something did. */
	readonly cause?: unknown;
}

/**
 * The one error class this package throws.
 *
 * Branch on `code`, never on `message`: the message is for a person reading a
 * log and may change in any release.
 */
export class RoveError extends Error {
	override readonly name = "RoveError";

	readonly code: RoveErrorCode;
	readonly tool: string | undefined;
	readonly target: string | undefined;
	readonly status: number | undefined;
	readonly headers: Headers | undefined;
	readonly body: string | undefined;

	constructor(message: string, init: RoveErrorInit) {
		super(`rovebeetle: ${message}`, init.cause === undefined ? undefined : { cause: init.cause });
		this.code = init.code;
		this.tool = init.tool;
		this.target = init.target;
		this.status = init.status;
		this.headers = init.headers;
		this.body = init.body;
	}
}
