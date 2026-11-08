import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { checkConfig, ConfigError, type GeneratorConfig } from "../../tools/generator/config.js";
import { readManual, type ManualTool } from "../../tools/generator/manual.js";
import { functionName, typeStem } from "../../tools/generator/names.js";
import { plan, PlanError } from "../../tools/generator/plan.js";

function tools(...list: Record<string, unknown>[]): ManualTool[] {
	return readManual({ utcp_version: "1.1", tools: list }, "m.json");
}

const http = (name: string, extra: Record<string, unknown> = {}, template: Record<string, unknown> = {}): Record<string, unknown> => ({
	name,
	inputs: { type: "object", properties: { id: { type: "string" } } },
	tool_call_template: { call_template_type: "http", url: "https://a.example.com/x", ...template },
	...extra,
});

const config = (overrides: Partial<GeneratorConfig> = {}): GeneratorConfig => ({ manual: "m.json", protocols: ["http"], ...overrides });

function planError(run: () => unknown, ...patterns: RegExp[]): void {
	assert.throws(run, (error: unknown) => {
		assert.ok(error instanceof PlanError, String(error));
		for (const pattern of patterns) {
			assert.match(error.message, pattern);
		}
		return true;
	});
}

describe("the config", () => {
	const check = (value: unknown): GeneratorConfig => checkConfig(value, "rovebeetle.config.ts");
	const refused = (value: unknown, pattern: RegExp): void => {
		assert.throws(() => check(value), (error: unknown) => error instanceof ConfigError && pattern.test(error.message));
	};

	test("manual and protocols are all a config needs", () => {
		assert.deepEqual(check({ manual: "./m.json", protocols: ["http"] }), { manual: "./m.json", protocols: ["http"] });
	});

	test("a misspelled key is an error naming it", () => {
		refused({ manual: "m", protocols: ["http"], protocol: ["cli"] }, /`protocol` is not a config key/u);
	});

	test("protocols is required, non-empty, known and without duplicates", () => {
		refused({ manual: "m" }, /`protocols` is required/u);
		refused({ manual: "m", protocols: [] }, /`protocols` is required/u);
		refused({ manual: "m", protocols: ["https"] }, /has "https"/u);
		refused({ manual: "m", protocols: ["http", "http"] }, /twice/u);
	});

	test("manual is required and must be a path, a URL or a call template", () => {
		refused({ protocols: ["http"] }, /`manual` is required/u);
		refused({ manual: "", protocols: ["http"] }, /`manual` is empty/u);
		refused({ manual: 5, protocols: ["http"] }, /`manual` is required/u);
	});

	test("a ${VAR} in a manual call template is refused, pointing at process.env", () => {
		refused({ manual: { call_template_type: "http", url: "https://a", headers: { authorization: "Bearer ${TOKEN}" } }, protocols: ["http"] }, /process\.env\["TOKEN"\]/u);
	});

	test("a cli manual source may use $ in its commands, which the shell owns", () => {
		assert.doesNotThrow(() => check({ manual: { call_template_type: "cli", commands: [{ command: "cat $HOME/manual.json" }] }, protocols: ["cli"] }));
	});

	test("names must be usable function names", () => {
		refused({ manual: "m", protocols: ["http"], names: { a: "2fast" } }, /not a usable function name/u);
		refused({ manual: "m", protocols: ["http"], names: { a: "delete" } }, /not a usable function name/u);
		refused({ manual: "m", protocols: ["http"], names: { a: 5 } }, /not a usable function name/u);
	});

	test("skip must be a list of names", () => {
		refused({ manual: "m", protocols: ["http"], skip: "a" }, /`skip` must be a list/u);
	});

	test("graphql.depth must be a whole number of at least 1, and nothing else may sit under graphql", () => {
		refused({ manual: "m", protocols: ["graphql"], graphql: { depth: 0 } }, /at least 1/u);
		refused({ manual: "m", protocols: ["graphql"], graphql: { depth: 1.5 } }, /at least 1/u);
		refused({ manual: "m", protocols: ["graphql"], graphql: { depth: 2, limit: 3 } }, /graphql\.limit/u);
		assert.doesNotThrow(() => check({ manual: "m", protocols: ["graphql"], graphql: { depth: 2 } }));
	});

	test("a default export that is not an object is refused", () => {
		refused(undefined, /must export a default object/u);
		refused([], /must export a default object/u);
	});
});

describe("names", () => {
	for (const [tool, name] of [
		["get_forecast", "getForecast"],
		["weather.get_forecast", "weatherGetForecast"],
		["getHTTPStatus", "getHttpStatus"],
		["list-users", "listUsers"],
		["3d_render", "_3dRender"],
		["UPPER", "upper"],
	] as const) {
		test(`${tool} becomes ${name}`, () => {
			assert.equal(functionName(tool), name);
		});
	}

	test("a name with no letters or digits, or one that builds a reserved word, gives none", () => {
		assert.equal(functionName("..."), undefined);
		assert.equal(functionName("delete"), undefined);
		assert.equal(functionName("new"), undefined);
	});

	test("type stems capitalise and drop the digit guard", () => {
		assert.equal(typeStem("getForecast"), "GetForecast");
		assert.equal(typeStem("_3dRender"), "3dRender");
	});
});

describe("planning", () => {
	test("a tool whose protocol is not allowed stops the run, with a skip block to paste", () => {
		const list = tools(http("a"), { name: "run", tool_call_template: { call_template_type: "cli", commands: [{ command: "ls" }] } });
		planError(() => plan(list, config(), undefined), /1 tool uses cli, which `protocols` does not allow/u, /skip: \["run"\]/u);
	});

	test("skipping the tool lets the run go on", () => {
		const list = tools(http("a"), { name: "run", tool_call_template: { call_template_type: "cli", commands: [{ command: "ls" }] } });
		assert.deepEqual(plan(list, config({ skip: ["run"] }), undefined).tools.map((tool) => tool.name), ["a"]);
	});

	test("a protocol listed that no tool uses is an error", () => {
		planError(() => plan(tools(http("a")), config({ protocols: ["http", "cli"] }), undefined), /lists cli, which no tool uses/u);
	});

	test("the protocol a manual is discovered over must be listed, and counts as used", () => {
		planError(() => plan(tools(http("a")), config(), "cli"), /discovered over cli/u);
		assert.deepEqual(plan(tools(http("a")), config({ protocols: ["http", "cli"] }), "cli").protocols, ["http"]);
	});

	test("skip and names must refer to tools the manual has", () => {
		planError(() => plan(tools(http("a")), config({ skip: ["b"] }), undefined), /skip lists "b"/u);
		planError(() => plan(tools(http("a")), config({ names: { b: "bee" } }), undefined), /names renames "b"/u);
	});

	test("two tools wanting one name stop the run with a block to paste under names", () => {
		planError(() => plan(tools(http("get_user"), http("getUser")), config(), undefined), /"get_user": "getUser",\n {2}"getUser": "getUser",/u);
	});

	test("names settles a collision", () => {
		const planned = plan(tools(http("get_user"), http("getUser")), config({ names: { getUser: "getUserById" } }), undefined);
		assert.deepEqual(planned.tools.map((tool) => tool.name), ["getUser", "getUserById"]);
	});

	test("a tool name that gives no function name asks for one under names", () => {
		planError(() => plan(tools(http("delete")), config(), undefined), /name it under `names`/u);
		assert.equal(plan(tools(http("delete")), config({ names: { delete: "deleteItem" } }), undefined).tools[0]?.name, "deleteItem");
	});

	test("arguments a template places in the path become required", () => {
		const [planned] = plan(tools(http("a", {}, { url: "https://a.example.com/{id}" })), config(), undefined).tools;
		assert.deepEqual(planned?.args["required"], ["id"]);
		assert.equal(planned?.argsRequired, true);
	});

	test("an argument a template places that the inputs do not declare is refused", () => {
		planError(() => plan(tools(http("a", {}, { url: "https://a.example.com/{nope}" })), config(), undefined), /uses argument "nope"/u);
	});

	test("cli placeholders become required too", () => {
		const list = tools({
			name: "run",
			inputs: { type: "object", properties: { path: { type: "string" } } },
			tool_call_template: { call_template_type: "cli", commands: [{ command: "cat UTCP_ARG_path_UTCP_END" }] },
		});
		assert.deepEqual(plan(list, config({ protocols: ["cli"] }), undefined).tools[0]?.args["required"], ["path"]);
	});

	test("a tool with no inputs takes an optional, empty argument object", () => {
		const [planned] = plan(tools({ name: "ping", tool_call_template: { call_template_type: "http", url: "https://a" } }), config(), undefined).tools;
		assert.deepEqual(planned?.args, { type: "object", properties: {} });
		assert.equal(planned?.argsRequired, false);
	});

	test("variables are collected from every substituted field, sorted, once each", () => {
		const [planned] = plan(
			tools(http("a", {}, { url: "https://${HOST}/x", headers: { "x-b": "$B_TOKEN" }, auth: { auth_type: "basic", username: "$USER", password: "${PASS}" } })),
			config(),
			undefined
		).tools;
		assert.deepEqual(planned?.variables, ["B_TOKEN", "HOST", "PASS", "USER"]);
	});

	test("a secret written into the manual is a warning, and a variable is not", () => {
		const warned = plan(tools(http("a", {}, { auth: { auth_type: "api_key", api_key: "sk_live_123" } })), config(), undefined).warnings;
		assert.match(warned[0] ?? "", /a: auth\.api_key is written in the manual/u);
		assert.deepEqual(plan(tools(http("a", {}, { auth: { auth_type: "api_key", api_key: "${KEY}" } })), config(), undefined).warnings, []);
	});

	test("result shapes follow the protocol", () => {
		const list = tools(
			http("a", { outputs: { type: "object" } }),
			{ name: "b", outputs: { type: "array", items: { type: "integer" } }, tool_call_template: { call_template_type: "sse", url: "https://a" } },
			{ name: "c", tool_call_template: { call_template_type: "tcp", host: "h", port: 1, response_byte_format: null } },
			{ name: "d", tool_call_template: { call_template_type: "text", content: "x" } },
			{ name: "e", outputs: { type: "object" }, tool_call_template: { call_template_type: "websocket", url: "wss://a" } }
		);
		const planned = plan(list, config({ protocols: ["http", "sse", "tcp", "text", "websocket"] }), undefined).tools;
		assert.deepEqual(
			planned.map((tool) => [tool.name, tool.result, tool.methods]),
			[
				["a", { kind: "schema", schema: { type: "object" } }, ["call"]],
				["b", { kind: "schema", schema: { type: "integer" } }, ["stream"]],
				["c", { kind: "type", text: "Uint8Array" }, ["call"]],
				["d", { kind: "type", text: "string" }, ["call"]],
				["e", { kind: "type", text: "string | Uint8Array" }, ["call", "stream"]],
			]
		);
	});

	test("the protocols a plan exports are the ones its tools use, sorted", () => {
		const list = tools(http("a"), { name: "t", tool_call_template: { call_template_type: "text", content: "x" } });
		assert.deepEqual(plan(list, config({ protocols: ["text", "http"] }), undefined).protocols, ["http", "text"]);
	});

	test("every problem in a plan is reported at once", () => {
		planError(
			() => plan(tools(http("a")), config({ protocols: ["http", "udp"], skip: ["x"], names: { y: "z" } }), undefined),
			/skip lists "x"/u,
			/names renames "y"/u,
			/lists udp, which no tool uses/u
		);
	});
});
