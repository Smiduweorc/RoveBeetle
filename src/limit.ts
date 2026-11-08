import { RoveError } from "./errors.js";

/** The size limit every client that buffers a response is constructed with. */
export interface ResponseLimit {
	/**
	 * The most bytes one response may hold before the call fails with
	 * `protocol_error`: a whole HTTP body, one SSE event, one NDJSON line, one
	 * socket reply, a command's output. Required, because only you know how
	 * large a legitimate answer from these tools gets. Pick a number a few
	 * times the largest response you expect; a provider that sends more than
	 * that is broken or hostile, and the bytes stop at the limit.
	 */
	readonly maxResponseBytes: number;
}

/**
 * Checks `maxResponseBytes` once, in a client's constructor.
 *
 * @throws {RoveError} `unsupported_value`, naming the fix.
 */
export function checkLimit(options: Partial<ResponseLimit> | undefined): number {
	const limit = options?.maxResponseBytes;
	if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit <= 0) {
		throw new RoveError(
			`maxResponseBytes is required and must be a positive integer, such as 1_048_576 for 1 MiB; got ${String(limit)}`,
			{ code: "unsupported_value" }
		);
	}
	return limit;
}

/** Thrown when a response passes its limit. */
export function tooLarge(limit: number, tool: string, target: string): RoveError {
	return new RoveError(`the response from ${target} is larger than maxResponseBytes (${limit})`, {
		code: "protocol_error",
		tool,
		target,
	});
}

/**
 * Reads a whole HTTP body, failing as soon as it passes `limit` bytes. A
 * `content-length` over the limit fails before any byte is read.
 *
 * @throws {RoveError} `protocol_error` over the limit, `transport_failed` if
 * the body stops arriving. An abort rejects with the signal's reason.
 */
export async function readLimited(
	response: Response,
	limit: number,
	tool: string,
	target: string,
	signal: AbortSignal | undefined
): Promise<Uint8Array> {
	const declared = Number(response.headers.get("content-length") ?? NaN);
	if (Number.isFinite(declared) && declared > limit) {
		await response.body?.cancel();
		throw tooLarge(limit, tool, target);
	}
	if (response.body === null) {
		return new Uint8Array();
	}

	const chunks: Uint8Array[] = [];
	let total = 0;
	// A reader rather than `for await`: Safari's streams are not async iterable.
	const reader = response.body.getReader();
	for (;;) {
		const { done, value } = await nextChunk(reader, tool, target, signal);
		if (done) {
			break;
		}
		total += value.byteLength;
		if (total > limit) {
			await reader.cancel().catch(() => undefined);
			throw tooLarge(limit, tool, target);
		}
		chunks.push(value);
	}

	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

/**
 * The next chunk from `reader`, turning a stream that stops arriving into
 * `transport_failed` and an abort into the signal's reason.
 *
 * An abort cancels the reader here rather than trusting the transport to
 * end the body: `fetch` does, but a wrapper or a test transport may not, and
 * the call would then wait for a chunk that never comes.
 */
export async function nextChunk(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	tool: string,
	target: string,
	signal: AbortSignal | undefined
): Promise<Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>> {
	signal?.throwIfAborted();
	let onAbort: (() => void) | undefined;
	const aborted =
		signal === undefined
			? undefined
			: new Promise<never>((_resolve, reject) => {
				onAbort = (): void => {
					reader.cancel(signal.reason).catch(() => undefined);
					reject(signal.reason);
				};
				signal.addEventListener("abort", onAbort, { once: true });
			});
	try {
		return await (aborted === undefined ? reader.read() : Promise.race([reader.read(), aborted]));
	} catch (cause) {
		if (signal?.aborted === true) {
			throw signal.reason;
		}
		throw new RoveError(`the response from ${target} stopped arriving`, { code: "transport_failed", tool, target, cause });
	} finally {
		if (onAbort !== undefined) {
			signal?.removeEventListener("abort", onAbort);
		}
	}
}

/**
 * An error response's body as text for the error report, or `undefined` when
 * it is over the limit or cannot be read: the status still reaches the caller.
 */
export async function readForError(response: Response, limit: number): Promise<string | undefined> {
	try {
		return utf8(await readLimited(response, limit, "", "", undefined));
	} catch {
		return undefined;
	}
}

/** UTF-8, with malformed sequences replaced, as `Response.text()` decodes. */
export function utf8(bytes: Uint8Array): string {
	return new TextDecoder().decode(bytes);
}
