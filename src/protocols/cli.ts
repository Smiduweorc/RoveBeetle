import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

import { base64Bytes } from "../auth.js";
import type { CallOptions, ToolCall } from "../call.js";
import { decodeData } from "../decode.js";
import { RoveError } from "../errors.js";
import { checkLimit, tooLarge, utf8, type ResponseLimit } from "../limit.js";
import { concat } from "../payload.js";
import { buildScript, type Shell } from "../script.js";
import { DEFAULT_INHERITED } from "../environment.js";
import { Session, type ClientOptions } from "../session.js";

/** Options for a {@link CliClient}. `maxResponseBytes` bounds the command's output. */
export interface CliClientOptions<TVariables extends string> extends Omit<ClientOptions<TVariables>, "transport" | "now">, ResponseLimit {
	/**
	 * The environment commands may inherit from: usually `process.env`, or
	 * `{}` to give them nothing. Required, because whether a tool's commands
	 * see your secrets is yours to decide; this package never reads the
	 * environment itself. From it, only the template's `inherit_env_vars`
	 * reach the command, or the spec's default list when the template names
	 * none (see {@link DEFAULT_INHERITED}).
	 */
	readonly environment: Readonly<Record<string, string | undefined>>;
}

/**
 * Calls `cli` tools: the template's commands, run as one bash script (one
 * PowerShell script on Windows) in a child process. Node-only, and needs
 * bash or PowerShell on the machine.
 */
export class CliClient<TVariables extends string = never> {
	readonly #session: Session;
	readonly #limit: number;
	readonly #environment: Readonly<Record<string, string | undefined>>;

	constructor(options: CliClientOptions<TVariables>) {
		this.#session = new Session(options, options?.maxResponseBytes);
		this.#limit = checkLimit(options);
		if (typeof options.environment !== "object" || options.environment === null) {
			throw new RoveError("environment is required: pass process.env to inherit from it, or {} to inherit nothing", {
				code: "unsupported_value",
			});
		}
		this.#environment = options.environment;
	}

	/**
	 * Runs the commands and resolves with the kept output, trimmed and
	 * decoded as the template says. Kept outputs are joined as written; the
	 * reference implementation puts a newline after each, which reads the
	 * same for every command whose output ends with one.
	 *
	 * The child's environment is, in order of precedence: the argument
	 * variables, the template's `env_vars`, and the inherited variables.
	 *
	 * @throws {RoveError} `status` when a command exits non-zero (`status` is
	 * the exit code, `body` everything the commands wrote; stdout and stderr
	 * are separate pipes, so lines from the two can interleave), `protocol_error` for
	 * output over `maxResponseBytes`, `transport_failed` when the shell cannot
	 * start or is killed, `decode_failed`, `unsupported_value`. An abort
	 * kills the process and rejects with the signal's reason.
	 */
	async call<TResult = string>(call: ToolCall<"cli", TResult, TVariables>, options: CallOptions = {}): Promise<TResult> {
		const template = this.#session.resolve(call, ["cli"]);
		const windows = process.platform === "win32";
		const shell: Shell = windows ? "powershell" : "bash";
		const script = buildScript(template.commands, call.args, shell, nonce(), call.tool);

		const inherited = template.inheritEnvVars ?? DEFAULT_INHERITED[windows ? "windows" : "unix"];
		const env: Record<string, string> = {};
		for (const name of inherited) {
			const value = this.#environment[name];
			if (value !== undefined) {
				env[name] = value;
			}
		}
		Object.assign(env, template.envVars, script.env);

		const [command, args] = windows
			? [
				"powershell.exe",
				["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", utf16Base64(script.source)],
			]
			: [existsSync("/bin/bash") ? "/bin/bash" : "bash", ["-c", script.source]];

		options.signal?.throwIfAborted();
		const { stdout, transcript, code } = await run(command, args, env, template.workingDir, this.#limit, call.tool, options.signal);

		if (code !== 0) {
			throw new RoveError(`tool ${call.tool} exited with status ${code}`, {
				code: "status",
				tool: call.tool,
				target: command,
				status: code,
				body: utf8(transcript).trim(),
			});
		}
		return decodeData(utf8(stdout).trim(), template.dataFormat, call.tool, command) as TResult;
	}
}

/** Sixteen hex digits from the platform's random source. */
function nonce(): string {
	return [...crypto.getRandomValues(new Uint8Array(8))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** What `-EncodedCommand` wants: base64 of the UTF-16LE text. */
function utf16Base64(text: string): string {
	const bytes = new Uint8Array(text.length * 2);
	for (let index = 0; index < text.length; index += 1) {
		const unit = text.charCodeAt(index);
		bytes[index * 2] = unit & 0xff;
		bytes[index * 2 + 1] = unit >> 8;
	}
	return base64Bytes(bytes);
}

function run(
	command: string,
	args: readonly string[],
	env: Readonly<Record<string, string>>,
	cwd: string | undefined,
	limit: number,
	tool: string,
	signal: AbortSignal | undefined
): Promise<{ stdout: Uint8Array; transcript: Uint8Array; code: number }> {
	return new Promise((resolve, reject) => {
		// Its own process group on Unix, so a kill reaches what the script
		// started, not only the shell: a `yes` left behind would hold the
		// pipe open and the call would never finish.
		const windows = process.platform === "win32";
		const child = spawn(command, args, { env, cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: !windows });
		const killTree = (): void => {
			if (child.pid === undefined || child.exitCode !== null) {
				return;
			}
			if (windows) {
				spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
			} else {
				try {
					process.kill(-child.pid, "SIGKILL");
				} catch {
					// The group is already gone.
				}
			}
			child.stdout.destroy();
			child.stderr.destroy();
		};
		const stdout: Uint8Array[] = [];
		// Both streams as they reach this process, for the error body, bounded
		// like the result. Two pipes, so their relative order is not guaranteed.
		const transcript: Uint8Array[] = [];
		let outBytes = 0;
		let transcriptBytes = 0;
		const record = (chunk: Uint8Array): void => {
			const room = limit - transcriptBytes;
			if (room > 0) {
				transcript.push(chunk.subarray(0, room));
				transcriptBytes += Math.min(room, chunk.byteLength);
			}
		};
		let settled = false;

		const settle = (outcome: () => void): void => {
			if (settled) {
				return;
			}
			settled = true;
			signal?.removeEventListener("abort", onAbort);
			outcome();
		};
		const onAbort = (): void => {
			killTree();
			settle(() => reject(signal?.reason));
		};
		signal?.addEventListener("abort", onAbort, { once: true });

		child.stdout.on("data", (chunk: Uint8Array) => {
			outBytes += chunk.byteLength;
			if (outBytes > limit) {
				killTree();
				settle(() => reject(tooLarge(limit, tool, command)));
				return;
			}
			stdout.push(chunk);
			record(chunk);
		});
		child.stderr.on("data", (chunk: Uint8Array) => {
			record(chunk);
		});
		child.on("error", (cause) => {
			settle(() => reject(new RoveError(`could not start ${command}`, { code: "transport_failed", tool, target: command, cause })));
		});
		child.on("close", (code, killedBy) => {
			if (code === null) {
				settle(() =>
					reject(new RoveError(`${command} was killed by ${killedBy ?? "a signal"}`, { code: "transport_failed", tool, target: command }))
				);
				return;
			}
			settle(() => resolve({ stdout: concat(stdout), transcript: concat(transcript), code }));
		});
	});
}
