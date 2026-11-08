import type { DataFormat } from "./call.js";
import { RoveError } from "./errors.js";

/**
 * One text payload as a value.
 *
 * | Format | Text | Result |
 * | --- | --- | --- |
 * | `text` | anything | the text |
 * | `json` | valid JSON | the parsed value |
 * | `json` | anything else | `decode_failed` with the text as `body` |
 * | `auto` | valid JSON | the parsed value |
 * | `auto` | anything else | the text |
 *
 * @throws {RoveError} `decode_failed`.
 */
export function decodeData(text: string, format: DataFormat, tool: string, target: string): unknown {
	if (format === "text") {
		return text;
	}
	try {
		return JSON.parse(text) as unknown;
	} catch (cause) {
		if (format === "auto") {
			return text;
		}
		throw new RoveError(`${target} sent a payload that is not valid JSON`, {
			code: "decode_failed",
			tool,
			target,
			body: text,
			cause,
		});
	}
}
