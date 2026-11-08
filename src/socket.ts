import { RoveError } from "./errors.js";

// One WebSocket connection, as a queue of messages a call can await. Used by
// the `websocket` client and by GraphQL subscriptions.

/** What a {@link WebSocketFactory} is asked to open. */
export interface WebSocketInit {
	readonly protocols: readonly string[];
	/** Headers for the opening handshake. Empty when the call needs none. */
	readonly headers: Readonly<Record<string, string>>;
}

/**
 * Opens a WebSocket. The default uses the global `WebSocket`, passing headers
 * the way Node (undici) and Bun accept them: `new WebSocket(url, { protocols,
 * headers })`. Browsers cannot send handshake headers at all; a call that
 * needs them fails there with `transport_failed`.
 */
export type WebSocketFactory = (url: string, init: WebSocketInit) => WebSocket;

export const globalWebSocket: WebSocketFactory = (url, init) =>
	Object.keys(init.headers).length === 0
		? new WebSocket(url, [...init.protocols])
		: // The init object is a Node and Bun extension the DOM types do not declare.
		new WebSocket(url, { protocols: [...init.protocols], headers: { ...init.headers } } as unknown as string[]);

/** One message as it arrived. */
export type SocketMessage = string | Uint8Array;

/** An open connection: send, receive in order, close. */
export interface Connection {
	send(message: string): void;
	/** The next message, or `undefined` once the server has closed normally. */
	next(): Promise<SocketMessage | undefined>;
	close(): void;
}

/** Close codes that mean the server finished, not failed (RFC 6455 section 7.4.1). */
const NORMAL_CLOSE = new Set([1000, 1005]);

/**
 * Opens `url` and resolves once the connection is open.
 *
 * | Event | Becomes |
 * | --- | --- |
 * | Fails before opening | `transport_failed` |
 * | A message over `limit` bytes | `protocol_error`, and the connection is closed |
 * | Closes with 1000 or 1005 | `next()` resolves `undefined` |
 * | Closes with any other code | `next()` rejects with `transport_failed` naming the code |
 * | The signal aborts | everything pending rejects with its reason, and the connection is closed |
 *
 * @throws {RoveError} `transport_failed`. An abort rejects with the signal's reason.
 */
export async function openConnection(
	factory: WebSocketFactory,
	url: string,
	init: WebSocketInit,
	limit: number,
	tool: string,
	signal: AbortSignal | undefined
): Promise<Connection> {
	signal?.throwIfAborted();

	let socket: WebSocket;
	try {
		socket = factory(url, init);
	} catch (cause) {
		throw new RoveError(`could not open a WebSocket to ${url}`, { code: "transport_failed", tool, target: url, cause });
	}
	socket.binaryType = "arraybuffer";

	const queue: SocketMessage[] = [];
	const waiting: { resolve: (message: SocketMessage | undefined) => void; reject: (error: unknown) => void }[] = [];
	let ended: { error: unknown } | "closed" | undefined;

	const finish = (outcome: { error: unknown } | "closed"): void => {
		if (ended !== undefined) {
			return;
		}
		ended = outcome;
		for (const waiter of waiting.splice(0)) {
			if (outcome === "closed") {
				waiter.resolve(undefined);
			} else {
				waiter.reject(outcome.error);
			}
		}
	};

	const onAbort = (): void => {
		finish({ error: signal?.reason });
		socket.close();
	};
	signal?.addEventListener("abort", onAbort, { once: true });

	const opened = new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve(), { once: true });
		socket.addEventListener(
			"error",
			() => reject(new RoveError(`the WebSocket to ${url} failed to open`, { code: "transport_failed", tool, target: url })),
			{ once: true }
		);
		socket.addEventListener("close", (event) => {
			reject(new RoveError(`the WebSocket to ${url} closed before opening (code ${event.code})`, {
				code: "transport_failed",
				tool,
				target: url,
				status: event.code,
			}));
		}, { once: true });
		signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
	});

	socket.addEventListener("message", (event: MessageEvent) => {
		if (ended !== undefined) {
			return;
		}
		const message: SocketMessage =
			typeof event.data === "string" ? event.data : new Uint8Array(event.data as ArrayBuffer);
		const size = typeof message === "string" ? new TextEncoder().encode(message).byteLength : message.byteLength;
		if (size > limit) {
			finish({
				error: new RoveError(`a message from ${url} is larger than maxResponseBytes (${limit})`, {
					code: "protocol_error",
					tool,
					target: url,
				}),
			});
			socket.close();
			return;
		}
		const waiter = waiting.shift();
		if (waiter === undefined) {
			queue.push(message);
		} else {
			waiter.resolve(message);
		}
	});

	socket.addEventListener("close", (event: CloseEvent) => {
		signal?.removeEventListener("abort", onAbort);
		finish(
			NORMAL_CLOSE.has(event.code)
				? "closed"
				: {
					error: new RoveError(`the WebSocket to ${url} closed with code ${event.code}${event.reason.length > 0 ? `: ${event.reason}` : ""}`, {
						code: "transport_failed",
						tool,
						target: url,
						status: event.code,
					}),
				}
		);
	});

	try {
		await opened;
	} catch (error) {
		signal?.removeEventListener("abort", onAbort);
		socket.close();
		throw error;
	}

	return {
		send: (message) => {
			socket.send(message);
		},
		next: () => {
			const message = queue.shift();
			if (message !== undefined) {
				return Promise.resolve(message);
			}
			if (ended === "closed") {
				return Promise.resolve(undefined);
			}
			if (ended !== undefined) {
				return Promise.reject(ended.error);
			}
			return new Promise((resolve, reject) => {
				waiting.push({ resolve, reject });
			});
		},
		close: () => {
			signal?.removeEventListener("abort", onAbort);
			finish("closed");
			if (socket.readyState === socket.CONNECTING || socket.readyState === socket.OPEN) {
				socket.close(1000);
			}
		},
	};
}
