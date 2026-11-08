import { nextChunk, tooLarge } from "./limit.js";

/**
 * Splits a byte stream into UTF-8 lines at LF, dropping a CR before it and
 * skipping lines that are empty or only whitespace. A last line without an
 * LF is yielded when the stream ends. Used for NDJSON and for MCP's stdio
 * transport, which both put one JSON value on each line.
 *
 * Cancelling the iteration cancels the stream.
 *
 * @throws {RoveError} `protocol_error` for a line over `limit` bytes,
 * `transport_failed` if the stream stops arriving.
 */
export async function* readLines(
	stream: ReadableStream<Uint8Array>,
	limit: number,
	tool: string,
	target: string,
	signal: AbortSignal | undefined
): AsyncGenerator<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let pending = new Uint8Array();

	const emit = (bytes: Uint8Array): string | undefined => {
		const end = bytes.at(-1) === 0x0d ? bytes.length - 1 : bytes.length;
		const text = decoder.decode(bytes.subarray(0, end));
		return text.trim().length === 0 ? undefined : text;
	};

	try {
		for (;;) {
			const chunk = await nextChunk(reader, tool, target, signal);
			if (chunk.done) {
				const last = pending.length > 0 ? emit(pending) : undefined;
				if (last !== undefined) {
					yield last;
				}
				return;
			}

			let joined = new Uint8Array(pending.length + chunk.value.length);
			joined.set(pending);
			joined.set(chunk.value, pending.length);

			for (let newline = joined.indexOf(0x0a); newline !== -1; newline = joined.indexOf(0x0a)) {
				if (newline > limit) {
					throw tooLarge(limit, tool, target);
				}
				const text = emit(joined.subarray(0, newline));
				joined = joined.subarray(newline + 1);
				if (text !== undefined) {
					yield text;
				}
			}
			if (joined.length > limit) {
				throw tooLarge(limit, tool, target);
			}
			pending = joined.slice();
		}
	} finally {
		await reader.cancel().catch(() => undefined);
	}
}
