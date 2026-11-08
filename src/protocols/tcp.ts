import { connect, type Socket } from "node:net";

import type { CallOptions, TcpFraming, ToolCall } from "../call.js";
import { RoveError } from "../errors.js";
import { checkLimit, tooLarge, type ResponseLimit } from "../limit.js";
import { concat, decodeResponse, requestPayload } from "../payload.js";
import { Session, type ClientOptions } from "../session.js";

/** Options for a {@link TcpClient}. `maxResponseBytes` bounds the response, whatever the framing. */
export interface TcpClientOptions<TVariables extends string> extends Omit<ClientOptions<TVariables>, "transport" | "now">, ResponseLimit {}

/**
 * Calls `tcp` tools: one connection per call, one request, one framed
 * response. Node-only. TCP has no auth in the spec and no TLS here, so the
 * request travels in the clear.
 *
 * A manual's `timeout` is in each tool's doc comment and not applied.
 */
export class TcpClient<TVariables extends string = never> {
	readonly #session: Session;
	readonly #limit: number;

	constructor(options: TcpClientOptions<TVariables>) {
		this.#session = new Session(options, options?.maxResponseBytes);
		this.#limit = checkLimit(options);
	}

	/**
	 * Sends the request, framed, and resolves with the response, decoded in
	 * the template's encoding (bytes when it has none).
	 *
	 * | Framing | Request | Response |
	 * | --- | --- | --- |
	 * | `length_prefix` | prefixed with its byte length (1, 2, 4 or 8 bytes, big or little endian) | the prefix, then that many bytes |
	 * | `delimiter` | followed by the delimiter | bytes up to the first delimiter |
	 * | `fixed_length` | as is | exactly that many bytes |
	 * | `stream` | as is | everything until the server closes, at most `max_response_size` |
	 *
	 * @throws {RoveError} `transport_failed` (refused, reset, closed before the
	 * response was complete), `protocol_error` (a response over the limit, a
	 * request too long for its length prefix), `decode_failed`. An abort
	 * rejects with the signal's reason.
	 */
	async call<TResult = string>(call: ToolCall<"tcp", TResult, TVariables>, options: CallOptions = {}): Promise<TResult> {
		const template = this.#session.resolve(call, ["tcp"]);
		const target = `${template.host}:${template.port}`;
		const request = frame(new TextEncoder().encode(requestPayload(template, call.args, call.tool)), template.framing, call.tool, target);
		const limit =
			template.framing.strategy === "stream" ? Math.min(this.#limit, template.framing.maxResponseSize) : this.#limit;

		options.signal?.throwIfAborted();
		const bytes = await exchange(template.host, template.port, request, template.framing, limit, call.tool, target, options.signal);
		return decodeResponse(bytes, template.responseEncoding, call.tool, target) as TResult;
	}
}

function frame(payload: Uint8Array, framing: TcpFraming, tool: string, target: string): Uint8Array {
	switch (framing.strategy) {
	case "length_prefix": {
		const prefix = new Uint8Array(framing.bytes);
		const view = new DataView(prefix.buffer);
		const little = framing.endian === "little";
		const max = framing.bytes === 8 ? Number.MAX_SAFE_INTEGER : 2 ** (8 * framing.bytes) - 1;
		if (payload.byteLength > max) {
			throw new RoveError(`the request is ${payload.byteLength} bytes, more than a ${framing.bytes}-byte length prefix holds`, {
				code: "protocol_error",
				tool,
				target,
			});
		}
		if (framing.bytes === 1) {
			view.setUint8(0, payload.byteLength);
		} else if (framing.bytes === 2) {
			view.setUint16(0, payload.byteLength, little);
		} else if (framing.bytes === 4) {
			view.setUint32(0, payload.byteLength, little);
		} else {
			view.setBigUint64(0, BigInt(payload.byteLength), little);
		}
		return concat([prefix, payload]);
	}
	case "delimiter":
		return concat([payload, new TextEncoder().encode(framing.delimiter)]);
	case "fixed_length":
	case "stream":
		return payload;
	}
}

/** What the framing needs to have seen before the response is complete. */
function complete(buffer: Uint8Array, framing: TcpFraming, limit: number, tool: string, target: string): Uint8Array | undefined {
	switch (framing.strategy) {
	case "length_prefix": {
		if (buffer.byteLength < framing.bytes) {
			return undefined;
		}
		const view = new DataView(buffer.buffer, buffer.byteOffset, framing.bytes);
		const little = framing.endian === "little";
		const length =
			framing.bytes === 1
				? view.getUint8(0)
				: framing.bytes === 2
					? view.getUint16(0, little)
					: framing.bytes === 4
						? view.getUint32(0, little)
						: view.getBigUint64(0, little);
		if (Number(length) > limit) {
			throw tooLarge(limit, tool, target);
		}
		const end = framing.bytes + Number(length);
		return buffer.byteLength >= end ? buffer.slice(framing.bytes, end) : undefined;
	}
	case "delimiter": {
		const delimiter = new TextEncoder().encode(framing.delimiter);
		const at = indexOf(buffer, delimiter);
		if (at === -1) {
			if (buffer.byteLength > limit + delimiter.byteLength) {
				throw tooLarge(limit, tool, target);
			}
			return undefined;
		}
		if (at > limit) {
			throw tooLarge(limit, tool, target);
		}
		return buffer.slice(0, at);
	}
	case "fixed_length":
		if (framing.length > limit) {
			throw tooLarge(limit, tool, target);
		}
		return buffer.byteLength >= framing.length ? buffer.slice(0, framing.length) : undefined;
	case "stream":
		if (buffer.byteLength > limit) {
			throw tooLarge(limit, tool, target);
		}
		return undefined;
	}
}

function indexOf(haystack: Uint8Array, needle: Uint8Array): number {
	outer: for (let start = 0; start + needle.byteLength <= haystack.byteLength; start += 1) {
		for (let offset = 0; offset < needle.byteLength; offset += 1) {
			if (haystack[start + offset] !== needle[offset]) {
				continue outer;
			}
		}
		return start;
	}
	return -1;
}

function exchange(
	host: string,
	port: number,
	request: Uint8Array,
	framing: TcpFraming,
	limit: number,
	tool: string,
	target: string,
	signal: AbortSignal | undefined
): Promise<Uint8Array> {
	return new Promise((resolve, reject) => {
		let buffer: Uint8Array = new Uint8Array();
		let settled = false;
		const socket: Socket = connect({ host, port });

		const settle = (outcome: () => void): void => {
			if (settled) {
				return;
			}
			settled = true;
			signal?.removeEventListener("abort", onAbort);
			socket.destroy();
			outcome();
		};
		const onAbort = (): void => settle(() => reject(signal?.reason));
		signal?.addEventListener("abort", onAbort, { once: true });

		socket.on("connect", () => {
			socket.write(request);
		});
		socket.on("data", (chunk: Uint8Array) => {
			buffer = concat([buffer, chunk]);
			try {
				const response = complete(buffer, framing, limit, tool, target);
				if (response !== undefined) {
					settle(() => resolve(response));
				}
			} catch (error) {
				settle(() => reject(error));
			}
		});
		socket.on("end", () => {
			if (framing.strategy === "stream") {
				settle(() => resolve(buffer));
				return;
			}
			settle(() =>
				reject(new RoveError(`${target} closed the connection before the response was complete`, { code: "transport_failed", tool, target }))
			);
		});
		socket.on("error", (cause) => {
			settle(() => reject(new RoveError(`the connection to ${target} failed`, { code: "transport_failed", tool, target, cause })));
		});
	});
}
