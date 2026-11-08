import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import type { CliTemplate, ToolCall } from "../../src/call.js";
import { CliClient } from "../../src/protocols/cli.js";

// Argument values that would run a command, end a quoted string or expand
// something if they reached the script as text. Every one must come back
// byte for byte, in every quote context, and the sentinel file must never
// appear. Each payload names the sentinel through $SENTINEL, which the
// child's environment sets.

const PAYLOADS = [
	"\"; touch \"$SENTINEL\"; \"",
	"'; touch \"$SENTINEL\"; '",
	"$(touch \"$SENTINEL\")",
	"`touch \"$SENTINEL\"`",
	"a && touch \"$SENTINEL\"",
	"a | touch \"$SENTINEL\"",
	"a; touch \"$SENTINEL\"",
	"a\ntouch \"$SENTINEL\"",
	"a\r\ntouch \"$SENTINEL\"",
	"\\\"; touch \"$SENTINEL\"; \\\"",
	"${SENTINEL}",
	"$SENTINEL",
	"*",
	"~",
	"-n",
	"--",
	" leading and trailing ",
	"",
	"\u00e9\u2603 unicode",
	"'\"'\"'",
	"a'\\''b",
	"%PATH%",
	"!!",
	"$((1+1))",
	"#comment",
	"} 2>&1); touch \"$SENTINEL\"; x=$({",
];

const CONTEXTS = [
	{ name: "bare", command: "printf '%s' UTCP_ARG_value_UTCP_END", wrap: (value: string): string => value },
	{ name: "double-quoted", command: "printf '%s' \"<UTCP_ARG_value_UTCP_END>\"", wrap: (value: string): string => `<${value}>` },
	{ name: "single-quoted", command: "printf '%s' '<UTCP_ARG_value_UTCP_END>'", wrap: (value: string): string => `<${value}>` },
	{
		name: "double-quoted after an escaped quote",
		command: "printf '%s' \"\\\"UTCP_ARG_value_UTCP_END\\\"\"",
		wrap: (value: string): string => `"${value}"`,
	},
	{
		name: "single-quoted after a quote in the double-quoted string before it",
		command: "printf '%s' \"it's\" 'UTCP_ARG_value_UTCP_END'",
		wrap: (value: string): string => `it's${value}`,
	},
	{
		name: "twice in one command",
		command: "printf '%s|%s' UTCP_ARG_value_UTCP_END \"UTCP_ARG_value_UTCP_END\"",
		wrap: (value: string): string => `${value}|${value}`,
	},
];

if (process.platform !== "win32") {
	describe("cli arguments cannot inject into bash", () => {
		let dir: string;
		let sentinel: string;

		before(async () => {
			dir = await mkdtemp(join(tmpdir(), "rovebeetle-attack-"));
			sentinel = join(dir, "pwned");
		});

		after(async () => {
			await rm(dir, { recursive: true, force: true });
		});

		const client = new CliClient({ variables: {}, environment: process.env, maxResponseBytes: 65_536 });

		for (const context of CONTEXTS) {
			for (const payload of PAYLOADS) {
				test(`${context.name}: ${JSON.stringify(payload)} comes back exactly and runs nothing`, async () => {
					const template: CliTemplate = {
						commands: [{ command: context.command, appendToFinalOutput: true }],
						envVars: { SENTINEL: sentinel },
						dataFormat: "text",
					};
					const call: ToolCall<"cli", string> = { protocol: "cli", tool: "echo", template, args: { value: payload } };
					const output = await client.call(call);
					// The client trims the output, as the reference does.
					assert.equal(output, context.wrap(payload).trim());
					assert.equal(existsSync(sentinel), false, "the payload ran a command");
				});
			}
		}
	});
}
