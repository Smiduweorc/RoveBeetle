import type { Transport } from "../../src/auth.js";

/** A request as the transport saw it, with the body already read. */
export interface Seen {
	readonly method: string;
	readonly url: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly body: string;
	readonly redirect: Request["redirect"];
	readonly signal: AbortSignal;
}

/**
 * A transport that answers from a script and records every request. Each
 * answer is a `Response`, an error to throw, or a function of the request.
 */
export function scripted(...answers: (Response | Error | ((request: Request) => Promise<Response> | Response))[]): {
	transport: Transport;
	seen: Seen[];
} {
	const seen: Seen[] = [];
	const transport: Transport = async (request) => {
		seen.push({
			method: request.method,
			url: request.url,
			headers: Object.fromEntries(request.headers),
			body: await request.clone().text(),
			redirect: request.redirect,
			signal: request.signal,
		});
		const answer = answers.shift();
		if (answer === undefined) {
			throw new Error(`no scripted answer for request ${seen.length}: ${request.method} ${request.url}`);
		}
		if (answer instanceof Error) {
			throw answer;
		}
		return typeof answer === "function" ? answer(request) : answer;
	};
	return { transport, seen };
}

export function json(body: unknown, init: ResponseInit = {}): Response {
	return new Response(JSON.stringify(body), {
		...init,
		headers: { "content-type": "application/json", ...(init.headers as Record<string, string> | undefined) },
	});
}

/** A promise the test resolves when it chooses, to force an ordering. */
export function gate<T>(): { promise: Promise<T>; open: (value: T) => void; fail: (error: unknown) => void } {
	let open!: (value: T) => void;
	let fail!: (error: unknown) => void;
	const promise = new Promise<T>((resolve, reject) => {
		open = resolve;
		fail = reject;
	});
	return { promise, open, fail };
}

/** A clock the test moves by hand. */
export function clock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
	let current = start;
	return {
		now: () => current,
		advance: (ms) => {
			current += ms;
		},
	};
}
