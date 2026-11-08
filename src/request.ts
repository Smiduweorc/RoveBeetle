import { applyAuth, type TokenSource, type Transport } from "./auth.js";
import type { Auth } from "./call.js";
import { RoveError } from "./errors.js";
import { readForError } from "./limit.js";
import { HTTP_SCHEMES, secureUrl } from "./secure.js";

// Building and sending a request for every HTTP-based protocol. The argument
// split is the spec's: `header_fields` become headers, `body_field` becomes the
// body, `{name}` placeholders in the URL path are filled, and every remaining
// argument goes on the query string.

/** The parts of a resolved template a request is built from. */
export interface RequestShape {
	readonly url: string;
	readonly method: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly pathFields: readonly string[];
	readonly headerFields: readonly string[];
	readonly bodyField?: string;
	readonly contentType?: string;
	readonly auth?: Auth;
}

/** A request ready to send, kept as parts so a redirect can rebuild it. */
export interface PreparedRequest {
	readonly url: URL;
	readonly method: string;
	readonly headers: Headers;
	readonly body: string | URLSearchParams | undefined;
	/** An api key sent in the query string, put back on every redirect hop. */
	readonly queryCredential?: readonly [name: string, value: string];
}

/** CR, LF and NUL end a header line; a value carrying one could add another header. */
const HEADER_BREAK = /[\r\n\0]/u;

/**
 * Splits `args` across the request as the template says and applies auth.
 *
 * @throws {RoveError} `unsupported_value`, `insecure_url`, `token_request_failed`.
 */
export async function prepareRequest(
	shape: RequestShape,
	args: Readonly<Record<string, unknown>>,
	tokens: TokenSource,
	tool: string,
	signal: AbortSignal | undefined
): Promise<PreparedRequest> {
	const remaining = new Map(Object.entries(args).filter(([, value]) => value !== undefined));
	const headers = new Headers();

	for (const [name, value] of Object.entries(shape.headers)) {
		headers.set(name, headerValue(name, value, tool));
	}
	setHeaderFields(headers, shape.headerFields, args, tool);
	for (const name of shape.headerFields) {
		remaining.delete(name);
	}

	let body: string | URLSearchParams | undefined;
	if (shape.bodyField !== undefined && remaining.has(shape.bodyField)) {
		const value = remaining.get(shape.bodyField);
		remaining.delete(shape.bodyField);
		if (!headers.has("content-type") && shape.contentType !== undefined) {
			headers.set("content-type", shape.contentType);
		}
		body = encodeBody(value, headers.get("content-type") ?? "", shape.bodyField, tool);
	}

	const url = secureUrl(fillPath(shape.url, shape.pathFields, remaining, tool), HTTP_SCHEMES, tool);

	for (const [name, value] of remaining) {
		appendQuery(url.searchParams, name, value, tool);
	}

	if (shape.auth !== undefined) {
		await applyAuth(shape.auth, { headers, url }, tokens, tool, signal);
	}

	const queryCredential: readonly [string, string] | undefined =
		shape.auth?.type === "api_key" && shape.auth.location === "query" ? [shape.auth.name, shape.auth.key] : undefined;

	return { url, method: shape.method, headers, body, ...(queryCredential === undefined ? {} : { queryCredential }) };
}

/**
 * Fills the `{name}` placeholders the generator found. It only accepts them in
 * the path, so an argument can never move the request to another host, and
 * only those names are replaced, so a brace inside a variable's value is text.
 */
function fillPath(
	template: string,
	names: readonly string[],
	remaining: Map<string, unknown>,
	tool: string
): string {
	let url = template;
	for (const name of names) {
		const value = remaining.get(name);
		remaining.delete(name);
		if (value === undefined || value === null) {
			throw new RoveError(`path parameter ${name} is required`, { code: "unsupported_value", tool });
		}
		url = url.split(`{${name}}`).join(encodeURIComponent(scalar(name, value, "the URL path", tool)));
	}
	return url;
}

function appendQuery(params: URLSearchParams, name: string, value: unknown, tool: string): void {
	if (value === null) {
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) {
			params.append(name, scalar(name, item, "a query string", tool));
		}
		return;
	}
	params.append(name, scalar(name, value, "a query string", tool));
}

/** A string, number or boolean as text; anything else cannot go where it was sent. */
function scalar(name: string, value: unknown, where: string, tool: string): string {
	if (typeof value === "string") {
		return value;
	}
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	throw new RoveError(`argument ${name} is ${describe(value)}, which cannot be put in ${where}`, {
		code: "unsupported_value",
		tool,
	});
}

/**
 * Puts the arguments named in `fields` on `headers`, under their own names.
 * Absent and `null` arguments send nothing.
 *
 * @throws {RoveError} `unsupported_value` for a value that is not a scalar,
 * or one with a line break or NUL, which could add a header of its own.
 */
export function setHeaderFields(headers: Headers, fields: readonly string[], args: Readonly<Record<string, unknown>>, tool: string): void {
	for (const name of fields) {
		const value = args[name];
		if (value !== undefined && value !== null) {
			headers.set(name, headerValue(name, scalar(name, value, "a header", tool), tool));
		}
	}
}

function headerValue(name: string, value: string, tool: string): string {
	if (HEADER_BREAK.test(value)) {
		throw new RoveError(`header ${name} contains a line break or NUL`, { code: "unsupported_value", tool });
	}
	return value;
}

/**
 * The body for a content type.
 *
 * | Content type | Value | Sent as |
 * | --- | --- | --- |
 * | `application/json`, `*+json` | anything JSON can hold | `JSON.stringify` |
 * | `application/x-www-form-urlencoded` | an object of scalars or scalar arrays | form fields |
 * | anything else | a string | as written |
 */
function encodeBody(value: unknown, contentType: string, field: string, tool: string): string | URLSearchParams {
	const media = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";

	if (media === "application/json" || media.endsWith("+json")) {
		return JSON.stringify(value);
	}
	if (media === "application/x-www-form-urlencoded" && typeof value === "object" && value !== null && !Array.isArray(value)) {
		const form = new URLSearchParams();
		for (const [name, item] of Object.entries(value)) {
			if (item !== undefined) {
				appendQuery(form, name, item, tool);
			}
		}
		return form;
	}
	if (typeof value === "string") {
		return value;
	}
	throw new RoveError(
		`argument ${field} is ${describe(value)}, which cannot be sent as ${media.length > 0 ? media : "a body with no content type"}`,
		{ code: "unsupported_value", tool }
	);
}

function describe(value: unknown): string {
	if (value === null) {
		return "null";
	}
	return Array.isArray(value) ? "an array" : `a${typeof value === "object" ? "n" : ""} ${typeof value}`;
}

/** How a request treats redirects. */
export type RedirectRule = "same-origin" | "never";

/** The redirect statuses Fetch follows (Fetch, "redirect status"). */
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** Fetch's own limit on redirect hops (Fetch, "HTTP-redirect fetch", step 5). */
const MAX_REDIRECTS = 20;

/**
 * Sends a prepared request and resolves with the first response that is not
 * a redirect followed under `rule`.
 *
 * Redirects are followed by hand rather than by `fetch`, because `fetch`
 * keeps an `X-Api-Key` header or an api key in the query string when a
 * redirect leaves the origin. Same-origin redirects are followed with the
 * method rules Fetch uses; any redirect off the origin is refused, so
 * credentials never reach a host the template did not name.
 *
 * @throws {RoveError} `transport_failed`, `cross_origin_redirect`,
 * `redirect_not_followed`, `insecure_url`. An abort rejects with the
 * signal's reason.
 */
export async function send(
	prepared: PreparedRequest,
	transport: Transport,
	rule: RedirectRule,
	tool: string,
	signal: AbortSignal | undefined
): Promise<Response> {
	let current = prepared;

	for (let hop = 0; ; hop += 1) {
		const request = new Request(current.url, {
			method: current.method,
			headers: current.headers,
			body: current.body,
			redirect: "manual",
			signal,
		});

		let response: Response;
		try {
			response = await transport(request);
		} catch (cause) {
			if (signal?.aborted === true) {
				throw signal.reason;
			}
			throw new RoveError(`${current.method} ${current.url.origin} failed before a response arrived`, {
				code: "transport_failed",
				tool,
				target: current.url.toString(),
				cause,
			});
		}

		if (response.type === "opaqueredirect") {
			throw new RoveError(
				`${current.url.origin} redirected and this runtime hides where to, so the redirect could not be checked`,
				{ code: "redirect_not_followed", tool, target: current.url.toString() }
			);
		}

		const location = response.headers.get("location");
		if (!REDIRECTS.has(response.status) || location === null) {
			return response;
		}

		await response.body?.cancel();
		const next = new URL(location, current.url);

		if (rule === "never") {
			throw new RoveError(
				`${current.url.toString()} redirected to ${next.toString()}; streaming calls do not follow redirects, point the template at the final URL`,
				{ code: "redirect_not_followed", tool, target: current.url.toString(), status: response.status }
			);
		}
		if (next.origin !== current.url.origin) {
			throw new RoveError(
				`${current.url.toString()} redirected to another origin, ${next.origin}; cross-origin redirects are not followed`,
				{ code: "cross_origin_redirect", tool, target: next.toString(), status: response.status }
			);
		}
		if (hop + 1 >= MAX_REDIRECTS) {
			throw new RoveError(`${prepared.url.toString()} redirected more than ${MAX_REDIRECTS} times`, {
				code: "redirect_not_followed",
				tool,
				target: next.toString(),
				status: response.status,
			});
		}

		current = redirected(current, secureUrl(next.toString(), HTTP_SCHEMES, tool), response.status);
	}
}

/**
 * The request for the next hop. 303, and 301 or 302 after a `POST`, become a
 * body-less `GET` (Fetch, "HTTP-redirect fetch", step 12); 307 and 308 repeat
 * the request as it was.
 */
function redirected(previous: PreparedRequest, url: URL, status: number): PreparedRequest {
	const toGet =
		(status === 303 && previous.method !== "GET" && previous.method !== "HEAD") ||
		((status === 301 || status === 302) && previous.method === "POST");

	if (previous.queryCredential !== undefined) {
		url.searchParams.set(...previous.queryCredential);
	}

	if (!toGet) {
		return { ...previous, url };
	}

	const headers = new Headers(previous.headers);
	for (const name of ["content-type", "content-length", "content-encoding", "content-language", "content-location"]) {
		headers.delete(name);
	}
	return { ...previous, url, method: "GET", headers, body: undefined };
}

/**
 * Turns a non-2xx response into a `status` error carrying its body.
 *
 * @throws {RoveError} `status`.
 */
export async function ensureOk(
	response: Response,
	prepared: PreparedRequest,
	tool: string,
	limit: number
): Promise<void> {
	if (response.ok) {
		return;
	}
	const body = await readForError(response, limit);
	const statusText = response.statusText.length > 0 ? ` ${response.statusText}` : "";
	throw new RoveError(`${prepared.method} ${prepared.url.toString()} failed with HTTP ${response.status}${statusText}`, {
		code: "status",
		tool,
		target: prepared.url.toString(),
		status: response.status,
		headers: response.headers,
		body,
	});
}

/** The media type of a response, lowercased, without parameters. */
export function mediaType(response: Response): string {
	return (response.headers.get("content-type") ?? "").split(";", 1)[0]?.trim().toLowerCase() ?? "";
}
