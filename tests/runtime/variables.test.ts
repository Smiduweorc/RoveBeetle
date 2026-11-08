import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { TemplateOf } from "../../src/call.js";
import { RoveError } from "../../src/errors.js";
import { checkVariables, lookupIn, resolveTemplate, substitute, variablesIn } from "../../src/variables.js";

const values = new Map([
	["KEY", "k1"],
	["HOST", "api.example.com"],
	["refresh_token", "r1"],
]);
const lookup = lookupIn(values, "tool_a");

/** Records every name asked for, which is how the generator collects them. */
function recorder(): { names: string[]; lookup: (name: string) => string } {
	const names: string[] = [];
	return { names, lookup: (name) => (names.push(name), `<${name}>`) };
}

describe("variables in text", () => {
	test("both ${NAME} and $NAME are variables", () => {
		assert.deepEqual(variablesIn("https://${HOST}/x?k=$KEY"), ["HOST", "KEY"]);
		assert.equal(substitute("https://${HOST}/x?k=$KEY", lookup), "https://api.example.com/x?k=k1");
	});

	test("a bare name ends at the first character that cannot be in a name", () => {
		assert.equal(substitute("$KEY-$KEY.$KEY/", lookup), "k1-k1.k1/");
	});

	test("a bare name is as long as its letters, digits and underscores run", () => {
		assert.throws(() => substitute("$KEYS", lookup), { code: "variable_missing" });
	});

	test("a string mentioning $ref is left alone, because it is a JSON Schema reference", () => {
		assert.deepEqual(variablesIn("{\"$ref\": \"#/defs/$KEY\"}"), []);
		assert.equal(substitute("{\"$ref\": \"$KEY\"}", lookup), "{\"$ref\": \"$KEY\"}");
	});

	test("$refresh_token is a variable, not a $ref", () => {
		assert.deepEqual(variablesIn("$refresh_token"), ["refresh_token"]);
		assert.equal(substitute("$refresh_token", lookup), "r1");
	});

	test("a dollar sign with no name after it stays as written", () => {
		assert.equal(substitute("costs $ 5, ${} and $-", lookup), "costs $ 5, ${} and $-");
		assert.deepEqual(variablesIn("costs $ 5, ${} and $-"), []);
	});

	test("text with no variables comes back unchanged, including unicode", () => {
		assert.equal(substitute("gr\u00fc\u00dfe {id}", lookup), "gr\u00fc\u00dfe {id}");
	});

	test("duplicates are reported in order, each time they appear", () => {
		assert.deepEqual(variablesIn("$A ${B} $A"), ["A", "B", "A"]);
	});

	test("a missing variable names itself and the tool that needed it", () => {
		assert.throws(
			() => substitute("${NOPE}", lookup),
			(error: unknown) =>
				error instanceof RoveError &&
				error.code === "variable_missing" &&
				error.tool === "tool_a" &&
				error.message.includes("NOPE")
		);
	});
});

describe("checking the values a client is given", () => {
	test("non-empty strings are accepted", () => {
		assert.deepEqual([...checkVariables({ A: "x", B: "y" })], [
			["A", "x"],
			["B", "y"],
		]);
	});

	test("no variables at all is accepted", () => {
		assert.equal(checkVariables({}).size, 0);
	});

	for (const [label, value] of [
		["an empty string", ""],
		["undefined", undefined],
		["null", null],
		["a number", 5],
		["an object", {}],
	] as const) {
		test(`${label} is refused, naming the variable`, () => {
			assert.throws(() => checkVariables({ API_KEY: value }), (error: unknown) =>
				error instanceof RoveError && error.code === "variable_missing" && error.message.includes("API_KEY")
			);
		});
	}
});

describe("which template fields are substituted", () => {
	test("http substitutes the URL, header values and every auth field, never the content type", () => {
		const { names, lookup } = recorder();
		const template: TemplateOf["http"] = {
			url: "https://$HOST/{id}",
			pathFields: ["id"],
			method: "GET",
			contentType: "application/$NOT_A_VARIABLE",
			headers: { "x-$NAME": "$HEADER" },
			headerFields: [],
			auth: { type: "oauth2", tokenUrl: "$TOKEN_URL", clientId: "$ID", clientSecret: "$SECRET", scope: "$SCOPE" },
		};
		const resolved = resolveTemplate("http", template, lookup);
		assert.deepEqual(names, ["HOST", "HEADER", "TOKEN_URL", "ID", "SECRET", "SCOPE"]);
		assert.equal(resolved.contentType, "application/$NOT_A_VARIABLE");
		assert.deepEqual(resolved.headers, { "x-$NAME": "<HEADER>" });
	});

	test("api_key auth substitutes the key only", () => {
		const { names, lookup } = recorder();
		resolveTemplate(
			"http",
			{
				url: "https://a",
				pathFields: [],
				method: "GET",
				contentType: "application/json",
				headers: {},
				headerFields: [],
				auth: { type: "api_key", key: "Bearer ${KEY}", name: "$NAME", location: "header" },
			},
			lookup
		);
		assert.deepEqual(names, ["KEY"]);
	});

	test("basic auth substitutes username and password", () => {
		const { names, lookup } = recorder();
		resolveTemplate(
			"sse",
			{
				url: "https://a",
				pathFields: [],
				headers: {},
				headerFields: [],
				auth: { type: "basic", username: "$USER", password: "$PASS" },
				dataFormat: "json",
			},
			lookup
		);
		assert.deepEqual(names, ["USER", "PASS"]);
	});

	test("graphql never substitutes the query, whose $id is a GraphQL variable", () => {
		const { names, lookup } = recorder();
		const resolved = resolveTemplate(
			"graphql",
			{
				url: "https://$HOST/graphql",
				operationType: "query",
				query: "query Q($id: ID!) { user(id: $id) { name } }",
				headers: {},
				headerFields: [],
			},
			lookup
		);
		assert.deepEqual(names, ["HOST"]);
		assert.equal(resolved.query, "query Q($id: ID!) { user(id: $id) { name } }");
	});

	test("websocket substitutes URL, headers, subprotocol and auth, never the message", () => {
		const { names, lookup } = recorder();
		resolveTemplate(
			"websocket",
			{
				url: "wss://$HOST",
				message: "{\"price\": \"$5\"}",
				messageFields: [],
				protocol: "$PROTO",
				headers: { a: "$H" },
				headerFields: [],
				auth: { type: "api_key", key: "$KEY", name: "k", location: "query" },
			},
			lookup
		);
		assert.deepEqual(names, ["HOST", "H", "PROTO", "KEY"]);
	});

	test("tcp and udp substitute the host, never the request template", () => {
		for (const protocol of ["tcp", "udp"] as const) {
			const { names, lookup } = recorder();
			const base = {
				host: "$HOST",
				port: 1,
				requestFormat: "text" as const,
				requestTemplate: "PAY $AMOUNT",
				requestFields: [],
				responseEncoding: "utf-8",
			};
			const resolved =
				protocol === "tcp"
					? resolveTemplate("tcp", { ...base, framing: { strategy: "stream", maxResponseSize: 1 } }, lookup)
					: resolveTemplate("udp", { ...base, datagrams: 1 }, lookup);
			assert.deepEqual(names, ["HOST"], protocol);
			assert.equal(resolved.requestTemplate, "PAY $AMOUNT");
		}
	});

	test("mcp over stdio substitutes command, args, env values and cwd", () => {
		const { names, lookup } = recorder();
		resolveTemplate(
			"mcp",
			{
				serverName: "s",
				toolName: "t",
				server: { transport: "stdio", command: "$BIN", args: ["--key", "$KEY"], env: { $NAME: "$ENV" }, cwd: "$DIR" },
				dataFormat: "auto",
				unwrapResult: false,
			},
			lookup
		);
		assert.deepEqual(names, ["BIN", "KEY", "ENV", "DIR"]);
	});

	test("mcp over http substitutes the URL, header values and auth", () => {
		const { names, lookup } = recorder();
		resolveTemplate(
			"mcp",
			{
				serverName: "s",
				toolName: "t",
				server: { transport: "http", url: "https://$HOST/mcp", headers: { a: "$H" } },
				auth: { type: "oauth2", tokenUrl: "$U", clientId: "$I", clientSecret: "$S" },
				dataFormat: "auto",
				unwrapResult: false,
			},
			lookup
		);
		assert.deepEqual(names, ["HOST", "H", "U", "I", "S"]);
	});

	test("cli substitutes env values and the working directory, never a command, where $HOME belongs to the shell", () => {
		const { names, lookup } = recorder();
		const resolved = resolveTemplate(
			"cli",
			{
				commands: [{ command: "echo $HOME UTCP_ARG_x_UTCP_END", appendToFinalOutput: true }],
				dataFormat: "text",
				envVars: { TOKEN: "$TOKEN" },
				workingDir: "$DIR",
			},
			lookup
		);
		assert.deepEqual(names, ["TOKEN", "DIR"]);
		assert.equal(resolved.commands[0]?.command, "echo $HOME UTCP_ARG_x_UTCP_END");
	});

	test("text substitutes nothing, because its content is data", () => {
		const { names, lookup } = recorder();
		assert.deepEqual(resolveTemplate("text", { content: "costs $PRICE" }, lookup), { content: "costs $PRICE" });
		assert.deepEqual(names, []);
	});

	test("file substitutes the path", () => {
		const { names, lookup } = recorder();
		assert.deepEqual(resolveTemplate("file", { path: "$DIR/a.txt" }, lookup), { path: "<DIR>/a.txt" });
		assert.deepEqual(names, ["DIR"]);
	});

	test("resolving does not change the template it was given", () => {
		const template: TemplateOf["file"] = { path: "$DIR" };
		resolveTemplate("file", template, recorder().lookup);
		assert.deepEqual(template, { path: "$DIR" });
	});
});
