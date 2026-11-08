import assert from "node:assert/strict";
import { createSocket, type Socket as UdpSocket } from "node:dgram";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer as createTcpServer, type AddressInfo, type Server as TcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";

import { buildSchema, graphql } from "graphql";
import { WebSocketServer } from "ws";

import { ConfigError } from "../../tools/generator/config.js";
import { discover, parseDocument } from "../../tools/generator/discover.js";
import { ManualError } from "../../tools/generator/reader.js";

/** A manual with one text tool named `name`. */
const manualJson = (name: string): string =>
	JSON.stringify({ utcp_version: "1.1.0", tools: [{ name, tool_call_template: { call_template_type: "text", content: "x" } }] });

const options = { graphqlDepth: undefined, environment: process.env };

let directory: string;
let http: HttpServer;
let httpPort: number;
let tcp: TcpServer;
let tcpPort: number;
let udp: UdpSocket;
let udpPort: number;
let ws: WebSocketServer;
let wsPort: number;

const schema = buildSchema(`
	type User { id: ID!, name: String!, friends(first: Int!): [User!]!, best: User }
	type Query { user(id: ID!): User, users(limit: Int = 10): [User!]! }
	type Mutation { rename(id: ID!, name: String!): User! }
`);

before(async () => {
	directory = await mkdtemp(join(tmpdir(), "rove-beetle-discover-"));
	await writeFile(join(directory, "manual.json"), manualJson("from_json"));
	await writeFile(join(directory, "manual.yaml"), "utcp_version: '1.1.0'\ntools:\n  - name: from_yaml\n    tool_call_template:\n      call_template_type: text\n      content: x\n");

	http = createHttpServer((request, response) => {
		if (request.url === "/graphql") {
			let body = "";
			request.on("data", (chunk: Buffer) => (body += chunk.toString()));
			request.on("end", () => {
				const { query } = JSON.parse(body) as { query: string };
				void graphql({ schema, source: query }).then((result) => {
					response.setHeader("content-type", "application/json");
					response.end(JSON.stringify(result));
				});
			});
			return;
		}
		if (request.url === "/yaml") {
			response.setHeader("content-type", "application/yaml");
			response.end("utcp_version: '1.0'\ntools:\n  - name: yaml_over_http\n    tool_call_template: { call_template_type: text, content: x }\n");
			return;
		}
		if (request.url === "/openapi") {
			response.setHeader("content-type", "application/json");
			response.end(JSON.stringify({ openapi: "3.1.0", paths: {} }));
			return;
		}
		response.setHeader("content-type", "application/json");
		response.setHeader("x-seen-auth", String(request.headers["x-api-key"]));
		response.end(manualJson(`over_http_${String(request.headers["x-api-key"] ?? "none")}`));
	});
	await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", () => resolve()));
	httpPort = (http.address() as AddressInfo).port;

	tcp = createTcpServer((socket) => {
		socket.on("data", (data) => {
			if (JSON.parse(data.toString()).type === "utcp") {
				socket.end(JSON.stringify({ utcp_version: "1.0", tools: [{ name: "over_tcp" }] }));
			}
		});
	});
	await new Promise<void>((resolve) => tcp.listen(0, "127.0.0.1", () => resolve()));
	tcpPort = (tcp.address() as AddressInfo).port;

	udp = createSocket("udp4");
	udp.on("message", (message, from) => {
		if (JSON.parse(message.toString()).type === "utcp") {
			udp.send(JSON.stringify({ utcp_version: "1.0", tools: [{ name: "over_udp" }] }), from.port, from.address);
		}
	});
	await new Promise<void>((resolve) => udp.bind(0, "127.0.0.1", () => resolve()));
	udpPort = udp.address().port;

	ws = new WebSocketServer({ host: "127.0.0.1", port: 0 });
	await new Promise<void>((resolve) => ws.once("listening", () => resolve()));
	wsPort = (ws.address() as AddressInfo).port;
	ws.on("connection", (socket) => {
		socket.on("message", (data) => {
			if (JSON.parse(data.toString()).type === "utcp") {
				socket.send(JSON.stringify({ utcp_version: "1.0", tools: [{ name: "over_ws", outputs: { type: "string" } }] }));
			}
		});
	});
});

after(async () => {
	await rm(directory, { recursive: true, force: true });
	await new Promise<void>((resolve) => http.close(() => resolve()));
	await new Promise<void>((resolve) => tcp.close(() => resolve()));
	udp.close();
	await new Promise<void>((resolve) => ws.close(() => resolve()));
});

const names = (result: Awaited<ReturnType<typeof discover>>): string[] => result.tools.map((tool) => tool.name);

describe("manuals from paths and URLs", () => {
	test("a JSON file is read relative to the config", async () => {
		assert.deepEqual(names(await discover("./manual.json", directory, options)), ["from_json"]);
	});

	test("a YAML file is read", async () => {
		assert.deepEqual(names(await discover("manual.yaml", directory, options)), ["from_yaml"]);
	});

	test("a URL is fetched, and a YAML body is read", async () => {
		assert.deepEqual(names(await discover(`http://127.0.0.1:${httpPort}/manual`, directory, options)), ["over_http_none"]);
		assert.deepEqual(names(await discover(`http://127.0.0.1:${httpPort}/yaml`, directory, options)), ["yaml_over_http"]);
	});

	test("a plain http URL to a public host is refused", async () => {
		await assert.rejects(discover("http://manuals.example.com/m.json", directory, options), (error: unknown) => (error as { code?: string }).code === "insecure_url");
	});

	test("an OpenAPI document is refused with a pointer to dung beetle", async () => {
		await assert.rejects(discover(`http://127.0.0.1:${httpPort}/openapi`, directory, options), (error: unknown) => error instanceof ManualError && /dung beetle/u.test(error.message));
	});

	test("a document that is neither JSON nor YAML is refused", () => {
		assert.throws(() => parseDocument("{ [", "x.json"), ConfigError);
	});

	test("a YAML alias bomb is refused rather than expanded", () => {
		const bomb = ["a: &a [x, x, x, x, x, x, x, x, x, x]", ...Array.from({ length: 12 }, (_, index) => `${String.fromCharCode(98 + index)}: &${String.fromCharCode(98 + index)} [${Array(10).fill(`*${String.fromCharCode(97 + index)}`).join(", ")}]`)].join("\n");
		assert.throws(() => parseDocument(bomb, "bomb.yaml"), ConfigError);
	});
});

describe("manuals discovered over a protocol", () => {
	test("http GETs the manual with the template's auth", async () => {
		const result = await discover(
			{ call_template_type: "http", url: `http://127.0.0.1:${httpPort}/manual`, auth: { auth_type: "api_key", api_key: "k1", var_name: "X-Api-Key" } },
			directory,
			options
		);
		assert.deepEqual(names(result), ["over_http_k1"]);
		assert.equal(result.via, "http");
	});

	test("sse and streamable_http GET the manual the same way", async () => {
		assert.deepEqual(names(await discover({ call_template_type: "sse", url: `http://127.0.0.1:${httpPort}/manual` }, directory, options)), ["over_http_none"]);
		assert.deepEqual(names(await discover({ call_template_type: "streamable_http", url: `http://127.0.0.1:${httpPort}/manual` }, directory, options)), ["over_http_none"]);
	});

	test("text parses its content", async () => {
		assert.deepEqual(names(await discover({ call_template_type: "text", content: manualJson("from_text") }, directory, options)), ["from_text"]);
	});

	test("file reads its path relative to the config", async () => {
		assert.deepEqual(names(await discover({ call_template_type: "file", file_path: "manual.yaml" }, directory, options)), ["from_yaml"]);
	});

	test("cli runs the commands and reads their output", async () => {
		const result = await discover({ call_template_type: "cli", commands: [{ command: "cat manual.json" }] }, directory, options);
		assert.deepEqual(names(result), ["from_json"]);
		assert.equal(result.via, "cli");
	});

	test("tcp sends {\"type\":\"utcp\"}, and tools without a template inherit the source's", async () => {
		const result = await discover({ call_template_type: "tcp", host: "127.0.0.1", port: tcpPort }, directory, options);
		assert.deepEqual(names(result), ["over_tcp"]);
		assert.equal(result.tools[0]?.protocol, "tcp");
		assert.equal((result.tools[0]?.template as { port: number }).port, tcpPort);
	});

	test("udp does the same", async () => {
		const result = await discover({ call_template_type: "udp", host: "127.0.0.1", port: udpPort }, directory, options);
		assert.deepEqual(names(result), ["over_udp"]);
		assert.equal(result.tools[0]?.protocol, "udp");
	});

	test("websocket does the same", async () => {
		const result = await discover({ call_template_type: "websocket", url: `ws://127.0.0.1:${wsPort}` }, directory, options);
		assert.deepEqual(names(result), ["over_ws"]);
		assert.equal(result.tools[0]?.protocol, "websocket");
	});

	test("a template with a typo is refused before anything is contacted", async () => {
		await assert.rejects(discover({ call_template_type: "http", uri: "https://a" }, directory, options), ManualError);
	});

	test("a template without a call_template_type is refused", async () => {
		await assert.rejects(discover({ url: "https://a" }, directory, options), ConfigError);
	});
});

describe("graphql discovery", () => {
	const source = (): Record<string, unknown> => ({ call_template_type: "graphql", url: `http://127.0.0.1:${httpPort}/graphql` });

	test("graphql.depth is required", async () => {
		await assert.rejects(discover(source(), directory, options), (error: unknown) => error instanceof ConfigError && /graphql\.depth/u.test(error.message));
	});

	test("each root field becomes a tool with a selection to the configured depth", async () => {
		const result = await discover(source(), directory, { ...options, graphqlDepth: 2 });
		assert.deepEqual(names(result), ["user", "users", "rename"]);
		const user = result.tools[0]?.template as { query: string; operationType: string };
		assert.equal(user.operationType, "query");
		assert.equal(user.query, "query QueryUser($id: ID!) { user(id: $id) { id name best { id name } } }");
		const rename = result.tools[2]?.template as { operationType: string; query: string };
		assert.equal(rename.operationType, "mutation");
	});

	test("fields that need arguments are left out of the selection and noted", async () => {
		const result = await discover(source(), directory, { ...options, graphqlDepth: 1 });
		assert.match(result.tools[0]?.notes.join(" ") ?? "", /friends/u);
		assert.equal((result.tools[0]?.template as { query: string }).query, "query QueryUser($id: ID!) { user(id: $id) { id name } }");
	});

	test("arguments become the input schema: non-null without a default is required", async () => {
		const result = await discover(source(), directory, { ...options, graphqlDepth: 1 });
		assert.deepEqual(result.tools[0]?.inputs, { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false });
		assert.deepEqual(result.tools[1]?.inputs, { type: "object", properties: { limit: { anyOf: [{ type: "integer" }, { type: "null" }] } }, additionalProperties: false });
	});

	test("a discovered query runs against the real schema", async () => {
		const result = await discover(source(), directory, { ...options, graphqlDepth: 2 });
		const { query } = result.tools[1]?.template as { query: string };
		const executed = await graphql({ schema, source: query, rootValue: { users: () => [{ id: "1", name: "a", best: null }] } });
		assert.deepEqual(executed.errors, undefined);
		// graphql builds results with null prototypes; compare their content.
		assert.deepEqual(JSON.parse(JSON.stringify(executed.data)), { users: [{ id: "1", name: "a", best: null }] });
	});
});

describe("mcp discovery", () => {
	const fixture = fileURLToPath(new URL("../fixtures/mcp-stdio.ts", import.meta.url));
	const server = { command: process.execPath, args: ["--import", "tsx", fixture], cwd: fileURLToPath(new URL("../..", import.meta.url)) };

	test("every tool on every server becomes server.tool, with its schemas", async () => {
		const result = await discover({ call_template_type: "mcp", config: { mcpServers: { fixture: server } } }, directory, options);
		assert.equal(result.via, "mcp");
		assert.deepEqual(names(result).slice(0, 3), ["fixture.echo", "fixture.add", "fixture.wrapped"]);
		const add = result.tools[1];
		assert.deepEqual(add?.outputs, { type: "object", properties: { sum: { type: "number" } }, required: ["sum"] });
		assert.equal((add?.template as { dataFormat: string }).dataFormat, "json");
		assert.equal((result.tools[2]?.template as { unwrapResult: boolean }).unwrapResult, true);
	});

	test("resources become tools when register_resources_as_tools is set", async () => {
		const result = await discover({ call_template_type: "mcp", config: { mcpServers: { fixture: server } }, register_resources_as_tools: true }, directory, options);
		const resource = result.tools.find((tool) => tool.name === "fixture.resource_first-note");
		assert.equal((resource?.template as { resourceUri?: string }).resourceUri, "note://1");
	});
});
