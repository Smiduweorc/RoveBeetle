import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, describe, test } from "node:test";

import { compileGenerated } from "../../tools/compile.js";
import type { GeneratorConfig } from "../../tools/generator/config.js";
import { comment, emitTools, literal } from "../../tools/generator/emit.js";
import { readManual } from "../../tools/generator/manual.js";
import { plan, type Plan } from "../../tools/generator/plan.js";
import { components, emitSchema, SchemaError } from "../../tools/generator/schema.js";

/** One tool for each protocol, so the whole emitter is compiled at once. */
const EVERY_PROTOCOL = {
	utcp_version: "1.1.0",
	tools: [
		{
			name: "get_user",
			inputs: { type: "object", properties: { id: { type: "string" }, verbose: { type: "boolean" } } },
			outputs: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
			tool_call_template: { call_template_type: "http", url: "https://api.example.com/users/{id}", auth: { auth_type: "api_key", api_key: "${API_KEY}" } },
		},
		{
			name: "watch",
			outputs: { type: "array", items: { type: "integer" } },
			tool_call_template: { call_template_type: "sse", url: "https://api.example.com/watch" },
		},
		{ name: "export_rows", tool_call_template: { call_template_type: "streamable_http", url: "https://api.example.com/export" } },
		{
			name: "user",
			inputs: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
			outputs: { type: "object", properties: { user: { type: ["object", "null"] } } },
			tool_call_template: { call_template_type: "graphql", url: "https://api.example.com/graphql", query: "query U($id: ID!) { user(id: $id) { name } }" },
		},
		{
			name: "ask",
			inputs: { type: "object", properties: { q: { type: "string" } } },
			tool_call_template: { call_template_type: "websocket", url: "wss://api.example.com/ws", message: { q: "UTCP_ARG_q_UTCP_ARG" }, response_format: "text" },
		},
		{ name: "lookup", tool_call_template: { call_template_type: "tcp", host: "${HOST}", port: 7000, framing_strategy: "delimiter", message_delimiter: "\\n" } },
		{ name: "ping", tool_call_template: { call_template_type: "udp", host: "127.0.0.1", port: 7001, response_byte_format: null } },
		{
			name: "files.read",
			inputs: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
			outputs: { type: "object", properties: { result: { type: "array", items: { type: "string" } } }, "x-fastmcp-wrap-result": true },
			tool_call_template: { call_template_type: "mcp", config: { mcpServers: { files: { command: "node", args: ["server.js"] } } } },
		},
		{
			name: "list_dir",
			inputs: { type: "object", properties: { dir: { type: "string" } } },
			outputs: { type: "string" },
			tool_call_template: { call_template_type: "cli", commands: [{ command: "ls UTCP_ARG_dir_UTCP_END" }], env_vars: { TOKEN: "${CLI_TOKEN}" } },
		},
		{ name: "motd", tool_call_template: { call_template_type: "text", content: "hello" } },
		{ name: "read_notes", tool_call_template: { call_template_type: "file", file_path: "notes.txt" } },
	],
};

const ALL: GeneratorConfig = { manual: "every.json", protocols: ["http", "sse", "streamable_http", "graphql", "websocket", "tcp", "udp", "mcp", "cli", "text", "file"] };

async function files(planned: Plan): Promise<Map<string, string>> {
	return new Map([["schema.ts", await emitSchema(planned, "every.json")], ...[...emitTools(planned, "every.json")].map(([name, source]): [string, string] => [`tools/${name}`, source])]);
}

describe("object literals", () => {
	test("identifier keys are bare, others quoted, and strings go through JSON", () => {
		assert.equal(literal({ a: 1, "b-c": "x\"y", $d: null }, ""), "{\n\ta: 1,\n\t\"b-c\": \"x\\\"y\",\n\t$d: null,\n}");
	});

	test("short lists of scalars sit on one line and long or nested ones do not", () => {
		assert.equal(literal(["a", 1], ""), "[\"a\", 1]");
		assert.equal(literal([], ""), "[]");
		assert.equal(literal([{ a: 1 }], ""), "[\n\t{\n\t\ta: 1,\n\t},\n]");
		assert.equal(literal(["x".repeat(70)], "").includes("\n"), true);
	});

	test("undefined fields are left out and empty objects stay empty", () => {
		assert.equal(literal({ a: undefined, b: {} }, ""), "{\n\tb: {},\n}");
	});
});

describe("comments", () => {
	test("a comment cannot be closed or broken by its text", () => {
		assert.equal(comment("a */ b\nc\r\nd\u2028e"), "a *\\/ b c  d e");
	});
});

describe("schemas", () => {
	const plannedWith = (outputs: Record<string, unknown>): Plan =>
		plan(readManual({ utcp_version: "1", tools: [{ name: "t", outputs, tool_call_template: { call_template_type: "http", url: "https://a" } }] }, "m"), { manual: "m", protocols: ["http"] }, undefined);

	test("$defs and definitions are lifted into components of their own and their refs follow", () => {
		const schemas = components(
			plannedWith({ type: "object", properties: { a: { $ref: "#/$defs/x" }, b: { $ref: "#/definitions/y/properties/z" } }, $defs: { x: { type: "string" } }, definitions: { y: { type: "object" } } })
		);
		assert.deepEqual(schemas["TResult"], {
			type: "object",
			properties: { a: { $ref: "#/components/schemas/TResult__x" }, b: { $ref: "#/components/schemas/TResult__y/properties/z" } },
		});
		assert.deepEqual(schemas["TResult__x"], { type: "string" });
	});

	test("a reference to the schema's own root points at its component", () => {
		const schemas = components(plannedWith({ type: "object", properties: { child: { $ref: "#" } } }));
		assert.deepEqual(schemas["TResult"], { type: "object", properties: { child: { $ref: "#/components/schemas/TResult" } } });
	});

	test("a reference outside the manual is refused", () => {
		assert.throws(() => components(plannedWith({ $ref: "https://schemas.example.com/user.json" })), SchemaError);
	});

	test("$id and $schema are dropped, so relative references are not rebased against a URL", () => {
		const schemas = components(plannedWith({ $id: "https://x/s", $schema: "https://json-schema.org/draft/2020-12/schema", type: "string" }));
		assert.deepEqual(schemas["TResult"], { type: "string" });
	});

	test("a recursive schema compiles", async () => {
		const planned = plannedWith({ type: "object", properties: { child: { $ref: "#" }, name: { type: "string" } } });
		const compiled = await compileGenerated(await files(planned));
		assert.equal(compiled.ok, true, compiled.errors);
	});
});

describe("generated modules", () => {
	let directory: string;

	before(async () => {
		directory = await mkdtemp(join(tmpdir(), "rove-beetle-emit-"));
	});

	after(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	test("a manual with every protocol compiles for a browser consumer", async () => {
		const compiled = await compileGenerated(await files(plan(readManual(EVERY_PROTOCOL, "every.json"), ALL, undefined)));
		assert.equal(compiled.ok, true, compiled.errors);
	});

	test("each module is named for its protocol's subpath", async () => {
		const names = [...emitTools(plan(readManual(EVERY_PROTOCOL, "every.json"), ALL, undefined), "every.json").keys()].sort();
		assert.deepEqual(names, ["cli.ts", "file.ts", "graphql.ts", "http.ts", "mcp.ts", "sse.ts", "streamable-http.ts", "tcp.ts", "text.ts", "udp.ts", "websocket.ts"]);
	});

	test("the types are the ones a caller relies on", async () => {
		const planned = plan(readManual(EVERY_PROTOCOL, "every.json"), ALL, undefined);
		const generated = await files(planned);
		generated.set(
			"check.ts",
			[
				"import type { ResultOf, ToolCall } from \"./call.js\";",
				"import { getUser } from \"./tools/http.js\";",
				"import { lookup } from \"./tools/tcp.js\";",
				"import { ping } from \"./tools/udp.js\";",
				"import { filesRead } from \"./tools/mcp.js\";",
				"import { listDir } from \"./tools/cli.js\";",
				"import { ask } from \"./tools/websocket.js\";",
				"import { motd } from \"./tools/text.js\";",
				"",
				"const user: ToolCall<\"http\", { readonly name: string }, \"API_KEY\"> = getUser({ id: \"1\" });",
				"const name: string = (null as unknown as ResultOf<typeof user>).name;",
				"const tcp: ToolCall<\"tcp\", string, \"HOST\"> = lookup();",
				"const bytes: Uint8Array = null as unknown as ResultOf<ReturnType<typeof ping>>;",
				"const files: readonly string[] = null as unknown as ResultOf<ReturnType<typeof filesRead>>;",
				"const listing: string = null as unknown as ResultOf<ReturnType<typeof listDir>>;",
				"const reply: string = null as unknown as ResultOf<ReturnType<typeof ask>>;",
				"const text: string = null as unknown as ResultOf<ReturnType<typeof motd>>;",
				"export const used = [user, name, tcp, bytes, files, listing, reply, text, filesRead({ path: \"/\" }), listDir({ dir: \".\" })];",
			].join("\n")
		);
		const compiled = await compileGenerated(generated);
		assert.equal(compiled.ok, true, compiled.errors);
	});

	for (const [label, line] of [
		["a missing path argument", "import { getUser } from \"./tools/http.js\";\nexport const bad = getUser({});"],
		["an argument the tool does not take", "import { getUser } from \"./tools/http.js\";\nexport const bad = getUser({ id: \"1\", nope: 1 });"],
		["a missing placeholder argument", "import { listDir } from \"./tools/cli.js\";\nexport const bad = listDir({});"],
		["the wrong argument type", "import { getUser } from \"./tools/http.js\";\nexport const bad = getUser({ id: 1 });"],
	] as const) {
		test(`${label} does not compile`, async () => {
			const generated = await files(plan(readManual(EVERY_PROTOCOL, "every.json"), ALL, undefined));
			generated.set("check.ts", line);
			const compiled = await compileGenerated(generated);
			assert.equal(compiled.ok, false, `${label} compiled`);
			assert.match(compiled.errors, /check\.ts/u);
		});
	}

	test("every emitted template is exactly the template the manual reader produced", async () => {
		const tools = readManual(EVERY_PROTOCOL, "every.json");
		const planned = plan(tools, ALL, undefined);
		const generated = await files(planned);
		await mkdir(join(directory, "tools"), { recursive: true });
		for (const [name, source] of generated) {
			await writeFile(join(directory, name), source, "utf8");
		}
		await writeFile(join(directory, "call.ts"), "export {};\n", "utf8");

		for (const tool of planned.tools) {
			const file = join(directory, "tools", `${tool.tool.protocol === "streamable_http" ? "streamable-http" : tool.tool.protocol}.ts`);
			const module = (await import(pathToFileURL(file).href)) as Record<string, (args?: object) => { protocol: string; tool: string; template: unknown; args: unknown }>;
			const built = module[tool.name]?.({ id: "x", path: "/", dir: "." });
			assert.equal(built?.protocol, tool.tool.protocol, tool.name);
			assert.equal(built?.tool, tool.tool.name);
			assert.deepEqual(built?.template, tool.tool.template, tool.name);
		}
	});

	test("a tool with no required arguments can be called without any", async () => {
		const source = emitTools(plan(readManual(EVERY_PROTOCOL, "every.json"), ALL, undefined), "every.json").get("text.ts") ?? "";
		assert.match(source, /export function motd\(args: MotdArgs = \{\}\)/u);
	});

	test("doc comments carry the description, how to send it, variables, auth and the manual's unapplied numbers", () => {
		const source = emitTools(plan(readManual(EVERY_PROTOCOL, "every.json"), ALL, undefined), "every.json");
		assert.match(source.get("http.ts") ?? "", /`get_user` over http\. Send it with `HttpClient\.call\(\)`\.\n \* Needs the variables `API_KEY`\.\n \* Auth: an api key in the header "X-Api-Key"\./u);
		assert.match(source.get("sse.ts") ?? "", /Send it with `SseClient\.stream\(\)`/u);
		assert.match(source.get("websocket.ts") ?? "", /`WebSocketClient\.call\(\)` or `WebSocketClient\.stream\(\)`/u);
		assert.match(source.get("tcp.ts") ?? "", /timeout to 30000 ms/u);
	});
});

describe("scale", () => {
	test("a manual of 2,000 tools, the ceiling the architecture is sized for, generates and compiles", async () => {
		const tools = Array.from({ length: 2000 }, (_, index) => ({
			name: `tool_${index}`,
			inputs: { type: "object", properties: { id: { type: "string" }, limit: { type: "integer" } }, required: ["id"] },
			outputs: { type: "object", properties: { items: { type: "array", items: { type: "object", properties: { n: { type: "number" } } } } } },
			tool_call_template: { call_template_type: "http", url: `https://api.example.com/t${index}/{id}` },
		}));
		const planned = plan(readManual({ utcp_version: "1", tools }, "big.json"), { manual: "big.json", protocols: ["http"] }, undefined);
		assert.equal(planned.tools.length, 2000);
		const compiled = await compileGenerated(await files(planned));
		assert.equal(compiled.ok, true, compiled.errors);
	});
});
