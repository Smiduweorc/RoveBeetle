import { nextChunk, tooLarge } from "./limit.js";

// The `text/event-stream` format, as the WHATWG HTML standard defines it
// (section 9.2.6, "Interpreting an event stream"). Used by the `sse` client
// and by MCP's Streamable HTTP transport, whose responses may be SSE.

/** One dispatched event. */
export interface ServerSentEvent {
	/** `event:` field, `message` when the stream did not name one. */
	readonly type: string;
	readonly data: string;
	/** The last event ID seen so far in the stream, if any. */
	readonly lastEventId: string;
}

/**
 * Reads events from an SSE body until it ends.
 *
 * Lines end at CR, LF or CRLF, also when the CR and LF arrive in different
 * chunks. A UTF-8 byte order mark at the start is dropped. Comments, unknown
 * fields and events with no `data` are skipped, and `retry` is ignored (this
 * client does not reconnect). An event whose buffered size passes `limit`
 * bytes fails the stream; an event the stream did not finish with a blank
 * line is discarded, as the standard says.
 *
 * Cancelling the iteration cancels the body.
 *
 * @throws {RoveError} `protocol_error` over the limit, `transport_failed` if
 * the body stops arriving.
 */
export async function* readEvents(
	body: ReadableStream<Uint8Array>,
	limit: number,
	tool: string,
	target: string,
	signal: AbortSignal | undefined
): AsyncGenerator<ServerSentEvent> {
	const reader = body.getReader();
	const decoder = new TextDecoder("utf-8", { ignoreBOM: false });

	const encoder = new TextEncoder();

	let buffer = "";
	let data = "";
	let hasData = false;
	let type = "";
	let lastEventId = "";
	let eventBytes = 0;

	/** Feeds one complete line; returns an event when the line was blank. */
	const line = (text: string): ServerSentEvent | undefined => {
		if (text.length === 0) {
			const event = hasData ? { type: type.length > 0 ? type : "message", data, lastEventId } : undefined;
			data = "";
			hasData = false;
			type = "";
			eventBytes = 0;
			return event;
		}

		eventBytes += encoder.encode(text).byteLength + 1;
		if (eventBytes > limit) {
			throw tooLarge(limit, tool, target);
		}

		if (text.startsWith(":")) {
			return undefined;
		}
		const colon = text.indexOf(":");
		const field = colon === -1 ? text : text.slice(0, colon);
		let value = colon === -1 ? "" : text.slice(colon + 1);
		if (value.startsWith(" ")) {
			value = value.slice(1);
		}

		switch (field) {
		case "data":
			data = hasData ? `${data}\n${value}` : value;
			hasData = true;
			break;
		case "event":
			type = value;
			break;
		case "id":
			if (!value.includes("\0")) {
				lastEventId = value;
			}
			break;
		default:
			break;
		}
		return undefined;
	};

	/** Splits `buffer` into complete lines and yields what they dispatch. */
	function* drain(final: boolean): Generator<ServerSentEvent> {
		for (;;) {
			const match = /\r\n|\r|\n/u.exec(buffer);
			if (match === null) {
				break;
			}
			// A CR at the very end may be the first half of a CRLF still in
			// flight; wait for the next chunk before deciding.
			if (match[0] === "\r" && match.index === buffer.length - 1 && !final) {
				break;
			}
			const text = buffer.slice(0, match.index);
			buffer = buffer.slice(match.index + match[0].length);
			const event = line(text);
			if (event !== undefined) {
				yield event;
			}
		}
		if (encoder.encode(buffer).byteLength + eventBytes > limit) {
			throw tooLarge(limit, tool, target);
		}
	}

	try {
		for (;;) {
			const chunk = await nextChunk(reader, tool, target, signal);
			if (chunk.done) {
				buffer += decoder.decode();
				yield* drain(true);
				return;
			}
			buffer += decoder.decode(chunk.value, { stream: true });
			yield* drain(false);
		}
	} finally {
		await reader.cancel().catch(() => undefined);
	}
}
