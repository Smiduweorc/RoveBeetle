import type { ToolCall } from "../call.js";
import { RoveError } from "../errors.js";

/**
 * Calls `text` tools, whose result is the content written in the manual. No
 * I/O, no variables: the content is data and is returned as written.
 */
export class TextClient {
	/** Resolves with the template's content. */
	async call<TResult = string>(call: ToolCall<"text", TResult>): Promise<TResult> {
		if (call.protocol !== "text") {
			throw new RoveError(`tool ${call.tool} uses ${call.protocol}, and this client sends text`, {
				code: "unsupported_value",
				tool: call.tool,
			});
		}
		return call.template.content as TResult;
	}
}
