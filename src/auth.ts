import type { Auth, OAuth2Auth } from "./call.js";
import { RoveError } from "./errors.js";
import { readLimited, utf8 } from "./limit.js";
import { HTTP_SCHEMES, secureUrl } from "./secure.js";

/**
 * Sends one `Request` and resolves with the response. `fetch` satisfies it.
 *
 * It is the place for what this package leaves out (retries, rate limits,
 * logging): wrap one transport in another. Token requests go through it too,
 * so a wrapper sees every request the client makes.
 */
export type Transport = (request: Request) => Promise<Response>;

/** The global `fetch`, looked up at call time rather than at import time. */
export const globalTransport: Transport = (request) => fetch(request);

/** Where one request's credentials go. Filled by {@link applyAuth}. */
export interface Credentials {
	readonly headers: Headers;
	readonly url: URL;
}

/**
 * Puts `auth` onto a request that is being built.
 *
 * | Auth | Goes to |
 * | --- | --- |
 * | `api_key`, `header` | the `name` header, replacing any value the template set |
 * | `api_key`, `query` | the `name` query parameter, replacing any the arguments set |
 * | `api_key`, `cookie` | appended to `Cookie` as `name=key` |
 * | `basic` | `Authorization: Basic`, UTF-8 (RFC 7617) |
 * | `oauth2` | `Authorization: Bearer` with a token from `tokens` |
 */
export async function applyAuth(
	auth: Auth,
	request: Credentials,
	tokens: TokenSource,
	tool: string,
	signal: AbortSignal | undefined
): Promise<void> {
	switch (auth.type) {
	case "api_key":
		if (auth.location === "header") {
			request.headers.set(auth.name, auth.key);
		} else if (auth.location === "query") {
			request.url.searchParams.set(auth.name, auth.key);
		} else {
			request.headers.set("cookie", appendCookie(request.headers.get("cookie"), auth.name, auth.key, tool));
		}
		return;
	case "basic":
		request.headers.set("authorization", `Basic ${base64(`${auth.username}:${auth.password}`)}`);
		return;
	case "oauth2":
		request.headers.set("authorization", `Bearer ${await tokens.token(auth, tool, signal)}`);
		return;
	}
}

/**
 * RFC 6265 `cookie-octet`: printable ASCII except space, `"`, `,`, `;` and
 * `\`. A key outside it would split into a second cookie or break the header.
 */
const COOKIE_OCTETS = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/u;

function appendCookie(existing: string | null, name: string, value: string, tool: string): string {
	if (!COOKIE_OCTETS.test(value)) {
		throw new RoveError(`the api_key for cookie ${name} contains characters a cookie cannot carry`, {
			code: "unsupported_value",
			tool,
		});
	}
	const pair = `${name}=${value}`;
	return existing === null || existing.length === 0 ? pair : `${existing}; ${pair}`;
}

/** Base64 of the UTF-8 bytes of `text`, without `node:buffer`. */
export function base64(text: string): string {
	return base64Bytes(new TextEncoder().encode(text));
}

/** Base64 of `bytes`, without `node:buffer`. */
export function base64Bytes(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary);
}

/** Options for a {@link TokenSource}. */
export interface TokenSourceOptions {
	readonly transport: Transport;

	/** Milliseconds since the epoch. Tests pass a virtual clock. */
	readonly now: () => number;

	/** The most bytes a token response may hold: the owning client's limit. */
	readonly maxResponseBytes: number;
}

interface FetchedToken {
	readonly token: string;
	/** `undefined`: the response had no usable `expires_in`, so it is never reused. */
	readonly expiresAt: number | undefined;
}

interface CachedToken extends FetchedToken {
	readonly expiresAt: number;
}

interface PendingToken {
	readonly promise: Promise<FetchedToken>;
	readonly controller: AbortController;
	waiters: number;
}

/**
 * Fetches OAuth2 client credentials tokens and keeps each one until it
 * expires. One per client instance; two clients never share a token.
 *
 * | State for an auth block | `token()` does |
 * | --- | --- |
 * | No token | Starts one token request |
 * | A request is pending | Waits for that request instead of starting another |
 * | Cached, `now` before expiry | Returns it with no request |
 * | Cached, `now` at or after expiry | Drops it and starts a request |
 * | Last request failed | Nothing was cached; starts a request |
 *
 * Expiry is `expires_in` seconds after the token request started, which
 * covers the request's own latency without a margin constant. A response
 * without `expires_in` serves the calls that were waiting for it and is not
 * reused. A pending request is aborted when every caller waiting on it has
 * aborted.
 *
 * The client authenticates with HTTP Basic only (RFC 6749 section 2.3.1:
 * servers MUST support it), never also in the body, and a token request does
 * not follow redirects, so the client secret goes to `tokenUrl` and nowhere
 * else.
 */
export class TokenSource {
	readonly #transport: Transport;
	readonly #now: () => number;
	readonly #limit: number;
	readonly #cache = new Map<string, CachedToken>();
	readonly #pending = new Map<string, PendingToken>();

	constructor(options: TokenSourceOptions) {
		this.#transport = options.transport;
		this.#now = options.now;
		this.#limit = options.maxResponseBytes;
	}

	/**
	 * A bearer token for `auth`.
	 *
	 * @throws {RoveError} `token_request_failed` or `insecure_url`.
	 */
	async token(auth: OAuth2Auth, tool: string, signal: AbortSignal | undefined): Promise<string> {
		signal?.throwIfAborted();

		// Everything that changes which token comes back, so two blocks that
		// share a client id but differ in secret, issuer or scope never get
		// each other's token. It embeds the secret: a map key, never logged.
		const key = JSON.stringify([auth.tokenUrl, auth.clientId, auth.clientSecret, auth.scope ?? ""]);

		const cached = this.#cache.get(key);
		if (cached !== undefined) {
			if (this.#now() < cached.expiresAt) {
				return cached.token;
			}
			this.#cache.delete(key);
		}

		let pending = this.#pending.get(key);
		if (pending === undefined) {
			const controller = new AbortController();
			const promise = this.#request(auth, tool, controller.signal).then(
				(token) => {
					this.#pending.delete(key);
					if (token.expiresAt !== undefined) {
						this.#cache.set(key, { token: token.token, expiresAt: token.expiresAt });
					}
					return token;
				},
				(error: unknown) => {
					this.#pending.delete(key);
					throw error;
				}
			);
			pending = { promise, controller, waiters: 0 };
			this.#pending.set(key, pending);
		}

		return (await this.#wait(pending, signal)).token;
	}

	/** Waits for a shared request on behalf of one caller and its own signal. */
	async #wait(pending: PendingToken, signal: AbortSignal | undefined): Promise<FetchedToken> {
		if (signal === undefined) {
			pending.waiters += 1;
			try {
				return await pending.promise;
			} finally {
				pending.waiters -= 1;
			}
		}

		pending.waiters += 1;
		let onAbort: (() => void) | undefined;
		const aborted = new Promise<never>((_resolve, reject) => {
			onAbort = (): void => {
				reject(signal.reason);
			};
			signal.addEventListener("abort", onAbort, { once: true });
		});

		try {
			return await Promise.race([pending.promise, aborted]);
		} finally {
			if (onAbort !== undefined) {
				signal.removeEventListener("abort", onAbort);
			}
			pending.waiters -= 1;
			if (pending.waiters === 0 && signal.aborted) {
				pending.controller.abort(signal.reason);
			}
			// The shared promise may still reject after every waiter left;
			// nobody is listening for it any more.
			pending.promise.catch(() => undefined);
		}
	}

	async #request(auth: OAuth2Auth, tool: string, signal: AbortSignal): Promise<FetchedToken> {
		const url = secureUrl(auth.tokenUrl, HTTP_SCHEMES, tool);
		const body = new URLSearchParams({ grant_type: "client_credentials" });
		if (auth.scope !== undefined && auth.scope.length > 0) {
			body.set("scope", auth.scope);
		}

		// RFC 6749 section 2.3.1: the id and secret are form-encoded before
		// they are joined, so a `:` in either survives.
		const credentials = `${formEncode(auth.clientId)}:${formEncode(auth.clientSecret)}`;
		const request = new Request(url, {
			method: "POST",
			headers: {
				accept: "application/json",
				authorization: `Basic ${base64(credentials)}`,
				"content-type": "application/x-www-form-urlencoded",
			},
			body,
			redirect: "manual",
			signal,
		});

		const startedAt = this.#now();
		let response: Response;
		try {
			response = await this.#transport(request);
		} catch (cause) {
			if (signal.aborted) {
				throw signal.reason;
			}
			throw new RoveError(`token request to ${url.origin} failed before a response arrived`, {
				code: "token_request_failed",
				tool,
				target: url.toString(),
				cause,
			});
		}

		let text: string | undefined;
		let unread: unknown;
		try {
			text = utf8(await readLimited(response, this.#limit, tool, url.toString(), signal));
		} catch (cause) {
			if (signal.aborted) {
				throw signal.reason;
			}
			unread = cause;
		}
		const failed = (reason: string, cause?: unknown): RoveError =>
			new RoveError(`token request to ${url.origin} ${reason}`, {
				code: "token_request_failed",
				tool,
				target: url.toString(),
				status: response.status,
				headers: response.headers,
				body: text,
				cause,
			});

		if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
			throw failed(`was redirected (HTTP ${response.status}); token requests do not follow redirects`);
		}
		if (!response.ok) {
			throw failed(`failed with HTTP ${response.status}`, unread);
		}
		if (unread !== undefined) {
			throw failed("answered with a body that could not be read", unread);
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(text ?? "");
		} catch (cause) {
			throw failed("answered with a body that is not JSON", cause);
		}
		if (typeof parsed !== "object" || parsed === null) {
			throw failed("answered with JSON that is not an object");
		}

		const { access_token: token, token_type: tokenType, expires_in: expiresIn } = parsed as Record<string, unknown>;

		if (typeof token !== "string" || token.length === 0) {
			throw failed("answered without an access_token");
		}
		// RFC 6749 section 7.1: a client must not use a token whose type it
		// does not understand. Only bearer tokens are sent as `Bearer`.
		if (typeof tokenType !== "string" || tokenType.toLowerCase() !== "bearer") {
			throw failed(`answered with token_type ${JSON.stringify(tokenType)}; only bearer tokens are supported`);
		}

		const seconds = lifetime(expiresIn);
		return { token, expiresAt: seconds === undefined ? undefined : startedAt + seconds * 1000 };
	}
}

/**
 * `expires_in` as a positive number of seconds. RFC 6749 types it as a number;
 * some servers send a string of digits, which is accepted. Anything else, or
 * zero, means the token is not reused.
 */
function lifetime(value: unknown): number | undefined {
	const seconds =
		typeof value === "number" ? value : typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : NaN;
	return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

/** `application/x-www-form-urlencoded` for one value, as RFC 6749 appendix B defines it. */
function formEncode(value: string): string {
	return new URLSearchParams({ v: value }).toString().slice(2);
}
