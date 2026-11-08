import type { CliCommand } from "./call.js";
import { RoveError } from "./errors.js";

// Turns a `cli` template's commands into one shell script. Argument values
// never enter the script text: each placeholder becomes a reference to an
// environment variable with a per-call random name, written for the quote
// context it sits in, and the value travels in the child's environment. The
// shell has parsed the script before it expands the variable, so a value
// cannot add a command or end a quoted string. This is the reference
// implementation's design (GHSA-33p6-5jxp-p3x4), with each step's exit status
// checked, where the reference ignores it.

export type Shell = "bash" | "powershell";

/** A script and the environment entries its placeholders read. */
export interface Script {
	readonly source: string;
	readonly env: Readonly<Record<string, string>>;
}

const PLACEHOLDER = /UTCP_ARG_([a-zA-Z0-9_]+?)_UTCP_END/uy;

/**
 * The script for `commands`.
 *
 * Each step's stdout and stderr travel together (the reference captures them
 * together): a kept step's to the script's stdout, every other step's to its
 * stderr, as they are written, so the client's size limit applies to the
 * bytes as they arrive rather than to a variable growing inside the shell.
 * When a step exits non-zero the script exits with the same status. A step
 * is kept when `appendToFinalOutput` says so; the generator sets it for the
 * last step when the manual says nothing.
 *
 * | Shell | Placeholder bare | inside `"..."` | inside `'...'` |
 * | --- | --- | --- | --- |
 * | bash | `"$V"` | `${V}` | `'"$V"'` (close, quote, reopen) |
 * | PowerShell | `${env:V}` | `${env:V}` | refused: PowerShell does not expand there |
 *
 * Values that are strings are passed as written; anything else as JSON.
 *
 * @throws {RoveError} `unsupported_value` for an absent argument, a value
 * containing NUL, or a placeholder PowerShell cannot expand.
 */
export function buildScript(
	commands: readonly CliCommand[],
	args: Readonly<Record<string, unknown>>,
	shell: Shell,
	nonce: string,
	tool: string
): Script {
	const env: Record<string, string> = {};
	const variable = (name: string): string => {
		const value = args[name];
		if (value === undefined) {
			throw new RoveError(`argument ${name} is required by the command`, { code: "unsupported_value", tool });
		}
		const text = typeof value === "string" ? value : JSON.stringify(value);
		if (text.includes("\0")) {
			throw new RoveError(`argument ${name} contains NUL, which an environment variable cannot hold`, {
				code: "unsupported_value",
				tool,
			});
		}
		const key = `__UTCP_ARG_${nonce}_${name}`;
		env[key] = text;
		return key;
	};

	// Each step is a group closed on its own line, so the redirect covers
	// every command in it and a trailing comment cannot swallow it.
	const source =
		shell === "bash"
			? commands
				.flatMap((step) => [
					`{ ${substituteBash(step.command, variable)}\n} ${step.appendToFinalOutput ? "2>&1" : "1>&2"}`,
					"__rove_status=$?",
					"if [ \"$__rove_status\" -ne 0 ]; then exit \"$__rove_status\"; fi",
				])
				.join("\n")
			: [
				// Windows PowerShell writes redirected output in the console's
				// code page unless told otherwise; the client reads UTF-8.
				"[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
				"$OutputEncoding = [System.Text.Encoding]::UTF8",
				...commands.flatMap((step) => [
					"$global:LASTEXITCODE = 0",
					"$__rove_failed = $false",
					`try { & { ${substitutePowershell(step.command, variable, tool)}\n} 2>&1 | Out-String -Stream | ForEach-Object { [Console]::${step.appendToFinalOutput ? "Out" : "Error"}.WriteLine($_) } } catch { [Console]::Error.WriteLine($_); $__rove_failed = $true }`,
					"if ($__rove_failed) { exit 1 }",
					"if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }",
				]),
			].join("\n");

	return { source, env };
}

function substituteBash(command: string, variable: (name: string) => string): string {
	let out = "";
	let state: "normal" | "double" | "single" = "normal";

	for (let index = 0; index < command.length; ) {
		PLACEHOLDER.lastIndex = index;
		const match = PLACEHOLDER.exec(command);
		if (match !== null) {
			const key = variable(match[1] ?? "");
			out += state === "normal" ? `"$${key}"` : state === "double" ? `\${${key}}` : `'"$${key}"'`;
			index = PLACEHOLDER.lastIndex;
			continue;
		}

		const char = command[index] ?? "";
		const next = command[index + 1];
		if (state === "normal" && char === "\\" && next !== undefined) {
			out += char + next;
			index += 2;
			continue;
		}
		if (state === "double" && char === "\\" && next !== undefined && "\"\\$`\n".includes(next)) {
			out += char + next;
			index += 2;
			continue;
		}
		if (state === "normal" && char === "'") {
			state = "single";
		} else if (state === "normal" && char === "\"") {
			state = "double";
		} else if (state === "single" && char === "'") {
			state = "normal";
		} else if (state === "double" && char === "\"") {
			state = "normal";
		}
		out += char;
		index += 1;
	}
	return out;
}

function substitutePowershell(command: string, variable: (name: string) => string, tool: string): string {
	let out = "";
	let state: "normal" | "double" | "single" = "normal";

	for (let index = 0; index < command.length; ) {
		PLACEHOLDER.lastIndex = index;
		const match = PLACEHOLDER.exec(command);
		if (match !== null) {
			if (state === "single") {
				throw new RoveError(
					`UTCP_ARG_${match[1] ?? ""}_UTCP_END sits inside a single-quoted PowerShell string, where nothing is expanded; use double quotes`,
					{ code: "unsupported_value", tool }
				);
			}
			out += `\${env:${variable(match[1] ?? "")}}`;
			index = PLACEHOLDER.lastIndex;
			continue;
		}

		const char = command[index] ?? "";
		const next = command[index + 1];
		if (state !== "single" && char === "`" && next !== undefined) {
			out += char + next;
			index += 2;
			continue;
		}
		if (state === "single" && char === "'" && next === "'") {
			out += "''";
			index += 2;
			continue;
		}
		if (state === "normal" && char === "'") {
			state = "single";
		} else if (state === "normal" && char === "\"") {
			state = "double";
		} else if (state === "single" && char === "'") {
			state = "normal";
		} else if (state === "double" && char === "\"") {
			state = "normal";
		}
		out += char;
		index += 1;
	}
	return out;
}
