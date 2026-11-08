import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";

import { WebSocketServer, type WebSocket as ServerSocket } from "ws";

import { base64 } from "../../src/auth.js";
import type { ToolCall, WebSocketTemplate } from "../../src/call.js";
import { RoveError } from "../../src/errors.js";
import { WebSocketClient } from "../../src/protocols/websocket.js";
import { json, scripted } from "./transport.js";

/** What the server saw on one connection. */
interface Handshake {
	readonly url: string;
	readonly headers: Readonly<Record<string, string | string[] | undefined>>;
	readonly protocol: string;
	readonly messages: string[];
	closed: boolean;
}

type Behaviour = (socket: ServerSocket, message: string) => void;

let server: WebSocketServer;
let port: number;
let behaviour: Behaviour = () => undefined;
const handshakes: Handshake[] = [];

before(async () => {
	server = new WebSocketServer({ host: "127.0.0.1", port: 0, handleProtocols: (protocols) => [...protocols][0] ?? false });
	await new Promise<void>((resolve) => server.once("listening", () => resolve()));
	port = (server.address() as AddressInfo).port;
	server.on("connection", (socket, request) => {
		const seen: Handshake = { url: request.url ?? "", headers: request.headers, protocol: socket.protocol, messages: [], closed: false };
		handshakes.push(seen);
		socket.on("message", (data) => {
			const text = data.toString();
			seen.messages.push(text);
			behaviour(socket, text);
		});
		socket.on("close", () => {
			seen.closed = true;
		});
	});
});

after(async () => {
	for (const client of server.clients) {
		client.terminate();
	}
	await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** The most recent handshake, after the server has had a moment to see it. */
async function last(): Promise<Handshake> {
	await new Promise((resolve) => setTimeout(resolve, 20));
	const handshake = handshakes.at(-1);
	assert.ok(handshake, "the server saw a connection");
	return handshake;
}

function template(overrides: Partial<WebSocketTemplate> = {}): WebSocketTemplate {
	return { url: `ws://127.0.0.1:${port}/tools`, messageFields: [], headers: {}, headerFields: [], ...overrides };
}

function call<T = unknown>(overrides: Partial<WebSocketTemplate> = {}, args: Record<string, unknown> = {}): ToolCall<"websocket", T> {
	return { protocol: "websocket", tool: "ask", template: template(overrides), args };
}

function client(options: Partial<ConstructorParameters<typeof WebSocketClient>[0]> = {}): WebSocketClient<string> {
	return new WebSocketClient<string>({ variables: { KEY: "k1" }, maxResponseBytes: 256, ...options });
}

const echo: Behaviour = (socket, message) => socket.send(message);

function isCode(code: string): (error: unknown) => boolean {
	return (error) => error instanceof RoveError && error.code === code;
}

describe("websocket messages", () => {
	test("maxResponseBytes is required", () => {
		assert.throws(() => new WebSocketClient({ variables: {} } as never), isCode("unsupported_value"));
	});

	test("without a message template the arguments are sent as JSON, header fields left out", async () => {
		behaviour = echo;
		const reply = await client().call(call({ headerFields: ["x-trace"], responseFormat: "json" }, { q: "hi", n: 2, "x-trace": "t" }));
		assert.deepEqual(reply, { q: "hi", n: 2 });
	});

	test("an object template is filled leaf by leaf and serialised", async () => {
		behaviour = echo;
		const reply = await client().call(
			call(
				{ message: { op: "search", q: "UTCP_ARG_q_UTCP_ARG", n: "UTCP_ARG_n_UTCP_ARG", fixed: 1 }, messageFields: ["q", "n"], responseFormat: "json" },
				{ q: "say \"hi\"", n: 3 }
			)
		);
		assert.deepEqual(reply, { op: "search", q: "say \"hi\"", n: "3", fixed: 1 });
	});

	test("a JSON-shaped string template escapes string arguments so a quote cannot break out", async () => {
		behaviour = echo;
		const reply = await client().call(
			call({ message: "{\"q\": \"UTCP_ARG_q_UTCP_ARG\"}", messageFields: ["q"], responseFormat: "json" }, { q: "\", \"admin\": true, \"x\": \"" })
		);
		assert.deepEqual(reply, { q: "\", \"admin\": true, \"x\": \"" });
	});

	test("a plain string template inserts strings as written and other values as JSON", async () => {
		behaviour = echo;
		const reply = await client().call(
			call({ message: "GET UTCP_ARG_id_UTCP_ARG UTCP_ARG_opts_UTCP_ARG", messageFields: ["id", "opts"], responseFormat: "text" }, { id: "a b", opts: { x: 1 } })
		);
		assert.equal(reply, "GET a b {\"x\":1}");
	});

	test("an argument whose name runs into the marker's underscores is still found", async () => {
		behaviour = echo;
		const reply = await client().call(call({ message: "UTCP_ARG_user_id_UTCP_ARG", messageFields: ["user_id"], responseFormat: "text" }, { user_id: "u1" }));
		assert.equal(reply, "u1");
	});

	test("a placeholder whose argument is absent is refused before connecting", async () => {
		const before = handshakes.length;
		await assert.rejects(client().call(call({ message: "UTCP_ARG_q_UTCP_ARG", messageFields: ["q"] }, {})), isCode("unsupported_value"));
		assert.equal(handshakes.length, before);
	});
});

describe("websocket handshakes", () => {
	test("template headers, header fields and the subprotocol reach the server", async () => {
		behaviour = echo;
		await client().call(call({ headers: { "x-app": "rove" }, headerFields: ["x-trace"], protocol: "tools.v1" }, { "x-trace": "abc" }));
		const handshake = await last();
		assert.equal(handshake.headers["x-app"], "rove");
		assert.equal(handshake.headers["x-trace"], "abc");
		assert.equal(handshake.protocol, "tools.v1");
	});

	test("an api key goes in a header, the query or a cookie, as the auth says", async () => {
		behaviour = echo;
		await client().call(call({ auth: { type: "api_key", key: "$KEY", name: "X-Api-Key", location: "header" } }));
		assert.equal((await last()).headers["x-api-key"], "k1");

		await client().call(call({ auth: { type: "api_key", key: "$KEY", name: "token", location: "query" } }));
		assert.equal((await last()).url, "/tools?token=k1");

		await client().call(call({ auth: { type: "api_key", key: "$KEY", name: "session", location: "cookie" } }));
		assert.equal((await last()).headers["cookie"], "session=k1");
	});

	test("basic auth is sent in the handshake", async () => {
		behaviour = echo;
		await client().call(call({ auth: { type: "basic", username: "u", password: "$KEY" } }));
		assert.equal((await last()).headers["authorization"], `Basic ${base64("u:k1")}`);
	});

	test("oauth2 fetches a token through the transport and sends it as Bearer", async () => {
		behaviour = echo;
		const { transport, seen } = scripted(json({ access_token: "tok", token_type: "bearer", expires_in: 60 }));
		await client({ transport }).call(call({ auth: { type: "oauth2", tokenUrl: "https://auth.example.com/t", clientId: "i", clientSecret: "s" } }));
		assert.equal((await last()).headers["authorization"], "Bearer tok");
		assert.equal(seen.length, 1);
	});

	test("ws to a public host is refused; wss or loopback is required", async () => {
		await assert.rejects(client().call(call({ url: "ws://tools.example.com/x" })), isCode("insecure_url"));
	});

	test("a header argument with a line break is refused", async () => {
		await assert.rejects(client().call(call({ headerFields: ["h"] }, { h: "a\r\nb: c" })), isCode("unsupported_value"));
	});

	test("a custom factory opens the connection", async () => {
		behaviour = echo;
		const opened: string[] = [];
		const reply = await client({
			webSocket: (url, init) => {
				opened.push(url);
				return new WebSocket(url, [...init.protocols]);
			},
		}).call(call({ responseFormat: "text" }, { a: 1 }));
		assert.deepEqual(opened, [`ws://127.0.0.1:${port}/tools`]);
		assert.equal(reply, "{\"a\":1}");
	});

	test("each call opens its own connection and closes it afterwards", async () => {
		behaviour = echo;
		const before = handshakes.length;
		await Promise.all([client().call(call({}, { a: 1 })), client().call(call({}, { a: 2 }))]);
		await last();
		const mine = handshakes.slice(before);
		assert.equal(mine.length, 2);
		assert.ok(mine.every((handshake) => handshake.closed));
	});
});

describe("websocket replies", () => {
	test("raw returns a text message as a string and a binary one as bytes", async () => {
		behaviour = (socket) => socket.send("plain");
		assert.equal(await client().call(call()), "plain");
		behaviour = (socket) => socket.send(Buffer.from([1, 2, 3]));
		assert.deepEqual(await client().call(call()), new Uint8Array([1, 2, 3]));
	});

	test("text decodes a binary message as UTF-8", async () => {
		behaviour = (socket) => socket.send(Buffer.from("\u2603"));
		assert.equal(await client().call(call({ responseFormat: "text" })), "\u2603");
	});

	test("json that is not JSON is decode_failed", async () => {
		behaviour = (socket) => socket.send("nope");
		await assert.rejects(client().call(call({ responseFormat: "json" })), (error: unknown) =>
			error instanceof RoveError && error.code === "decode_failed" && error.body === "nope"
		);
	});

	test("a server that closes without replying is protocol_error", async () => {
		behaviour = (socket) => socket.close(1000);
		await assert.rejects(client().call(call()), isCode("protocol_error"));
	});

	test("a server that closes with an error code is transport_failed with the code", async () => {
		behaviour = (socket) => socket.close(1011, "internal");
		await assert.rejects(client().call(call()), (error: unknown) =>
			error instanceof RoveError && error.code === "transport_failed" && error.status === 1011 && error.message.includes("internal")
		);
	});

	test("a message over maxResponseBytes is protocol_error", async () => {
		behaviour = (socket) => socket.send("x".repeat(300));
		await assert.rejects(client().call(call()), isCode("protocol_error"));
	});

	test("a connection that cannot be opened is transport_failed", async () => {
		await assert.rejects(client().call(call({ url: "ws://127.0.0.1:1/x" })), isCode("transport_failed"));
	});

	test("stream yields every message until the server closes", async () => {
		behaviour = (socket) => {
			socket.send("1");
			socket.send("2");
			socket.send("3");
			socket.close(1000);
		};
		const got: unknown[] = [];
		for await (const message of client().stream(call({ responseFormat: "json" }))) {
			got.push(message);
		}
		assert.deepEqual(got, [1, 2, 3]);
	});

	test("breaking out of a stream closes the connection", async () => {
		behaviour = (socket) => {
			const timer = setInterval(() => socket.send("tick"), 5);
			socket.on("close", () => clearInterval(timer));
		};
		for await (const message of client().stream(call())) {
			assert.equal(message, "tick");
			break;
		}
		assert.equal((await last()).closed, true);
	});

	test("aborting rejects with the caller's reason and closes the connection", async () => {
		behaviour = () => undefined;
		const controller = new AbortController();
		const reason = new Error("stop");
		const pending = client().call(call(), { signal: controller.signal });
		await new Promise((resolve) => setTimeout(resolve, 30));
		controller.abort(reason);
		await assert.rejects(pending, (error) => error === reason);
		assert.equal((await last()).closed, true);
	});

	test("an already-aborted signal opens nothing", async () => {
		const before = handshakes.length;
		const reason = new Error("never");
		await assert.rejects(client().call(call(), { signal: AbortSignal.abort(reason) }), (error) => error === reason);
		assert.equal(handshakes.length, before);
	});
});
