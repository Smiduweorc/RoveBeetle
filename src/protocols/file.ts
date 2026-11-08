import { open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type { CallOptions, ToolCall } from "../call.js";
import { RoveError } from "../errors.js";
import { checkLimit, tooLarge, utf8, type ResponseLimit } from "../limit.js";
import { Session, type ClientOptions } from "../session.js";

/** Options for a {@link FileClient}. `maxResponseBytes` bounds the file's size. */
export interface FileClientOptions<TVariables extends string> extends Omit<ClientOptions<TVariables>, "transport" | "now">, ResponseLimit {
	/**
	 * The directory relative paths resolve against, and the only one files
	 * are read from: a path that resolves outside it is refused. Required,
	 * because which files a package may read is yours to decide. Pass `"/"`
	 * to allow every path.
	 */
	readonly root: string | URL;
}

/**
 * Calls `file` tools, whose result is the content of a file. Node-only.
 */
export class FileClient<TVariables extends string = never> {
	readonly #session: Session;
	readonly #limit: number;
	readonly #root: string;
	#realRoot: Promise<string> | undefined;

	constructor(options: FileClientOptions<TVariables>) {
		this.#session = new Session(options, options?.maxResponseBytes);
		this.#limit = checkLimit(options);
		if (typeof options.root !== "string" && !(options.root instanceof URL)) {
			throw new RoveError("root is required: the directory files may be read from, or \"/\" for any", {
				code: "unsupported_value",
			});
		}
		this.#root = resolve(options.root instanceof URL ? fileURLToPath(options.root) : options.root);
	}

	/**
	 * Reads the file and resolves with its content as UTF-8 text. The path,
	 * and where its symlinks lead, must be inside `root`.
	 *
	 * @throws {RoveError} `unsupported_value` for a path outside `root`,
	 * `protocol_error` for a file over `maxResponseBytes`, `transport_failed`
	 * when it cannot be read (the `cause` has the system error code, such as
	 * `ENOENT`). An abort rejects with the signal's reason.
	 */
	async call<TResult = string>(call: ToolCall<"file", TResult, TVariables>, options: CallOptions = {}): Promise<TResult> {
		const template = this.#session.resolve(call, ["file"]);
		const path = resolve(this.#root, template.path);
		this.#confine(this.#root, path, template.path, call.tool);

		options.signal?.throwIfAborted();
		// The named path is inside the root; so must be where its symlinks
		// lead, or a link in the root would read anything on the machine.
		let real: string;
		try {
			this.#realRoot ??= realpath(this.#root);
			real = await realpath(path);
			this.#confine(await this.#realRoot, real, template.path, call.tool);
		} catch (cause) {
			if (cause instanceof RoveError) {
				throw cause;
			}
			throw new RoveError(`could not open ${path}`, { code: "transport_failed", tool: call.tool, target: path, cause });
		}

		let handle;
		try {
			handle = await open(real, "r");
		} catch (cause) {
			throw new RoveError(`could not open ${path}`, { code: "transport_failed", tool: call.tool, target: path, cause });
		}
		try {
			const { size } = await handle.stat();
			if (size > this.#limit) {
				throw tooLarge(this.#limit, call.tool, path);
			}
			// One byte past the size stat gave, so a file that grew since is
			// noticed; reading stops at the limit either way.
			let buffer = new Uint8Array(Math.min(size, this.#limit) + 1);
			let read = 0;
			for (;;) {
				options.signal?.throwIfAborted();
				const { bytesRead } = await handle.read(buffer, read, buffer.length - read, read);
				if (bytesRead === 0) {
					break;
				}
				read += bytesRead;
				if (read > this.#limit) {
					throw tooLarge(this.#limit, call.tool, path);
				}
				if (read === buffer.length) {
					// It grew after stat and is still within the limit: keep reading.
					const grown = new Uint8Array(Math.min(buffer.length * 2, this.#limit + 1));
					grown.set(buffer);
					buffer = grown;
				}
			}
			return utf8(buffer.subarray(0, read)) as TResult;
		} catch (cause) {
			if (cause instanceof RoveError || options.signal?.aborted === true) {
				throw cause;
			}
			throw new RoveError(`could not read ${path}`, { code: "transport_failed", tool: call.tool, target: path, cause });
		} finally {
			await handle.close();
		}
	}

	#confine(root: string, path: string, named: string, tool: string): void {
		const inside = relative(root, path);
		if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
			throw new RoveError(`${named} resolves outside the client's root, ${this.#root}`, {
				code: "unsupported_value",
				tool,
				target: path,
			});
		}
	}
}
