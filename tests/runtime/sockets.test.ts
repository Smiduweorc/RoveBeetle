import assert from "node:assert/strict";
import { createSocket, type Socket as UdpSocket } from "node:dgram";
import { createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { after, before, describe, test } from "node:test";

import type { TcpFraming, TcpTemplate, ToolCall, UdpTemplate } from "../../src/call.js";
import { RoveError } from "../../src/errors.js";
import { TcpClient } from "../../src/protocols/tcp.js";
import { UdpClient } from "../../src/protocols/udp.js";

function isCode(code: string): (error: unknown) => boolean {
	return (error) => error instanceof RoveError && error.code === code;
}

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);
const text = (value: string): Uint8Array => new TextEncoder().encode(value);

describe("tcp calls", () => {
	let server: Server;
	let port: number;
	/** What the server received on the last connection, and how it answers. */
	let received: Uint8Array = new Uint8Array();
	let answer: (socket: Socket, request: Uint8Array) => void = () => undefined;

	before(async () => {
		server = createServer((socket) => {
			received = new Uint8Array();
			socket.on("data", (chunk) => {
				received = new Uint8Array([...received, ...new Uint8Array(chunk as Buffer)]);
				answer(socket, received);
			});
			socket.on("error", () => undefined);
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
		port = (server.address() as AddressInfo).port;
	});

	after(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});

	function template(framing: TcpFraming, overrides: Partial<TcpTemplate> = {}): TcpTemplate {
		return {
			host: "127.0.0.1",
			port,
			requestFormat: "json",
			requestFields: [],
			responseEncoding: "utf-8",
			framing,
			...overrides,
		};
	}

	function call<T = unknown>(framing: TcpFraming, overrides: Partial<TcpTemplate> = {}, args: Record<string, unknown> = {}): ToolCall<"tcp", T> {
		return { protocol: "tcp", tool: "lookup", template: template(framing, overrides), args };
	}

	const client = (maxResponseBytes = 1024): TcpClient<string> => new TcpClient<string>({ variables: { HOST: "127.0.0.1" }, maxResponseBytes });
	const stream: TcpFraming = { strategy: "stream", maxResponseSize: 1024 };

	test("maxResponseBytes is required", () => {
		assert.throws(() => new TcpClient({ variables: {} } as never), isCode("unsupported_value"));
	});

	test("a json request is the arguments as JSON, and stream framing reads until the server closes", async () => {
		answer = (socket) => socket.end("pong");
		assert.equal(await client().call(call(stream, {}, { q: "a", n: 1 })), "pong");
		assert.equal(new TextDecoder().decode(received), "{\"q\":\"a\",\"n\":1}");
	});

	test("the host may be a variable", async () => {
		answer = (socket) => socket.end("ok");
		assert.equal(await client().call(call(stream, { host: "$HOST" })), "ok");
	});

	test("a text request fills its template, strings as written and the rest as JSON", async () => {
		answer = (socket) => socket.end("ok");
		await client().call(
			call(stream, { requestFormat: "text", requestTemplate: "GET UTCP_ARG_key_UTCP_ARG UTCP_ARG_n_UTCP_ARG", requestFields: ["key", "n"] }, { key: "\"a\"", n: 2 })
		);
		assert.equal(new TextDecoder().decode(received), "GET \"a\" 2");
	});

	test("a text request with no template joins the argument values with spaces", async () => {
		answer = (socket) => socket.end("ok");
		await client().call(call(stream, { requestFormat: "text" }, { a: "x y", b: 3, c: true }));
		assert.equal(new TextDecoder().decode(received), "x y 3 true");
	});

	test("a placeholder whose argument is absent is refused before connecting", async () => {
		await assert.rejects(
			client().call(call(stream, { requestFormat: "text", requestTemplate: "UTCP_ARG_k_UTCP_ARG", requestFields: ["k"] })),
			isCode("unsupported_value")
		);
	});

	for (const [prefixBytes, endian, expected] of [
		[1, "big", [5]],
		[2, "big", [0, 5]],
		[2, "little", [5, 0]],
		[4, "big", [0, 0, 0, 5]],
		[4, "little", [5, 0, 0, 0]],
		[8, "big", [0, 0, 0, 0, 0, 0, 0, 5]],
		[8, "little", [5, 0, 0, 0, 0, 0, 0, 0]],
	] as const) {
		test(`a ${prefixBytes}-byte ${endian}-endian length prefix frames the request and the response`, async () => {
			const framing: TcpFraming = { strategy: "length_prefix", bytes: prefixBytes, endian };
			answer = (socket, request) => {
				if (request.byteLength >= prefixBytes + 5) {
					// Reply "world" behind the same kind of prefix, in two writes.
					socket.write(bytes(...expected));
					socket.write(text("world"));
				}
			};
			assert.equal(await client().call(call(framing, { requestFormat: "text", requestTemplate: "hello" })), "world");
			assert.deepEqual([...received], [...expected, ...text("hello")]);
		});
	}

	test("bytes after a length-prefixed response are ignored", async () => {
		answer = (socket) => socket.write(bytes(2, ...text("ok"), ...text("trailing")));
		assert.equal(await client().call(call({ strategy: "length_prefix", bytes: 1, endian: "big" })), "ok");
	});

	test("a request longer than its length prefix can hold is refused before connecting", async () => {
		await assert.rejects(
			client().call(call({ strategy: "length_prefix", bytes: 1, endian: "big" }, { requestFormat: "text", requestTemplate: "x".repeat(256) })),
			isCode("protocol_error")
		);
	});

	test("a request of exactly 255 bytes fits a one-byte prefix", async () => {
		answer = (socket, request) => {
			if (request.byteLength === 256) {
				socket.write(bytes(1, ...text("y")));
			}
		};
		assert.equal(await client().call(call({ strategy: "length_prefix", bytes: 1, endian: "big" }, { requestFormat: "text", requestTemplate: "x".repeat(255) })), "y");
	});

	test("a declared response length over the limit fails before the rest arrives", async () => {
		answer = (socket) => socket.write(bytes(0, 0, 4, 0));
		await assert.rejects(client(1000).call(call({ strategy: "length_prefix", bytes: 4, endian: "big" })), isCode("protocol_error"));
	});

	test("an eight-byte prefix beyond what a number can hold is over any limit", async () => {
		answer = (socket) => socket.write(bytes(0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff));
		await assert.rejects(client().call(call({ strategy: "length_prefix", bytes: 8, endian: "big" })), isCode("protocol_error"));
	});

	test("delimiter framing appends the delimiter and reads up to it, across chunks", async () => {
		answer = (socket, request) => {
			if (new TextDecoder().decode(request).endsWith("\r\n")) {
				socket.write("hel");
				socket.write("lo\r");
				socket.write("\nmore");
			}
		};
		assert.equal(await client().call(call({ strategy: "delimiter", delimiter: "\r\n" }, { requestFormat: "text", requestTemplate: "ping" })), "hello");
		assert.equal(new TextDecoder().decode(received), "ping\r\n");
	});

	test("a NUL delimiter works", async () => {
		answer = (socket) => socket.write(bytes(...text("a"), 0));
		assert.equal(await client().call(call({ strategy: "delimiter", delimiter: "\u0000" })), "a");
	});

	test("a delimiter that never comes fails at the limit", async () => {
		answer = (socket) => socket.write("x".repeat(40));
		await assert.rejects(client(10).call(call({ strategy: "delimiter", delimiter: "\n" })), isCode("protocol_error"));
	});

	test("fixed length framing reads exactly that many bytes", async () => {
		answer = (socket) => {
			socket.write("abc");
			socket.write("defgh");
		};
		assert.equal(await client().call(call({ strategy: "fixed_length", length: 5 })), "abcde");
	});

	test("a fixed length over the limit is refused", async () => {
		answer = (socket) => socket.write("abcdef");
		await assert.rejects(client(4).call(call({ strategy: "fixed_length", length: 5 })), isCode("protocol_error"));
	});

	test("stream framing fails at max_response_size rather than truncating", async () => {
		answer = (socket) => socket.end("x".repeat(20));
		await assert.rejects(client().call(call({ strategy: "stream", maxResponseSize: 19 })), isCode("protocol_error"));
		answer = (socket) => socket.end("x".repeat(19));
		assert.equal((await client().call(call<string>({ strategy: "stream", maxResponseSize: 19 }))).length, 19);
	});

	test("stream framing also stops at the client's maxResponseBytes", async () => {
		answer = (socket) => socket.end("x".repeat(20));
		await assert.rejects(client(10).call(call({ strategy: "stream", maxResponseSize: 1000 })), isCode("protocol_error"));
	});

	test("a server that closes before the frame is complete is transport_failed", async () => {
		answer = (socket) => socket.end(bytes(5, ...text("ab")));
		await assert.rejects(client().call(call({ strategy: "length_prefix", bytes: 1, endian: "big" })), isCode("transport_failed"));
	});

	test("no response encoding returns the bytes", async () => {
		answer = (socket) => socket.end(bytes(0, 255));
		assert.deepEqual(await client().call(call(stream, { responseEncoding: null })), bytes(0, 255));
	});

	test("bytes that are not valid in the encoding are decode_failed", async () => {
		answer = (socket) => socket.end(bytes(0xff, 0xfe));
		await assert.rejects(client().call(call(stream)), isCode("decode_failed"));
	});

	test("another encoding is honoured", async () => {
		answer = (socket) => socket.end(bytes(0xe9));
		assert.equal(await client().call(call(stream, { responseEncoding: "latin1" })), "\u00e9");
	});

	test("a refused connection is transport_failed", async () => {
		await assert.rejects(client().call(call(stream, { port: 1 })), isCode("transport_failed"));
	});

	test("aborting while waiting rejects with the caller's reason", async () => {
		answer = () => undefined;
		const controller = new AbortController();
		const reason = new Error("stop");
		const pending = client().call(call(stream), { signal: controller.signal });
		setTimeout(() => controller.abort(reason), 20);
		await assert.rejects(pending, (error) => error === reason);
	});
});

describe("udp calls", () => {
	let server: UdpSocket;
	let port: number;
	let received: string[] = [];
	let replies = 1;
	/** When set, this socket answers the client first, from a port the client did not call. */
	let intruder: UdpSocket | undefined;

	before(async () => {
		server = createSocket("udp4");
		server.on("message", (message, from) => {
			received.push(message.toString());
			intruder?.send("intruder;", from.port, from.address);
			for (let index = 1; index <= replies; index += 1) {
				server.send(`part${index};`, from.port, from.address);
			}
		});
		await new Promise<void>((resolve) => server.bind(0, "127.0.0.1", () => resolve()));
		port = server.address().port;
	});

	after(() => {
		server.close();
	});

	function call<T = unknown>(overrides: Partial<UdpTemplate> = {}, args: Record<string, unknown> = {}): ToolCall<"udp", T> {
		return {
			protocol: "udp",
			tool: "ping",
			template: { host: "127.0.0.1", port, requestFormat: "json", requestFields: [], responseEncoding: "utf-8", datagrams: 1, ...overrides },
			args,
		};
	}

	const client = (maxResponseBytes = 1024): UdpClient<string> => new UdpClient<string>({ variables: {}, maxResponseBytes });

	test("one datagram out as JSON, one back", async () => {
		received = [];
		replies = 1;
		assert.equal(await client().call(call({}, { a: 1 })), "part1;");
		assert.deepEqual(received, ["{\"a\":1}"]);
	});

	test("several datagrams are joined in arrival order", async () => {
		replies = 3;
		assert.equal(await client().call(call({ datagrams: 3 })), "part1;part2;part3;");
	});

	test("zero datagrams resolves once sent, with an empty result", async () => {
		received = [];
		replies = 0;
		assert.equal(await client().call(call({ datagrams: 0 }, { a: 2 })), "");
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.deepEqual(received, ["{\"a\":2}"]);
	});

	test("a datagram from another port is ignored", async () => {
		replies = 1;
		intruder = createSocket("udp4");
		const bound = intruder;
		await new Promise<void>((resolve) => bound.bind(0, "127.0.0.1", () => resolve()));
		try {
			assert.equal(await client().call(call()), "part1;");
		} finally {
			intruder.close();
			intruder = undefined;
		}
	});

	test("a missing datagram waits until the signal aborts", async () => {
		replies = 1;
		const reason = new Error("lost");
		const controller = new AbortController();
		const pending = client().call(call({ datagrams: 2 }), { signal: controller.signal });
		setTimeout(() => controller.abort(reason), 50);
		await assert.rejects(pending, (error) => error === reason);
	});

	test("datagrams over the limit are protocol_error", async () => {
		replies = 3;
		await assert.rejects(client(10).call(call({ datagrams: 3 })), isCode("protocol_error"));
	});

	test("no response encoding returns the bytes", async () => {
		replies = 1;
		assert.deepEqual(await client().call(call({ responseEncoding: null })), text("part1;"));
	});

	test("a host that does not resolve is transport_failed", async () => {
		await assert.rejects(client().call(call({ host: "no-such-host.invalid" })), isCode("transport_failed"));
	});
});
