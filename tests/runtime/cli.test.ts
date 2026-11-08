import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import type { CliCommand, CliTemplate, ToolCall } from "../../src/call.js";
import { RoveError } from "../../src/errors.js";
import { DEFAULT_INHERITED } from "../../src/environment.js";
import { CliClient } from "../../src/protocols/cli.js";
import { buildScript } from "../../src/script.js";

function isCode(code: string): (error: unknown) => boolean {
	return (error) => error instanceof RoveError && error.code === code;
}

const step = (command: string, appendToFinalOutput = true): CliCommand => ({ command, appendToFinalOutput });

describe("building scripts", () => {
	test("bash placeholders become environment references for their quote context", () => {
		const { source, env } = buildScript(
			[step("a UTCP_ARG_x_UTCP_END \"b UTCP_ARG_x_UTCP_END\" 'c UTCP_ARG_x_UTCP_END'")],
			{ x: "v" },
			"bash",
			"n0",
			"t"
		);
		assert.match(source, /a "\$__UTCP_ARG_n0_x" "b \$\{__UTCP_ARG_n0_x\}" 'c '"\$__UTCP_ARG_n0_x"''/u);
		assert.deepEqual(env, { __UTCP_ARG_n0_x: "v" });
	});

	test("an escaped quote in bash does not change the quote context", () => {
		const { source } = buildScript([step("echo \\' UTCP_ARG_x_UTCP_END \"\\\" UTCP_ARG_x_UTCP_END\"")], { x: "v" }, "bash", "n", "t");
		assert.match(source, /echo \\' "\$__UTCP_ARG_n_x" "\\" \$\{__UTCP_ARG_n_x\}"/u);
	});

	test("PowerShell placeholders become ${env:...} bare and in double quotes", () => {
		const { source } = buildScript([step("Write-Output UTCP_ARG_x_UTCP_END \"in UTCP_ARG_x_UTCP_END\"")], { x: "v" }, "powershell", "n", "t");
		assert.match(source, /Write-Output \$\{env:__UTCP_ARG_n_x\} "in \$\{env:__UTCP_ARG_n_x\}"/u);
	});

	test("a PowerShell placeholder inside single quotes is refused, because nothing expands there", () => {
		assert.throws(() => buildScript([step("Write-Output 'UTCP_ARG_x_UTCP_END'")], { x: "v" }, "powershell", "n", "t"), isCode("unsupported_value"));
	});

	test("a doubled single quote stays inside a PowerShell string", () => {
		assert.throws(() => buildScript([step("Write-Output 'it''s UTCP_ARG_x_UTCP_END'")], { x: "v" }, "powershell", "n", "t"), isCode("unsupported_value"));
	});

	test("an argument name with underscores is read whole", () => {
		const { env } = buildScript([step("echo UTCP_ARG_user_id_UTCP_END")], { user_id: "u" }, "bash", "n", "t");
		assert.deepEqual(env, { __UTCP_ARG_n_user_id: "u" });
	});

	test("non-string values are passed as JSON", () => {
		const { env } = buildScript([step("echo UTCP_ARG_a_UTCP_END UTCP_ARG_b_UTCP_END UTCP_ARG_c_UTCP_END")], { a: 1, b: true, c: { k: [1] } }, "bash", "n", "t");
		assert.deepEqual(env, { __UTCP_ARG_n_a: "1", __UTCP_ARG_n_b: "true", __UTCP_ARG_n_c: "{\"k\":[1]}" });
	});

	test("an absent argument is refused rather than replaced with placeholder text", () => {
		assert.throws(() => buildScript([step("echo UTCP_ARG_x_UTCP_END")], {}, "bash", "n", "t"), isCode("unsupported_value"));
	});

	test("a value containing NUL is refused", () => {
		assert.throws(() => buildScript([step("echo UTCP_ARG_x_UTCP_END")], { x: "a\0b" }, "bash", "n", "t"), isCode("unsupported_value"));
	});

	test("argument values never appear in the script text", () => {
		const { source } = buildScript([step("echo UTCP_ARG_x_UTCP_END")], { x: "SECRET-VALUE" }, "bash", "n", "t");
		assert.equal(source.includes("SECRET-VALUE"), false);
	});
});

if (process.platform !== "win32") {
	describe("cli calls under bash", () => {
		let dir: string;

		before(async () => {
			dir = await realpath(await mkdtemp(join(tmpdir(), "rovebeetle-cli-")));
		});

		after(async () => {
			await rm(dir, { recursive: true, force: true });
		});

		function call<T = unknown>(commands: CliCommand[], overrides: Partial<CliTemplate> = {}, args: Record<string, unknown> = {}): ToolCall<"cli", T> {
			return { protocol: "cli", tool: "run", template: { commands, envVars: {}, dataFormat: "text", ...overrides }, args };
		}

		const environment = { PATH: process.env["PATH"], HOME: "/home/test", SECRET_TOKEN: "do-not-leak" };
		const client = (overrides: Partial<ConstructorParameters<typeof CliClient>[0]> = {}): CliClient<string> =>
			new CliClient<string>({ variables: { DIR: "/tmp" }, environment, maxResponseBytes: 4096, ...overrides });

		test("environment and maxResponseBytes are required", () => {
			assert.throws(() => new CliClient({ variables: {}, maxResponseBytes: 1 } as never), isCode("unsupported_value"));
			assert.throws(() => new CliClient({ variables: {}, environment: {} } as never), isCode("unsupported_value"));
		});

		test("the last command's output is the result, trimmed", async () => {
			assert.equal(await client().call(call([step("echo first", false), step("echo '  last  '")])), "last");
		});

		test("only the commands marked are kept, each on its own line", async () => {
			assert.equal(await client().call(call([step("echo a"), step("echo b", false), step("echo c")])), "a\nc");
		});

		test("stderr is part of a command's output, as the reference captures it", async () => {
			assert.equal(await client().call(call([step("echo out; echo err >&2")])), "out\nerr");
		});

		test("a command that is not kept has neither its stdout nor its stderr in the result", async () => {
			assert.equal(await client().call(call([step("echo hidden; echo hidden-err >&2", false), step("echo shown")])), "shown");
		});

		test("a trailing comment in a command does not break the script", async () => {
			assert.equal(await client().call(call([step("echo ok # a comment")])), "ok");
		});

		test("a failing command stops the script with its status and output", async () => {
			const result = client().call(call([step("echo before; exit 3"), step("echo never")]));
			await assert.rejects(result, (error: unknown) =>
				error instanceof RoveError && error.code === "status" && error.status === 3 && error.body === "before"
			);
		});

		test("the error body is everything the commands wrote, from both streams", async () => {
			const result = client().call(call([step("echo quiet", false), step("echo loud; echo boom >&2; exit 2")]));
			// stdout and stderr are two pipes, so only the content is fixed, not
			// the order the lines from the two arrive in.
			await assert.rejects(result, (error: unknown) =>
				error instanceof RoveError && error.status === 2 && (error.body ?? "").split("\n").sort().join(",") === "boom,loud,quiet"
			);
		});

		test("a failing command that is not kept still fails the call", async () => {
			await assert.rejects(client().call(call([step("false", false), step("echo fine")])), isCode("status"));
		});

		test("the default allowlist passes PATH and HOME and nothing else", async () => {
			const output = await client().call(call([step("echo \"$HOME|${SECRET_TOKEN-unset}\"; command -v printf >/dev/null && echo has-path")]));
			assert.equal(output, "/home/test|unset\nhas-path");
			assert.ok(DEFAULT_INHERITED.unix.includes("PATH"));
			assert.equal(DEFAULT_INHERITED.unix.includes("SECRET_TOKEN"), false);
		});

		test("an empty inherit list passes nothing from the environment", async () => {
			// bash puts in a default PATH of its own when none is inherited, so
			// the check is that the caller's PATH did not arrive.
			const output = await client().call(call<string>([step("echo \"${HOME-unset}|${SECRET_TOKEN-unset}|$PATH\"")], { inheritEnvVars: [] }));
			const [home, secret, path] = output.split("|");
			assert.equal(home, "unset");
			assert.equal(secret, "unset");
			assert.notEqual(path, environment.PATH);
		});

		test("an explicit inherit list passes exactly those variables", async () => {
			const output = await client().call(call([step("echo \"${SECRET_TOKEN-unset}|${HOME-unset}\"")], { inheritEnvVars: ["SECRET_TOKEN", "NOT_SET"] }));
			assert.equal(output, "do-not-leak|unset");
		});

		test("env_vars override inherited values, and variables in them are filled", async () => {
			const output = await client().call(call([step("echo \"$HOME\"")], { envVars: { HOME: "${DIR}/override" } }));
			assert.equal(output, "/tmp/override");
		});

		test("the working directory is honoured", async () => {
			assert.equal(await client().call(call([step("pwd")], { workingDir: dir })), dir);
		});

		test("json output is parsed and text output kept", async () => {
			assert.deepEqual(await client().call(call([step("echo '{\"a\": [1]}'")], { dataFormat: "json" })), { a: [1] });
			assert.equal(await client().call(call([step("echo 123")], { dataFormat: "text" })), "123");
			assert.equal(await client().call(call([step("echo 123")], { dataFormat: "auto" })), 123);
		});

		test("json output that is not JSON is decode_failed", async () => {
			await assert.rejects(client().call(call([step("echo nope")], { dataFormat: "json" })), isCode("decode_failed"));
		});

		test("output over maxResponseBytes kills the command and fails", async () => {
			await assert.rejects(client({ maxResponseBytes: 100 }).call(call([step("yes")])), isCode("protocol_error"));
		});

		test("aborting kills the command and rejects with the caller's reason", async () => {
			const reason = new Error("stop");
			const controller = new AbortController();
			const pending = client().call(call([step("sleep 30")]), { signal: controller.signal });
			setTimeout(() => controller.abort(reason), 50);
			await assert.rejects(pending, (error) => error === reason);
		});

		test("a missing working directory fails to start", async () => {
			await assert.rejects(client().call(call([step("true")], { workingDir: join(dir, "missing") })), isCode("transport_failed"));
		});
	});
}
