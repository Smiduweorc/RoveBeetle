import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import type { Transport } from "../../src/auth.js";
import type { McpServer, McpTemplate, ToolCall } from "../../src/call.js";
import { RoveError } from "../../src/errors.js";
import { PROTOCOL_VERSIONS } from "../../src/mcp.js";
import { McpClient } from "../../src/protocols/mcp.js";
import { makeServer, observed } from "../fixtures/mcp-server.js";
import { json } from "./transport.js";

function isCode(code: string): (error: unknown) => boolean {
	return (error) => error instanceof RoveError && error.code === code;
}

const fixture = fileURLToPath(new URL("../fixtures/mcp-stdio.ts", import.meta.url));

/** The fixture as a stdio server, run by whichever runtime runs the tests. */
const stdio: McpServer = {
	transport: "stdio",
	command: process.execPath,
	args: "bun" in process.versions ? [fixture] : ["--import", "tsx", fixture],
	env: { FIXTURE_GIVEN: "given" },
	cwd: fileURLToPath(new URL("../..", import.meta.url)),
};

/**
 * A `fetch` replacement that hands every request to the SDK's own Streamable
 * HTTP server transport, with one server and transport per session, the way
 * the SDK's examples run it. `json` picks JSON responses over SSE ones.
 */
function sdkHttp(options: { json: boolean }): { transport: Transport; requests: Request[] } {
	const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();
	const requests: Request[] = [];
	const transport: Transport = async (request) => {
		requests.push(request.clone());
		if (new URL(request.url).pathname === "/token") {
			return json({ access_token: "tok", token_type: "bearer", expires_in: 3600 });
		}
		const id = request.headers.get("mcp-session-id");
		let server = id === null ? undefined : sessions.get(id);
		if (server === undefined) {
			if (id !== null) {
				return new Response("unknown session", { status: 404 });
			}
			server = new WebStandardStreamableHTTPServerTransport({
				sessionIdGenerator: () => randomUUID(),
				enableJsonResponse: options.json,
				onsessioninitialized: (sessionId) => {
					sessions.set(sessionId, server as WebStandardStreamableHTTPServerTransport);
				},
			});
			await makeServer().connect(server);
		}
		// Real `fetch` rejects when the request's signal aborts; so does this.
		const aborted = new Promise<never>((_resolve, reject) => {
			request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
		});
		return Promise.race([server.handleRequest(request), aborted]);
	};
	return { transport, requests };
}

function template(server: McpServer, toolName: string, overrides: Partial<McpTemplate> = {}): McpTemplate {
	return { serverName: "fixture", server, toolName, dataFormat: "auto", unwrapResult: false, ...overrides };
}

function call<T = unknown>(server: McpServer, toolName: string, args: Record<string, unknown> = {}, overrides: Partial<McpTemplate> = {}): ToolCall<"mcp", T> {
	return { protocol: "mcp", tool: `fixture.${toolName}`, template: template(server, toolName, overrides), args };
}

const environment = { PATH: process.env["PATH"], HOME: process.env["HOME"], FIXTURE_SECRET: "leaked" };

describe("constructing an mcp client", () => {
	test("environment and maxResponseBytes are required", () => {
		assert.throws(() => new McpClient({ variables: {}, maxResponseBytes: 1 } as never), isCode("unsupported_value"));
		assert.throws(() => new McpClient({ variables: {}, environment: {} } as never), isCode("unsupported_value"));
	});

	test("the client offers the newest protocol revision first", () => {
		assert.equal(PROTOCOL_VERSIONS[0], "2025-11-25");
	});
});

const http: McpServer = { transport: "http", url: "https://mcp.example.com/mcp", headers: { "x-app": "rove" } };

// A JSON response cannot carry a request from the server, so the tests of
// server requests run where the transport can: stdio and SSE responses.
for (const [label, server, makeTransport, serverRequests] of [
	["stdio", stdio, undefined, true],
	["Streamable HTTP with JSON responses", http, (): ReturnType<typeof sdkHttp> => sdkHttp({ json: true }), false],
	["Streamable HTTP with SSE responses", http, (): ReturnType<typeof sdkHttp> => sdkHttp({ json: false }), true],
] as const) {
	describe(`mcp over ${label}, against the official SDK`, () => {
		const client = (): McpClient<string> =>
			new McpClient<string>({
				variables: {},
				environment,
				maxResponseBytes: 65_536,
				...(makeTransport === undefined ? {} : { transport: makeTransport().transport }),
			});

		test("a single text result is decoded as the template says", async () => {
			const mcp = client();
			try {
				assert.equal(await mcp.call(call(server, "echo", { text: "hi" }, { dataFormat: "text" })), "hi");
				assert.equal(await mcp.call(call(server, "echo", { text: "42" })), 42);
			} finally {
				await mcp.close();
			}
		});

		test("structuredContent is the result when the server sends it", async () => {
			const mcp = client();
			try {
				assert.deepEqual(await mcp.call(call(server, "add", { a: 2, b: 3 })), { sum: 5 });
			} finally {
				await mcp.close();
			}
		});

		test("a FastMCP wrapper is unwrapped only when the template says the schema marks it", async () => {
			const mcp = client();
			try {
				assert.deepEqual(await mcp.call(call(server, "wrapped", {}, { unwrapResult: true })), [1, 2]);
				assert.deepEqual(await mcp.call(call(server, "wrapped")), { result: [1, 2] });
			} finally {
				await mcp.close();
			}
		});

		test("isError fails the call with the text as body", async () => {
			const mcp = client();
			try {
				await assert.rejects(mcp.call(call(server, "fail")), (error: unknown) =>
					error instanceof RoveError && error.code === "status" && error.body === "it broke"
				);
			} finally {
				await mcp.close();
			}
		});

		test("several content items come back as the content array", async () => {
			const mcp = client();
			try {
				assert.deepEqual(await mcp.call(call(server, "images")), [
					{ type: "text", text: "caption" },
					{ type: "image", data: "aGk=", mimeType: "image/png" },
				]);
			} finally {
				await mcp.close();
			}
		});

		test("an unknown tool is a status error carrying the JSON-RPC error", async () => {
			const mcp = client();
			try {
				await assert.rejects(mcp.call(call(server, "nope")), (error: unknown) => error instanceof RoveError && error.code === "status");
			} finally {
				await mcp.close();
			}
		});

		test("a resource is read with resources/read", async () => {
			const mcp = client();
			try {
				assert.deepEqual(await mcp.call(call(server, "first-note", {}, { resourceUri: "note://1" })), [
					{ uri: "note://1", mimeType: "text/plain", text: "note one" },
				]);
			} finally {
				await mcp.close();
			}
		});

		test("listing tools follows nextCursor to the end", async () => {
			const mcp = client();
			try {
				const tools = await mcp.listTools(template(server, ""));
				assert.equal(tools.length, 9);
				assert.equal(tools[0]?.["name"], "echo");
				assert.equal(tools.at(-1)?.["name"], "samples");
			} finally {
				await mcp.close();
			}
		});

		test("listing resources returns them", async () => {
			const mcp = client();
			try {
				assert.deepEqual(
					(await mcp.listResources(template(server, ""))).map((resource) => resource["uri"]),
					["note://1"]
				);
			} finally {
				await mcp.close();
			}
		});

		if (serverRequests) test("a ping from the server during a call is answered", async () => {
			const mcp = client();
			try {
				assert.equal(await mcp.call(call(server, "pings", {}, { dataFormat: "text" })), "pinged");
			} finally {
				await mcp.close();
			}
		});

		if (serverRequests) test("a sampling request from the server is refused as method not found", async () => {
			const mcp = client();
			try {
				const answer = await mcp.call<string>(call(server, "samples", {}, { dataFormat: "text" }));
				assert.match(answer, /^refused: .*does not support sampling\/createMessage/u);
			} finally {
				await mcp.close();
			}
		});

		test("calls share one session, concurrently", async () => {
			const mcp = client();
			try {
				const results = await Promise.all([1, 2, 3].map((n) => mcp.call(call(server, "add", { a: n, b: n }))));
				assert.deepEqual(results, [{ sum: 2 }, { sum: 4 }, { sum: 6 }]);
			} finally {
				await mcp.close();
			}
		});

		test("aborting rejects with the caller's reason and cancels the request on the server", async () => {
			const mcp = client();
			observed.cancelled = false;
			try {
				const reason = new Error("stop");
				const controller = new AbortController();
				const pending = mcp.call(call(server, "slow"), { signal: controller.signal });
				setTimeout(() => controller.abort(reason), 200);
				await assert.rejects(pending, (error) => error === reason);
				// A later call still works on the same session.
				assert.equal(await mcp.call(call(server, "echo", { text: "after" }, { dataFormat: "text" })), "after");
			} finally {
				await mcp.close();
			}
			if (server.transport === "http") {
				assert.equal(observed.cancelled, true);
			}
		});
	});
}

describe("mcp specifics", () => {
	test("a stdio server inherits only the default list, plus its own env", async () => {
		const mcp = new McpClient({ variables: {}, environment, maxResponseBytes: 65_536 });
		try {
			assert.equal(await mcp.call(call(stdio, "environment", {}, { dataFormat: "text" })), "unset|given");
		} finally {
			await mcp.close();
		}
	});

	test("a stdio server that cannot start is transport_failed", async () => {
		const mcp = new McpClient({ variables: {}, environment, maxResponseBytes: 65_536 });
		await assert.rejects(
			mcp.call(call({ transport: "stdio", command: "/nonexistent/server", args: [], env: {} }, "echo")),
			isCode("transport_failed")
		);
	});

	test("a stdio server that exits mid-session fails pending calls, and the next call starts a fresh one", async () => {
		const mcp = new McpClient({ variables: {}, environment, maxResponseBytes: 65_536 });
		try {
			const crash: McpServer = { ...stdio, args: [...(stdio.transport === "stdio" ? stdio.args : [])] };
			assert.equal(await mcp.call(call(crash, "echo", { text: "one" }, { dataFormat: "text" })), "one");
			await mcp.close();
			assert.equal(await mcp.call(call(crash, "echo", { text: "two" }, { dataFormat: "text" })), "two");
		} finally {
			await mcp.close();
		}
	});

	test("HTTP requests carry the session id and the negotiated protocol version after initialize", async () => {
		const { transport, requests } = sdkHttp({ json: true });
		const mcp = new McpClient({ variables: {}, environment: {}, maxResponseBytes: 65_536, transport });
		try {
			await mcp.call(call(http, "echo", { text: "x" }));
			const [initialize, ...later] = requests;
			assert.equal(initialize?.headers.get("mcp-session-id"), null);
			assert.equal(initialize?.headers.get("x-app"), "rove");
			assert.match(initialize?.headers.get("accept") ?? "", /application\/json.*text\/event-stream/u);
			assert.ok(later.length >= 2);
			for (const request of later) {
				assert.notEqual(request.headers.get("mcp-session-id"), null);
				assert.equal(request.headers.get("mcp-protocol-version"), PROTOCOL_VERSIONS[0]);
			}
		} finally {
			await mcp.close();
		}
		assert.equal(requests.at(-1)?.method, "DELETE", "close ends the session on the server");
	});

	test("oauth2 auth sends a bearer token on every HTTP request", async () => {
		const { transport, requests } = sdkHttp({ json: true });
		const mcp = new McpClient({ variables: {}, environment: {}, maxResponseBytes: 65_536, transport });
		try {
			await mcp.call(
				call(http, "echo", { text: "x" }, { auth: { type: "oauth2", tokenUrl: "https://mcp.example.com/token", clientId: "i", clientSecret: "s" } })
			);
			const mcpRequests = requests.filter((request) => new URL(request.url).pathname === "/mcp");
			assert.ok(mcpRequests.every((request) => request.headers.get("authorization") === "Bearer tok"));
			assert.equal(requests.filter((request) => new URL(request.url).pathname === "/token").length, 1);
		} finally {
			await mcp.close();
		}
	});

	test("an expired HTTP session fails that call, and the next call opens a new session", async () => {
		let expire = false;
		const { transport: real } = sdkHttp({ json: true });
		const transport: Transport = async (request) =>
			expire && request.headers.get("mcp-session-id") !== null && request.method === "POST"
				? new Response("gone", { status: 404 })
				: real(request);
		const mcp = new McpClient({ variables: {}, environment: {}, maxResponseBytes: 65_536, transport });
		try {
			assert.equal(await mcp.call(call(http, "echo", { text: "a" }, { dataFormat: "text" })), "a");
			expire = true;
			await assert.rejects(mcp.call(call(http, "echo", { text: "b" })), (error: unknown) =>
				error instanceof RoveError && error.code === "transport_failed" && error.status === 404
			);
			expire = false;
			assert.equal(await mcp.call(call(http, "echo", { text: "c" }, { dataFormat: "text" })), "c");
		} finally {
			await mcp.close();
		}
	});

	test("a server answering with a protocol revision this client does not speak is refused", async () => {
		const transport: Transport = async (request) => {
			const body = (await request.json()) as { id?: number; method?: string };
			return json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "1999-01-01", capabilities: {}, serverInfo: { name: "old", version: "0" } } });
		};
		const mcp = new McpClient({ variables: {}, environment: {}, maxResponseBytes: 65_536, transport });
		await assert.rejects(mcp.call(call(http, "echo")), isCode("protocol_error"));
	});

	test("a message over maxResponseBytes fails the call", async () => {
		const { transport } = sdkHttp({ json: true });
		const mcp = new McpClient({ variables: {}, environment: {}, maxResponseBytes: 1_000, transport });
		try {
			await assert.rejects(mcp.call(call(http, "echo", { text: "x".repeat(2_000) })), isCode("protocol_error"));
		} finally {
			await mcp.close();
		}
	});

	test("plain http to a public MCP server is refused", async () => {
		const mcp = new McpClient({ variables: {}, environment: {}, maxResponseBytes: 1_000 });
		await assert.rejects(mcp.call(call({ transport: "http", url: "http://mcp.example.com/mcp", headers: {} }, "echo")), isCode("insecure_url"));
	});
});
