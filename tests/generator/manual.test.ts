import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { decodeEscapes } from "../../tools/generator/escapes.js";
import { readManual, type ManualTool } from "../../tools/generator/manual.js";
import { ManualError } from "../../tools/generator/reader.js";

function manual(tools: unknown[], extra: Record<string, unknown> = {}): unknown {
	return { utcp_version: "1.1.0", manual_version: "1.0.0", tools, ...extra };
}

function tool(template: Record<string, unknown>, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return { name: "t", description: "d", inputs: { type: "object", properties: { id: { type: "string" }, q: { type: "string" } } }, tool_call_template: template, ...overrides };
}

function one(template: Record<string, unknown>, overrides: Record<string, unknown> = {}): ManualTool {
	const [read] = readManual(manual([tool(template, overrides)]), "m.json");
	assert.ok(read);
	return read;
}

/** Asserts the manual is refused, with a problem matching each pattern. */
function refused(value: unknown, ...patterns: RegExp[]): void {
	assert.throws(
		() => readManual(value, "m.json"),
		(error: unknown) => {
			assert.ok(error instanceof ManualError, String(error));
			for (const pattern of patterns) {
				assert.ok(
					error.problems.some((problem) => pattern.test(problem)),
					`no problem matches ${String(pattern)}:\n${error.problems.join("\n")}`
				);
			}
			return true;
		}
	);
}

describe("the manual itself", () => {
	test("utcp_version 1, 1.x and 1.x.y are read", () => {
		for (const version of ["1", "1.0", "1.1.0", "1.0.2"]) {
			assert.equal(readManual(manual([], { utcp_version: version }), "m").length, 0, version);
		}
	});

	for (const version of ["0.1.0", "2.0.0", "1.x", "", "v1.0"]) {
		test(`utcp_version ${JSON.stringify(version)} is refused`, () => {
			refused(manual([], { utcp_version: version }), /utcp_version/u);
		});
	}

	test("an OpenAPI document is refused with a pointer to dung beetle", () => {
		refused({ openapi: "3.1.0", paths: {} }, /dung beetle/u);
		refused({ swagger: "2.0" }, /OpenAPI/u);
	});

	test("an unknown top-level field is refused, and info is allowed", () => {
		refused(manual([], { extra: 1 }), /manual\.extra: is not a field/u);
		assert.doesNotThrow(() => readManual(manual([], { info: { title: "x" } }), "m"));
	});

	test("two tools with one name are refused", () => {
		const template = { call_template_type: "text", content: "x" };
		refused(manual([tool(template), tool(template)]), /two tools are named "t"/u);
	});

	test("every problem in a manual is reported at once", () => {
		refused(
			manual([tool({ call_template_type: "http" }), tool({ call_template_type: "nope" }, { name: "u" })]),
			/tools\[0\]\.tool_call_template\.url: is required/u,
			/tools\[1\]\.tool_call_template\.call_template_type: must be one of/u
		);
	});

	test("a tool without a call template is refused", () => {
		refused(manual([{ name: "t" }]), /tool_call_template: is required/u);
	});

	test("an unknown tool field is refused", () => {
		refused(manual([tool({ call_template_type: "text", content: "x" }, { tool_provider: {} })]), /tool_provider: is not a field/u);
	});

	test("null fields read as absent, as the reference's serializer writes them", () => {
		const read = one({
			call_template_type: "http",
			name: null,
			url: "https://a.example.com/x",
			http_method: null,
			content_type: null,
			auth: null,
			auth_tools: null,
			headers: null,
			body_field: null,
			header_fields: null,
			allowed_communication_protocols: null,
		});
		assert.deepEqual(read.template, {
			url: "https://a.example.com/x",
			pathFields: [],
			headers: {},
			bodyField: "body",
			headerFields: [],
			method: "GET",
			contentType: "application/json",
		});
	});

	test("description, tags and schemas default to empty", () => {
		const read = readManual(manual([{ name: "t", tool_call_template: { call_template_type: "text", content: "x" } }]), "m")[0];
		assert.deepEqual([read?.description, read?.tags, read?.inputs, read?.outputs], ["", [], {}, {}]);
	});
});

describe("http templates", () => {
	test("the defaults are GET, application/json and a body field called body", () => {
		assert.deepEqual(one({ call_template_type: "http", url: "https://a.example.com" }).template, {
			url: "https://a.example.com",
			pathFields: [],
			headers: {},
			bodyField: "body",
			headerFields: [],
			method: "GET",
			contentType: "application/json",
		});
	});

	test("path placeholders are found, each once, and ${VAR} is not one", () => {
		const read = one({ call_template_type: "http", url: "https://${HOST}/users/{id}/posts/{id}/{q}" });
		assert.deepEqual((read.template as { pathFields: readonly string[] }).pathFields, ["id", "q"]);
	});

	test("a placeholder in the host or port is refused", () => {
		refused(manual([tool({ call_template_type: "http", url: "https://{tenant}.example.com/x" })]), /host or port/u);
		refused(manual([tool({ call_template_type: "http", url: "https://a.example.com:{port}/x" })]), /host or port/u);
	});

	test("a placeholder in the query is refused", () => {
		refused(manual([tool({ call_template_type: "http", url: "https://a.example.com/x?id={id}" })]), /query string/u);
	});

	test("a method outside the spec's five is refused", () => {
		refused(manual([tool({ call_template_type: "http", url: "https://a.example.com", http_method: "HEAD" })]), /http_method: must be one of/u);
	});

	test("an invalid header name or a header value with a line break is refused", () => {
		refused(manual([tool({ call_template_type: "http", url: "https://a", headers: { "bad name": "x" } })]), /not a valid header name/u);
		refused(manual([tool({ call_template_type: "http", url: "https://a", headers: { ok: "a\r\nb: c" } })]), /line break/u);
		refused(manual([tool({ call_template_type: "http", url: "https://a", header_fields: ["bad:name"] })]), /header_fields: has/u);
	});

	test("auth_tools is refused, because it only applies to converted OpenAPI", () => {
		refused(manual([tool({ call_template_type: "http", url: "https://a", auth_tools: { auth_type: "basic", username: "u", password: "p" } })]), /auth_tools/u);
	});

	test("allowed_communication_protocols on a tool is refused, pointing at the config", () => {
		refused(manual([tool({ call_template_type: "http", url: "https://a", allowed_communication_protocols: ["cli"] })]), /rovebeetle\.config\.ts/u);
		assert.doesNotThrow(() => one({ call_template_type: "http", url: "https://a", allowed_communication_protocols: [] }));
	});

	test("an unknown template field is refused, so a typo cannot fall back to a default", () => {
		refused(manual([tool({ call_template_type: "http", url: "https://a", method: "POST" })]), /tool_call_template\.method: is not a field/u);
	});
});

describe("auth", () => {
	const auth = (value: Record<string, unknown>): unknown => (one({ call_template_type: "http", url: "https://a", auth: value }).template as { auth?: unknown }).auth;

	test("api_key defaults to the X-Api-Key header", () => {
		assert.deepEqual(auth({ auth_type: "api_key", api_key: "$K" }), { type: "api_key", key: "$K", name: "X-Api-Key", location: "header" });
	});

	test("api_key in the query or a cookie is read", () => {
		assert.deepEqual(auth({ auth_type: "api_key", api_key: "k", var_name: "token", location: "query" }), { type: "api_key", key: "k", name: "token", location: "query" });
		assert.deepEqual(auth({ auth_type: "api_key", api_key: "k", var_name: "s", location: "cookie" }), { type: "api_key", key: "k", name: "s", location: "cookie" });
	});

	test("the TypeScript SDK's `in` for location is refused, not ignored", () => {
		refused(manual([tool({ call_template_type: "http", url: "https://a", auth: { auth_type: "api_key", api_key: "k", in: "query" } })]), /auth\.in: is not a field/u);
	});

	test("a location outside header, query and cookie is refused", () => {
		refused(manual([tool({ call_template_type: "http", url: "https://a", auth: { auth_type: "api_key", api_key: "k", location: "body" } })]), /location: must be one of/u);
	});

	test("basic needs username and password", () => {
		assert.deepEqual(auth({ auth_type: "basic", username: "u", password: "p" }), { type: "basic", username: "u", password: "p" });
		refused(manual([tool({ call_template_type: "http", url: "https://a", auth: { auth_type: "basic", username: "u" } })]), /password: is required/u);
	});

	test("oauth2 needs token_url, client_id and client_secret, and scope is optional", () => {
		assert.deepEqual(auth({ auth_type: "oauth2", token_url: "https://t", client_id: "i", client_secret: "s" }), {
			type: "oauth2",
			tokenUrl: "https://t",
			clientId: "i",
			clientSecret: "s",
		});
		assert.deepEqual((auth({ auth_type: "oauth2", token_url: "https://t", client_id: "i", client_secret: "s", scope: "a b" }) as { scope?: string }).scope, "a b");
		refused(manual([tool({ call_template_type: "http", url: "https://a", auth: { auth_type: "oauth2", client_id: "i", client_secret: "s" } })]), /token_url: is required/u);
	});

	test("an auth without auth_type, or of another type, is refused", () => {
		refused(manual([tool({ call_template_type: "http", url: "https://a", auth: { api_key: "k" } })]), /auth_type: is required/u);
		refused(manual([tool({ call_template_type: "http", url: "https://a", auth: { auth_type: "digest" } })]), /auth_type: must be one of/u);
	});

	test("an api key with a line break is refused", () => {
		refused(manual([tool({ call_template_type: "http", url: "https://a", auth: { auth_type: "api_key", api_key: "a\nb" } })]), /api_key: contains a line break/u);
	});
});

describe("sse and streamable_http templates", () => {
	test("sse has no body field by default and keeps its reconnect settings as notes", () => {
		const read = one({ call_template_type: "sse", url: "https://a/s" }, { outputs: { type: "object" } });
		assert.deepEqual(read.template, { url: "https://a/s", pathFields: [], headers: {}, headerFields: [], dataFormat: "json" });
		assert.match(read.notes.join(" "), /reconnect to true and retry_timeout to 30000 ms/u);
	});

	test("sse event data is text for a string schema, json otherwise, and auto without one", () => {
		const format = (outputs: unknown): unknown => (one({ call_template_type: "sse", url: "https://a" }, { outputs }).template as { dataFormat: string }).dataFormat;
		assert.equal(format({ type: "string" }), "text");
		assert.equal(format({ type: "array", items: { type: "string" } }), "text");
		assert.equal(format({ type: "integer" }), "json");
		assert.equal(format(undefined), "auto");
	});

	test("streamable_http defaults to GET and application/octet-stream, and notes the timeout and chunk size", () => {
		const read = one({ call_template_type: "streamable_http", url: "https://a/x" });
		assert.deepEqual(read.template, { url: "https://a/x", pathFields: [], headers: {}, headerFields: [], method: "GET", contentType: "application/octet-stream" });
		assert.match(read.notes.join(" "), /timeout to 60000 ms and chunk_size to 4096 bytes/u);
	});

	test("streamable_http refuses a method other than GET and POST", () => {
		refused(manual([tool({ call_template_type: "streamable_http", url: "https://a", http_method: "PUT" })]), /http_method/u);
	});
});

describe("graphql templates", () => {
	test("a given query is kept as written and checked", () => {
		const read = one({ call_template_type: "graphql", url: "https://a/g", query: "query U($id: ID!) { user(id: $id) { name } }" });
		assert.deepEqual(read.template, {
			url: "https://a/g",
			operationType: "query",
			query: "query U($id: ID!) { user(id: $id) { name } }",
			headers: {},
			headerFields: [],
		});
	});

	test("without a query, a scalar result gets one built from the inputs, String by default", () => {
		const read = one(
			{ call_template_type: "graphql", url: "https://a/g", variable_types: { id: "ID!" }, header_fields: ["q"] },
			{ name: "api.greeting", outputs: { type: "string" } }
		);
		assert.equal((read.template as { query: string }).query, "query($id: ID!) { greeting(id: $id) }");
	});

	test("without a query, an object result is refused, since the query would have no selection set", () => {
		refused(manual([tool({ call_template_type: "graphql", url: "https://a" }, { outputs: { type: "object" } })]), /query: is required unless/u);
	});

	test("a query that does not parse is refused", () => {
		refused(manual([tool({ call_template_type: "graphql", url: "https://a", query: "query {" })]), /not valid GraphQL/u);
	});

	test("the operation type must match the query's operation", () => {
		refused(manual([tool({ call_template_type: "graphql", url: "https://a", operation_type: "mutation", query: "query { a }" })]), /operation_type: is mutation/u);
	});

	test("a query with two operations needs operation_name, which must name one of them", () => {
		const query = "query A { a } query B { b }";
		refused(manual([tool({ call_template_type: "graphql", url: "https://a", query })]), /operation_name: is required/u);
		refused(manual([tool({ call_template_type: "graphql", url: "https://a", query, operation_name: "C" })]), /names no operation/u);
		assert.equal((one({ call_template_type: "graphql", url: "https://a", query, operation_name: "B" }).template as { operationName?: string }).operationName, "B");
	});
});

describe("websocket templates", () => {
	test("placeholders in a message are found against the inputs, underscores included", () => {
		const read = one(
			{ call_template_type: "websocket", url: "wss://a", message: { q: "UTCP_ARG_q_UTCP_ARG", u: "UTCP_ARG_user_id_UTCP_ARG" } },
			{ inputs: { type: "object", properties: { q: {}, user: {}, user_id: {} } } }
		);
		assert.deepEqual((read.template as { messageFields: readonly string[] }).messageFields, ["q", "user_id"]);
	});

	test("timeout and keep_alive are notes, response_format is read, and absent means raw", () => {
		const read = one({ call_template_type: "websocket", url: "wss://a", response_format: "json", protocol: "v1" });
		assert.deepEqual(read.template, { url: "wss://a", messageFields: [], protocol: "v1", responseFormat: "json", headers: {}, headerFields: [] });
		assert.match(read.notes.join(" "), /timeout to 30 s and keep_alive to true/u);
		assert.equal((one({ call_template_type: "websocket", url: "wss://a" }).template as { responseFormat?: string }).responseFormat, undefined);
	});

	test("a message that is a list is refused", () => {
		refused(manual([tool({ call_template_type: "websocket", url: "wss://a", message: [1] })]), /message: must be a string or an object/u);
	});
});

describe("tcp and udp templates", () => {
	test("tcp defaults: json requests, utf-8 replies, stream framing to 65536 bytes", () => {
		const read = one({ call_template_type: "tcp", host: "h", port: 9 });
		assert.deepEqual(read.template, {
			host: "h",
			port: 9,
			requestFormat: "json",
			requestFields: [],
			responseEncoding: "utf-8",
			framing: { strategy: "stream", maxResponseSize: 65536 },
		});
		assert.match(read.notes.join(" "), /timeout to 30000 ms/u);
	});

	test("a null response_byte_format means bytes, not the utf-8 default", () => {
		assert.equal((one({ call_template_type: "tcp", host: "h", port: 9, response_byte_format: null }).template as { responseEncoding: unknown }).responseEncoding, null);
	});

	test("an encoding the runtime cannot decode is refused", () => {
		refused(manual([tool({ call_template_type: "tcp", host: "h", port: 9, response_byte_format: "klingon" })]), /not an encoding/u);
	});

	test("length prefix framing defaults to four bytes, big endian", () => {
		assert.deepEqual((one({ call_template_type: "tcp", host: "h", port: 9, framing_strategy: "length_prefix" }).template as { framing: unknown }).framing, {
			strategy: "length_prefix",
			bytes: 4,
			endian: "big",
		});
	});

	test("delimiter framing decodes escapes by default, and keeps them when told not to", () => {
		const framing = (extra: Record<string, unknown>): unknown =>
			(one({ call_template_type: "tcp", host: "h", port: 9, framing_strategy: "delimiter", ...extra }).template as { framing: unknown }).framing;
		assert.deepEqual(framing({}), { strategy: "delimiter", delimiter: "\u0000" });
		assert.deepEqual(framing({ message_delimiter: "\\r\\n" }), { strategy: "delimiter", delimiter: "\r\n" });
		assert.deepEqual(framing({ message_delimiter: "\\r\\n", interpret_escape_sequences: false }), { strategy: "delimiter", delimiter: "\\r\\n" });
	});

	test("an empty delimiter is refused", () => {
		refused(manual([tool({ call_template_type: "tcp", host: "h", port: 9, framing_strategy: "delimiter", message_delimiter: "" })]), /empty/u);
	});

	test("fixed length framing needs fixed_message_length", () => {
		refused(manual([tool({ call_template_type: "tcp", host: "h", port: 9, framing_strategy: "fixed_length" })]), /fixed_message_length: is required/u);
	});

	test("a port outside 1 to 65535 is refused", () => {
		refused(manual([tool({ call_template_type: "tcp", host: "h", port: 0 })]), /port/u);
		refused(manual([tool({ call_template_type: "tcp", host: "h", port: 65536 })]), /at most 65535/u);
		refused(manual([tool({ call_template_type: "tcp", host: "h" })]), /port: is required/u);
	});

	test("udp defaults to one datagram back, and zero is allowed", () => {
		assert.equal((one({ call_template_type: "udp", host: "h", port: 9 }).template as { datagrams: number }).datagrams, 1);
		assert.equal((one({ call_template_type: "udp", host: "h", port: 9, number_of_response_datagrams: 0 }).template as { datagrams: number }).datagrams, 0);
	});

	test("udp refuses tcp's framing fields, and auth", () => {
		refused(manual([tool({ call_template_type: "udp", host: "h", port: 9, framing_strategy: "stream" })]), /framing_strategy: is not a field/u);
		refused(manual([tool({ call_template_type: "udp", host: "h", port: 9, auth: { auth_type: "basic", username: "u", password: "p" } })]), /no auth/u);
	});

	test("request template placeholders are found", () => {
		const read = one({ call_template_type: "tcp", host: "h", port: 9, request_data_format: "text", request_data_template: "GET UTCP_ARG_id_UTCP_ARG" });
		assert.deepEqual((read.template as { requestFields: readonly string[] }).requestFields, ["id"]);
	});
});

describe("mcp templates", () => {
	const servers = { mcpServers: { files: { command: "node", args: ["s.js"], env: { A: "b" } }, web: { transport: "http", url: "https://m/mcp" } } };

	test("a server.tool name picks the server and the tool", () => {
		const read = one({ call_template_type: "mcp", config: servers }, { name: "files.read" });
		assert.deepEqual(read.template, {
			serverName: "files",
			server: { transport: "stdio", command: "node", args: ["s.js"], env: { A: "b" } },
			toolName: "read",
			dataFormat: "auto",
			unwrapResult: false,
		});
	});

	test("an unqualified name with one server uses it", () => {
		const read = one({ call_template_type: "mcp", config: { mcpServers: { web: servers.mcpServers.web } } }, { name: "search" });
		assert.deepEqual((read.template as { server: unknown }).server, { transport: "http", url: "https://m/mcp", headers: {} });
	});

	test("an unqualified name with several servers is refused, naming them", () => {
		refused(manual([tool({ call_template_type: "mcp", config: servers }, { name: "read" })]), /2 servers \(files, web\)/u);
	});

	test("a resource tool from a manual is refused, since only the server knows its URI", () => {
		refused(manual([tool({ call_template_type: "mcp", config: servers }, { name: "files.resource_notes" })]), /discover the manual/u);
	});

	test("FastMCP's wrap marker on the output schema sets unwrapResult", () => {
		const read = one({ call_template_type: "mcp", config: servers }, { name: "files.list", outputs: { type: "object", "x-fastmcp-wrap-result": true } });
		assert.equal((read.template as { unwrapResult: boolean }).unwrapResult, true);
	});

	test("auth other than oauth2, or on a stdio server, is refused", () => {
		refused(manual([tool({ call_template_type: "mcp", config: servers, auth: { auth_type: "basic", username: "u", password: "p" } }, { name: "web.x" })]), /must be oauth2/u);
		refused(
			manual([tool({ call_template_type: "mcp", config: servers, auth: { auth_type: "oauth2", token_url: "https://t", client_id: "i", client_secret: "s" } }, { name: "files.x" })]),
			/stdio server/u
		);
	});

	test("the legacy sse transport is refused by name", () => {
		refused(manual([tool({ call_template_type: "mcp", config: { mcpServers: { old: { transport: "sse", url: "https://m/sse" } } } })]), /legacy HTTP\+SSE/u);
	});

	test("a server entry with neither command nor url is refused", () => {
		refused(manual([tool({ call_template_type: "mcp", config: { mcpServers: { x: {} } } })]), /command: or url is required/u);
	});
});

describe("cli, text and file templates", () => {
	test("only the last command is kept by default", () => {
		const read = one({ call_template_type: "cli", commands: [{ command: "a" }, { command: "b" }, { command: "c", append_to_final_output: false }, { command: "d", append_to_final_output: null }] });
		assert.deepEqual(
			(read.template as { commands: readonly { appendToFinalOutput: boolean }[] }).commands.map((step) => step.appendToFinalOutput),
			[false, false, false, true]
		);
	});

	test("cli env, inheritance and working directory are read, and an empty command list is refused", () => {
		const read = one({ call_template_type: "cli", commands: [{ command: "a" }], env_vars: { A: "1" }, inherit_env_vars: [], working_dir: "/w" });
		assert.deepEqual(read.template, {
			commands: [{ command: "a", appendToFinalOutput: true }],
			dataFormat: "auto",
			envVars: { A: "1" },
			inheritEnvVars: [],
			workingDir: "/w",
		});
		refused(manual([tool({ call_template_type: "cli", commands: [] })]), /non-empty list/u);
	});

	test("text keeps its content, and refuses base_url", () => {
		assert.deepEqual(one({ call_template_type: "text", content: "$5" }).template, { content: "$5" });
		refused(manual([tool({ call_template_type: "text", content: "x", base_url: "https://a" })]), /base_url/u);
	});

	test("file needs file_path", () => {
		assert.deepEqual(one({ call_template_type: "file", file_path: "a.txt" }).template, { path: "a.txt" });
		refused(manual([tool({ call_template_type: "file" })]), /file_path: is required/u);
	});
});

describe("escape sequences in delimiters", () => {
	for (const [written, decoded] of [
		["\\n", "\n"],
		["\\r\\n", "\r\n"],
		["\\x00", "\u0000"],
		["\\0", "\u0000"],
		["\\101", "A"],
		["\\u2603", "\u2603"],
		["\\U0001F41E", "\u{1f41e}"],
		["\\\\", "\\"],
		["\\q", "\\q"],
		["plain", "plain"],
		["\u00e9", "\u00e9"],
		["end\\", "end\\"],
	] as const) {
		test(`${JSON.stringify(written)} decodes to ${JSON.stringify(decoded)}`, () => {
			assert.equal(decodeEscapes(written), decoded);
		});
	}

	for (const written of ["\\x0", "\\u12", "\\U0011FFFF", "\\N{BULLET}"]) {
		test(`${JSON.stringify(written)} is refused`, () => {
			assert.throws(() => decodeEscapes(written));
		});
	}
});
