import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import type { CliCommand, CliTemplate, ToolCall } from "../../src/call.js";
import { RoveError } from "../../src/errors.js";
import { CliClient } from "../../src/protocols/cli.js";

// The `cli` client on Windows, where it runs PowerShell. Registered only on
// Windows, where CI runs it; the script it builds is unit-tested everywhere
// in cli.test.ts.

const step = (command: string, appendToFinalOutput = true): CliCommand => ({ command, appendToFinalOutput });

function call<T = string>(commands: CliCommand[], overrides: Partial<CliTemplate> = {}, args: Record<string, unknown> = {}): ToolCall<"cli", T> {
	return { protocol: "cli", tool: "run", template: { commands, envVars: {}, dataFormat: "text", ...overrides }, args };
}

const PAYLOADS = [
	"\"; New-Item -Path $env:SENTINEL; \"",
	"'; New-Item -Path $env:SENTINEL; '",
	"$(New-Item -Path $env:SENTINEL)",
	"`$(New-Item -Path $env:SENTINEL)",
	"a; New-Item -Path $env:SENTINEL",
	"a | New-Item -Path $env:SENTINEL",
	"${env:SENTINEL}",
	"@(1,2)",
	"%PATH%",
	"\u00e9\u2603 unicode",
];

if (process.platform === "win32") {
	describe("cli calls under PowerShell", () => {
		let dir: string;
		let sentinel: string;

		before(async () => {
			dir = await mkdtemp(join(tmpdir(), "rovebeetle-ps-"));
			sentinel = join(dir, "pwned.txt");
		});

		after(async () => {
			await rm(dir, { recursive: true, force: true });
		});

		const client = new CliClient({ variables: {}, environment: process.env, maxResponseBytes: 65_536 });

		test("the last command's output is the result, trimmed", async () => {
			assert.equal(await client.call(call([step("Write-Output first", false), step("Write-Output last")])), "last");
		});

		test("a native command that exits non-zero fails with its status", async () => {
			await assert.rejects(client.call(call([step("cmd /c exit 4")])), (error: unknown) => error instanceof RoveError && error.code === "status" && error.status === 4);
		});

		test("a failing cmdlet fails the call", async () => {
			await assert.rejects(client.call(call([step("Get-Item -Path C:\\does-not-exist-rovebeetle -ErrorAction Stop")])), (error: unknown) =>
				error instanceof RoveError && error.code === "status"
			);
		});

		test("output is read as UTF-8", async () => {
			assert.equal(await client.call(call([step("Write-Output \"\u00e9\u2603\"")])), "\u00e9\u2603");
		});

		test("the default allowlist passes PATH and nothing secret", async () => {
			const secretClient = new CliClient({ variables: {}, environment: { ...process.env, ROVE_SECRET: "leak" }, maxResponseBytes: 4096 });
			assert.equal(await secretClient.call(call([step("if ($env:ROVE_SECRET) { 'leaked' } else { 'clean' }")])), "clean");
		});

		for (const payload of PAYLOADS) {
			for (const [name, command, wrap] of [
				["bare", "Write-Output UTCP_ARG_value_UTCP_END", (value: string): string => value],
				["double-quoted", "Write-Output \"<UTCP_ARG_value_UTCP_END>\"", (value: string): string => `<${value}>`],
			] as const) {
				test(`${name}: ${JSON.stringify(payload)} comes back exactly and runs nothing`, async () => {
					const output = await client.call(call([step(command)], { envVars: { SENTINEL: sentinel } }, { value: payload }));
					assert.equal(output, wrap(payload).trim());
					assert.equal(existsSync(sentinel), false, "the payload ran a command");
				});
			}
		}
	});
}
