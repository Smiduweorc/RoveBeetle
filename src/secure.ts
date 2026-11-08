import { RoveError } from "./errors.js";

// The spec requires HTTPS for every HTTP-based call, except to the machine the
// call starts on, which is how local development works. A template's URL can
// hold variables, so this is checked on the resolved URL of every request,
// every redirect hop and every token request.

/**
 * Whether `hostname` (as `URL.hostname` gives it) is this machine: `localhost`,
 * anything in `127.0.0.0/8`, or `::1`.
 */
export function isLoopback(hostname: string): boolean {
	if (hostname === "localhost" || hostname === "[::1]") {
		return true;
	}
	return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(hostname);
}

/**
 * Parses `text` as an absolute URL and checks it is secure: `https:` (or
 * `wss:` where `secure` names it), or the insecure scheme to a loopback host.
 *
 * @throws {RoveError} `insecure_url`, also for a URL that does not parse.
 */
export function secureUrl(
	text: string,
	schemes: { readonly secure: string; readonly insecure: string },
	tool: string | undefined
): URL {
	let url: URL;
	try {
		url = new URL(text);
	} catch (cause) {
		throw new RoveError(`${JSON.stringify(text)} is not an absolute URL`, {
			code: "insecure_url",
			tool,
			target: text,
			cause,
		});
	}

	const allowed =
		url.protocol === schemes.secure || (url.protocol === schemes.insecure && isLoopback(url.hostname));

	if (!allowed) {
		throw new RoveError(
			`${url.origin} is not ${schemes.secure.slice(0, -1)}; only loopback hosts may use ${schemes.insecure.slice(0, -1)}`,
			{ code: "insecure_url", tool, target: url.toString() }
		);
	}

	return url;
}

export const HTTP_SCHEMES = { secure: "https:", insecure: "http:" } as const;
export const WS_SCHEMES = { secure: "wss:", insecure: "ws:" } as const;
