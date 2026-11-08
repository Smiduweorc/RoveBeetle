import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { StreamableHttpTemplate, ToolCall } from "../../src/call.js";
import { RoveError } from "../../src/errors.js";
import { readLines } from "../../src/lines.js";
import { StreamableHttpClient } from "../../src/protocols/streamable-http.js";
import { scripted } from "./transport.js";

function body(...chunks: (string | Uint8Array)[]): ReadableStream<Uint8Array> {
	const queue = chunks.map((chunk) => (typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk));
	return new ReadableStream({
		pull(controller) {
			const next = queue.shift();
			if (next === undefined) {
				controller.close();
			} else {
				controller.enqueue(next);
			}
		},
	});
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = [];
	for await (const item of iterable) {
		out.push(item);
	}
	return out;
}

function isCode(code: string): (error: unknown) => boolean {
	return (error) => error instanceof RoveError && error.code === code;
}

const lines = (stream: ReadableStream<Uint8Array>, limit = 64): Promise<string[]> =>
	collect(readLines(stream, limit, "t", "target", undefined));

describe("reading lines", () => {
	test("lines split at LF, a CR before the LF is dropped, and blank lines are skipped", async () => {
		assert.deepEqual(await lines(body("a\r\n\n  \nb\n")), ["a", "b"]);
	});

	test("a line split across chunks arrives whole, unicode included", async () => {
		const bytes = new TextEncoder().encode("{\"s\":\"\u2603\"}\n");
		assert.deepEqual(await lines(body(bytes.slice(0, 8), bytes.slice(8))), ["{\"s\":\"\u2603\"}"]);
	});

	test("a last line without a newline is still yielded", async () => {
		assert.deepEqual(await lines(body("a\nb")), ["a", "b"]);
	});

	test("many lines in one chunk all arrive", async () => {
		assert.deepEqual(await lines(body("1\n2\n3\n")), ["1", "2", "3"]);
	});

	test("a line of exactly the limit is read and one byte more fails", async () => {
		assert.deepEqual(await lines(body("12345\n"), 5), ["12345"]);
		await assert.rejects(lines(body("123456\n"), 5), isCode("protocol_error"));
	});

	test("a line that never ends fails at the limit instead of buffering forever", async () => {
		await assert.rejects(lines(body("123", "456", "789"), 5), isCode("protocol_error"));
	});
});

function template(overrides: Partial<StreamableHttpTemplate> = {}): StreamableHttpTemplate {
	return {
		url: "https://api.example.com/export",
		pathFields: [],
		method: "GET",
		contentType: "application/octet-stream",
		headers: {},
		headerFields: [],
		...overrides,
	};
}

function call(overrides: Partial<StreamableHttpTemplate> = {}, args: Record<string, unknown> = {}): ToolCall<"streamable_http", unknown> {
	return { protocol: "streamable_http", tool: "export", template: template(overrides), args };
}

function client(...answers: Parameters<typeof scripted>): {
	streams: StreamableHttpClient<string>;
	seen: ReturnType<typeof scripted>["seen"];
} {
	const { transport, seen } = scripted(...answers);
	return { streams: new StreamableHttpClient<string>({ variables: {}, transport, maxResponseBytes: 64 }), seen };
}

describe("streamable_http calls", () => {
	test("maxResponseBytes is required", () => {
		assert.throws(() => new StreamableHttpClient({ variables: {} } as never), isCode("unsupported_value"));
	});

	test("NDJSON yields each line parsed", async () => {
		const { streams } = client(new Response(body("{\"a\":1}\n", "[2]\n\n3\n"), { headers: { "content-type": "application/x-ndjson" } }));
		assert.deepEqual(await collect(streams.stream(call())), [{ a: 1 }, [2], 3]);
	});

	test("an NDJSON line that is not JSON is decode_failed with the line as body", async () => {
		const { streams } = client(new Response("{\"a\":1}\nnope\n", { headers: { "content-type": "application/x-ndjson" } }));
		const seen: unknown[] = [];
		await assert.rejects(
			(async () => {
				for await (const item of streams.stream(call())) {
					seen.push(item);
				}
			})(),
			(error: unknown) => error instanceof RoveError && error.code === "decode_failed" && error.body === "nope"
		);
		assert.deepEqual(seen, [{ a: 1 }]);
	});

	test("JSON yields the whole body once", async () => {
		const { streams } = client(new Response(body("{\"a\":", "[1,2]}"), { headers: { "content-type": "application/json" } }));
		assert.deepEqual(await collect(streams.stream(call())), [{ a: [1, 2] }]);
	});

	test("a JSON body over the limit is protocol_error", async () => {
		const { streams } = client(new Response(JSON.stringify("x".repeat(100)), { headers: { "content-type": "application/json" } }));
		await assert.rejects(collect(streams.stream(call())), isCode("protocol_error"));
	});

	test("an empty JSON body yields nothing", async () => {
		const { streams } = client(new Response("", { headers: { "content-type": "application/json" } }));
		assert.deepEqual(await collect(streams.stream(call())), []);
	});

	test("any other content type yields the byte chunks as they arrive, with no limit on the total", async () => {
		const big = new Uint8Array(100).fill(7);
		const { streams } = client(new Response(body(big, big), { headers: { "content-type": "application/octet-stream" } }));
		const chunks = await collect(streams.stream(call()));
		assert.equal(chunks.length, 2);
		assert.ok(chunks.every((chunk) => chunk instanceof Uint8Array && chunk.length === 100));
	});

	test("a body is sent with the template's content type", async () => {
		const { streams, seen } = client(new Response(body(), { headers: { "content-type": "text/plain" } }));
		await collect(streams.stream(call({ method: "POST", bodyField: "data", contentType: "text/csv" }, { data: "a,b" })));
		assert.equal(seen[0]?.method, "POST");
		assert.equal(seen[0]?.headers["content-type"], "text/csv");
		assert.equal(seen[0]?.body, "a,b");
	});

	test("a redirect is refused", async () => {
		const { streams } = client(new Response(null, { status: 302, headers: { location: "/x" } }));
		await assert.rejects(collect(streams.stream(call())), isCode("redirect_not_followed"));
	});

	test("a non-2xx status is a status error", async () => {
		const { streams } = client(new Response("bad", { status: 400 }));
		await assert.rejects(collect(streams.stream(call())), (error: unknown) => error instanceof RoveError && error.status === 400);
	});

	test("breaking out of the loop cancels the body", async () => {
		let cancelled = false;
		const endless = new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.enqueue(new Uint8Array([1]));
			},
			cancel() {
				cancelled = true;
			},
		});
		const { streams } = client(new Response(endless, { headers: { "content-type": "application/octet-stream" } }));
		for await (const _chunk of streams.stream(call())) {
			break;
		}
		assert.equal(cancelled, true);
	});

	test("a body that fails mid-stream is transport_failed", async () => {
		let sent = false;
		const failing = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (sent) {
					controller.error(new Error("reset"));
					return;
				}
				sent = true;
				controller.enqueue(new Uint8Array([1]));
			},
		});
		const { streams } = client(new Response(failing, { headers: { "content-type": "application/octet-stream" } }));
		await assert.rejects(collect(streams.stream(call())), isCode("transport_failed"));
	});
});
