import type { TcpTemplate, UdpTemplate } from "./call.js";
import { RoveError } from "./errors.js";
import { fillPlainText } from "./placeholders.js";

// Request payloads and response decoding shared by `tcp` and `udp`.

/**
 * The request text for a socket call.
 *
 * | `request_data_format` | Template | Payload |
 * | --- | --- | --- |
 * | `json` | any | the arguments as JSON |
 * | `text` | set | the template with its placeholders filled |
 * | `text` | absent | the argument values joined with spaces, strings as written and anything else as JSON |
 */
export function requestPayload(template: TcpTemplate | UdpTemplate, args: Readonly<Record<string, unknown>>, tool: string): string {
	if (template.requestFormat === "json") {
		return JSON.stringify(args);
	}
	if (template.requestTemplate !== undefined && template.requestTemplate.length > 0) {
		return fillPlainText(template.requestTemplate, template.requestFields, args, tool);
	}
	return Object.values(args)
		.filter((value) => value !== undefined)
		.map((value) => (typeof value === "string" ? value : JSON.stringify(value)))
		.join(" ");
}

/**
 * Response bytes as the template says: text in `responseEncoding`, or the
 * bytes themselves when it is `null`.
 *
 * @throws {RoveError} `decode_failed` for bytes that are not valid in the encoding.
 */
export function decodeResponse(bytes: Uint8Array, encoding: string | null, tool: string, target: string): string | Uint8Array {
	if (encoding === null) {
		return bytes;
	}
	try {
		return new TextDecoder(encoding, { fatal: true }).decode(bytes);
	} catch (cause) {
		throw new RoveError(`the response from ${target} is not valid ${encoding}`, { code: "decode_failed", tool, target, cause });
	}
}

export function concat(chunks: readonly Uint8Array[]): Uint8Array {
	const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}
