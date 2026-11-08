import { createSocket, type RemoteInfo } from "node:dgram";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import type { CallOptions, ToolCall } from "../call.js";
import { RoveError } from "../errors.js";
import { checkLimit, tooLarge, type ResponseLimit } from "../limit.js";
import { concat, decodeResponse, requestPayload } from "../payload.js";
import { Session, type ClientOptions } from "../session.js";

/** Options for a {@link UdpClient}. `maxResponseBytes` bounds the joined datagrams. */
export interface UdpClientOptions<TVariables extends string> extends Omit<ClientOptions<TVariables>, "transport" | "now">, ResponseLimit {}

/**
 * Calls `udp` tools: one datagram out, a fixed number back. Node-only. UDP
 * has no auth in the spec and no encryption here.
 *
 * UDP can lose a datagram, and then the call waits until the signal aborts:
 * pass one. A manual's `timeout` is in each tool's doc comment.
 */
export class UdpClient<TVariables extends string = never> {
	readonly #session: Session;
	readonly #limit: number;

	constructor(options: UdpClientOptions<TVariables>) {
		this.#session = new Session(options, options?.maxResponseBytes);
		this.#limit = checkLimit(options);
	}

	/**
	 * Sends the request and waits for exactly `number_of_response_datagrams`
	 * datagrams from the target's address and port, ignoring any from
	 * elsewhere. They are joined in arrival order and decoded in the
	 * template's encoding (bytes when it has none). With zero datagrams
	 * expected it resolves as soon as the request is sent, with an empty
	 * result.
	 *
	 * @throws {RoveError} `transport_failed`, `protocol_error` over the limit,
	 * `decode_failed`. An abort rejects with the signal's reason.
	 */
	async call<TResult = string>(call: ToolCall<"udp", TResult, TVariables>, options: CallOptions = {}): Promise<TResult> {
		const template = this.#session.resolve(call, ["udp"]);
		const target = `${template.host}:${template.port}`;
		const request = new TextEncoder().encode(requestPayload(template, call.args, call.tool));
		options.signal?.throwIfAborted();

		let address: string;
		let family: 4 | 6;
		try {
			const found = isIP(template.host) === 0 ? await lookup(template.host) : { address: template.host, family: isIP(template.host) };
			address = found.address;
			family = found.family === 6 ? 6 : 4;
		} catch (cause) {
			throw new RoveError(`could not resolve ${template.host}`, { code: "transport_failed", tool: call.tool, target, cause });
		}

		const datagrams = await exchange(address, family, template.port, request, template.datagrams, this.#limit, call.tool, target, options.signal);
		return decodeResponse(concat(datagrams), template.responseEncoding, call.tool, target) as TResult;
	}
}

function exchange(
	address: string,
	family: 4 | 6,
	port: number,
	request: Uint8Array,
	expected: number,
	limit: number,
	tool: string,
	target: string,
	signal: AbortSignal | undefined
): Promise<Uint8Array[]> {
	return new Promise((resolve, reject) => {
		const socket = createSocket(family === 6 ? "udp6" : "udp4");
		const received: Uint8Array[] = [];
		let total = 0;
		let settled = false;

		const settle = (outcome: () => void): void => {
			if (settled) {
				return;
			}
			settled = true;
			signal?.removeEventListener("abort", onAbort);
			socket.close();
			outcome();
		};
		const onAbort = (): void => settle(() => reject(signal?.reason));
		signal?.addEventListener("abort", onAbort, { once: true });

		socket.on("message", (message: Uint8Array, from: RemoteInfo) => {
			if (from.address !== address || from.port !== port) {
				return;
			}
			total += message.byteLength;
			if (total > limit) {
				settle(() => reject(tooLarge(limit, tool, target)));
				return;
			}
			received.push(message);
			if (received.length === expected) {
				settle(() => resolve(received));
			}
		});
		socket.on("error", (cause) => {
			settle(() => reject(new RoveError(`the UDP exchange with ${target} failed`, { code: "transport_failed", tool, target, cause })));
		});
		socket.send(request, port, address, (error) => {
			if (error !== null && error !== undefined) {
				settle(() => reject(new RoveError(`could not send to ${target}`, { code: "transport_failed", tool, target, cause: error })));
				return;
			}
			if (expected === 0) {
				settle(() => resolve([]));
			}
		});
	});
}
