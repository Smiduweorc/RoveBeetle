import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, describe, test } from "node:test";

import { compileGenerated } from "../../tools/compile.js";
import type { GeneratorConfig } from "../../tools/generator/config.js";
import { emitTools } from "../../tools/generator/emit.js";
import { readManual } from "../../tools/generator/manual.js";
import { plan } from "../../tools/generator/plan.js";
import { emitSchema } from "../../tools/generator/schema.js";

// The manual may come from a server nobody here controls, and its strings end
// up in generated TypeScript. Each payload below would run code, end a string
// or close a comment if it were interpolated. Every one goes into every
// manual string that reaches the output; the output must compile, import
// without running anything, and carry each payload back byte for byte.

const PAYLOADS = [
	"*/ globalThis.__pwned = true; /*",
	"\"; globalThis.__pwned = true; \"",
	"'; globalThis.__pwned = true; '",
	"`; globalThis.__pwned = true; `",
	"${globalThis.__pwned = true}",
	"</script><script>globalThis.__pwned = true</script>",
	"\\\"; globalThis.__pwned = true; //",
	"line\nglobalThis.__pwned = true;",
	"line\u2028globalThis.__pwned = true;",
	"\u0000nul",
	"\" + (globalThis.__pwned = true) + \"",
	"// globalThis.__pwned = true",
];

/** A manual using `payload` everywhere a manual string can reach the output. */
function manual(payload: string, index: number): unknown {
	return {
		utcp_version: "1.1.0",
		tools: [
			{
				name: `tool_${index}`,
				description: payload,
				inputs: {
					type: "object",
					description: payload,
					properties: { [payload]: { type: "string", description: payload, enum: [payload] }, plain: { type: "string", title: payload } },
				},
				outputs: { type: "object", description: payload, properties: { value: { type: "string", default: payload, examples: [payload] } } },
				tool_call_template: {
					call_template_type: "http",
					url: `https://api.example.com/${encodeURIComponent(payload)}`,
					// Header values with a line break are refused on their own;
					// the rest of the payloads go in.
					headers: /[\r\n\0]/u.test(payload) ? {} : { "x-payload": payload },
					content_type: `text/${encodeURIComponent(payload)}`,
				},
			},
			{
				name: `text_${index}`,
				description: payload,
				tool_call_template: { call_template_type: "text", content: payload },
			},
			{
				// The name itself carries the payload; the function name is
				// built from its letters and digits only.
				name: `named_${index} ${payload}`,
				tool_call_template: { call_template_type: "text", content: "named" },
			},
			{
				name: `cli_${index}`,
				description: payload,
				tool_call_template: { call_template_type: "cli", commands: [{ command: payload }], env_vars: { PAYLOAD: payload } },
			},
		],
	};
}

const config: GeneratorConfig = { manual: "attack.json", protocols: ["http", "text", "cli"] };

describe("manual strings cannot inject into generated code", () => {
	let directory: string;

	before(async () => {
		directory = await mkdtemp(join(tmpdir(), "rove-beetle-attack-"));
	});

	after(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	for (const [index, payload] of PAYLOADS.entries()) {
		test(`${JSON.stringify(payload)} compiles, runs nothing, and comes back exactly`, async () => {
			const tools = readManual(manual(payload, index), "attack.json");
			const planned = plan(tools, config, undefined);
			const files = new Map([["schema.ts", await emitSchema(planned, payload)], ...[...emitTools(planned, payload)].map(([name, source]): [string, string] => [`tools/${name}`, source])]);

			const compiled = await compileGenerated(files);
			assert.equal(compiled.ok, true, compiled.errors);

			// Import the generated modules for real: types are erased, so this
			// runs exactly the code a consumer would.
			const out = join(directory, String(index));
			await mkdir(join(out, "tools"), { recursive: true });
			for (const [name, source] of files) {
				await writeFile(join(out, name), source, "utf8");
			}
			await writeFile(join(out, "call.ts"), "export {};\n", "utf8");

			delete (globalThis as { __pwned?: unknown }).__pwned;
			const http = (await import(pathToFileURL(join(out, "tools", "http.ts")).href)) as Record<string, (args: object) => { tool: string; template: Record<string, unknown> }>;
			const text = (await import(pathToFileURL(join(out, "tools", "text.ts")).href)) as Record<string, () => { template: { content: string } }>;
			const cli = (await import(pathToFileURL(join(out, "tools", "cli.ts")).href)) as Record<string, () => { template: { commands: { command: string }[]; envVars: Record<string, string> } }>;
			assert.equal((globalThis as { __pwned?: unknown }).__pwned, undefined, "importing ran injected code");

			const httpCall = Object.values(http)[0]?.({});
			assert.equal(httpCall?.tool, `tool_${index}`);
			assert.equal(httpCall?.template["url"], `https://api.example.com/${encodeURIComponent(payload)}`);
			if (!/[\r\n\0]/u.test(payload)) {
				assert.deepEqual(httpCall?.template["headers"], { "x-payload": payload });
			}
			const texts = Object.values(text).map((build) => build() as unknown as { tool: string; template: { content: string } });
			assert.deepEqual(texts.map((call) => call.template.content).sort(), ["named", payload].sort());
			assert.ok(texts.some((call) => call.tool === `named_${index} ${payload}`), "the tool name came back exactly");
			const cliCall = Object.values(cli)[0]?.();
			assert.equal(cliCall?.template.commands[0]?.command, payload);
			assert.deepEqual(cliCall?.template.envVars, { PAYLOAD: payload });
			assert.equal((globalThis as { __pwned?: unknown }).__pwned, undefined, "calling ran injected code");
		});
	}
});
