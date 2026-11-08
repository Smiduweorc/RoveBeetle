import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { SseTemplate, ToolCall } from "../../src/call.js";
import { RoveError } from "../../src/errors.js";
import { SseClient } from "../../src/protocols/sse.js";
import { readEvents, type ServerSentEvent } from "../../src/sse.js";
import { scripted } from "./transport.js";

/** A body that delivers exactly these chunks, so tests choose where they split. */
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

async function events(stream: ReadableStream<Uint8Array>, limit = 1024): Promise<ServerSentEvent[]> {
	const out: ServerSentEvent[] = [];
	for await (const event of readEvents(stream, limit, "t", "https://a.example.com/s", undefined)) {
		out.push(event);
	}
	return out;
}

const data = (list: ServerSentEvent[]): string[] => list.map((event) => event.data);

describe("parsing an event stream", () => {
	test("an event is dispatched at a blank line, with type message by default", async () => {
		assert.deepEqual(await events(body("data: hello\n\n")), [{ type: "message", data: "hello", lastEventId: "" }]);
	});

	test("LF, CR and CRLF all end lines", async () => {
		assert.deepEqual(data(await events(body("data: a\n\ndata: b\r\rdata: c\r\n\r\n"))), ["a", "b", "c"]);
	});

	test("a CRLF split across two chunks is one line ending, not two", async () => {
		assert.deepEqual(data(await events(body("data: a\r", "\ndata: b\r\n\r\n"))), ["a\nb"]);
	});

	test("a CR at the end of the stream still ends the line", async () => {
		assert.deepEqual(data(await events(body("data: a\r\r"))), ["a"]);
	});

	test("data lines join with newlines", async () => {
		assert.deepEqual(data(await events(body("data: one\ndata:two\ndata:  three\n\n"))), ["one\ntwo\n three"]);
	});

	test("only one space after the colon is dropped", async () => {
		assert.deepEqual(data(await events(body("data:  x\n\n"))), [" x"]);
	});

	test("a field with no colon has an empty value, so a bare data line is an empty payload", async () => {
		assert.deepEqual(data(await events(body("data\n\n"))), [""]);
	});

	test("comments and unknown fields are skipped", async () => {
		assert.deepEqual(data(await events(body(": keep-alive\nfoo: bar\nretry: 10\ndata: x\n\n"))), ["x"]);
	});

	test("an event with no data is not dispatched", async () => {
		assert.deepEqual(await events(body("event: ping\n\nid: 7\n\n")), []);
	});

	test("event names the type and lasts for one event only", async () => {
		const list = await events(body("event: update\ndata: 1\n\ndata: 2\n\n"));
		assert.deepEqual(
			list.map((event) => event.type),
			["update", "message"]
		);
	});

	test("the last event ID carries over to later events, and one containing NUL is ignored", async () => {
		const list = await events(body("id: 1\ndata: a\n\ndata: b\n\nid: x\u0000y\ndata: c\n\n"));
		assert.deepEqual(
			list.map((event) => event.lastEventId),
			["1", "1", "1"]
		);
	});

	test("a byte order mark at the start is dropped", async () => {
		assert.deepEqual(await events(body(new Uint8Array([0xef, 0xbb, 0xbf]), "data: x\n\n")), [{ type: "message", data: "x", lastEventId: "" }]);
	});

	test("a UTF-8 character split across chunks arrives whole", async () => {
		const bytes = new TextEncoder().encode("data: \u2603\n\n");
		assert.deepEqual(data(await events(body(bytes.slice(0, 7), bytes.slice(7)))), ["\u2603"]);
	});

	test("an event the stream did not end with a blank line is discarded", async () => {
		assert.deepEqual(data(await events(body("data: a\n\ndata: unfinished\n"))), ["a"]);
	});

	test("an event of exactly the limit is dispatched and one byte more fails", async () => {
		// "data: abc\n" is 10 bytes.
		assert.deepEqual(data(await events(body("data: abc\n\n"), 10)), ["abc"]);
		await assert.rejects(events(body("data: abcd\n\n"), 10), (error: unknown) => error instanceof RoveError && error.code === "protocol_error");
	});

	test("the limit applies to a line that never ends, so the buffer cannot grow without bound", async () => {
		await assert.rejects(events(body("data: ", "x".repeat(600), "x".repeat(600))), (error: unknown) =>
			error instanceof RoveError && error.code === "protocol_error"
		);
	});

	test("the limit resets for each event", async () => {
		assert.deepEqual(data(await events(body("data: abc\n\ndata: def\n\n"), 10)), ["abc", "def"]);
	});

	test("a body that stops arriving is transport_failed", async () => {
		const failing = new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("data: a\n\n"));
			},
			pull(controller) {
				controller.error(new Error("reset"));
			},
		});
		const seen: string[] = [];
		await assert.rejects(
			(async () => {
				for await (const event of readEvents(failing, 1024, "t", "x", undefined)) {
					seen.push(event.data);
				}
			})(),
			(error: unknown) => error instanceof RoveError && error.code === "transport_failed"
		);
		assert.deepEqual(seen, ["a"]);
	});
});

function template(overrides: Partial<SseTemplate> = {}): SseTemplate {
	return {
		url: "https://api.example.com/events",
		pathFields: [],
		headers: {},
		headerFields: [],
		dataFormat: "json",
		...overrides,
	};
}

function call<T = unknown>(overrides: Partial<SseTemplate> = {}, args: Record<string, unknown> = {}): ToolCall<"sse", T> {
	return { protocol: "sse", tool: "watch", template: template(overrides), args };
}

function stream(text: string | ReadableStream<Uint8Array>, init: ResponseInit = {}): Response {
	return new Response(typeof text === "string" ? body(text) : text, {
		...init,
		headers: { "content-type": "text/event-stream; charset=utf-8", ...(init.headers as Record<string, string> | undefined) },
	});
}

function client(...answers: Parameters<typeof scripted>): { sse: SseClient<string>; seen: ReturnType<typeof scripted>["seen"] } {
	const { transport, seen } = scripted(...answers);
	return { sse: new SseClient<string>({ variables: { KEY: "k" }, transport, maxResponseBytes: 1024 }), seen };
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

describe("sse calls", () => {
	test("maxResponseBytes is required", () => {
		assert.throws(() => new SseClient({ variables: {} } as never), isCode("unsupported_value"));
	});

	test("nothing is sent until the first event is asked for", async () => {
		const { sse, seen } = client(stream("data: 1\n\n"));
		const iterator = sse.stream(call());
		assert.equal(seen.length, 0);
		assert.deepEqual(await iterator.next(), { done: false, value: 1 });
		assert.equal(seen.length, 1);
	});

	test("without a body the request is a GET that asks for an event stream", async () => {
		const { sse, seen } = client(stream("data: 1\n\n"));
		await collect(sse.stream(call({}, { topic: "a" })));
		assert.equal(seen[0]?.method, "GET");
		assert.equal(seen[0]?.url, "https://api.example.com/events?topic=a");
		assert.equal(seen[0]?.headers["accept"], "text/event-stream");
		assert.equal(seen[0]?.redirect, "manual");
	});

	test("with a body the request is a POST sending the body as JSON", async () => {
		const { sse, seen } = client(stream("data: 1\n\n"));
		await collect(sse.stream(call({ bodyField: "body" }, { body: { q: 1 } })));
		assert.equal(seen[0]?.method, "POST");
		assert.equal(seen[0]?.headers["content-type"], "application/json");
		assert.equal(seen[0]?.body, "{\"q\":1}");
	});

	test("a template accept header is kept", async () => {
		const { sse, seen } = client(stream("data: 1\n\n"));
		await collect(sse.stream(call({ headers: { Accept: "text/event-stream, */*" } })));
		assert.equal(seen[0]?.headers["accept"], "text/event-stream, */*");
	});

	test("auth is applied as for http", async () => {
		const { sse, seen } = client(stream("data: 1\n\n"));
		await collect(sse.stream(call({ auth: { type: "api_key", key: "$KEY", name: "X-Api-Key", location: "header" } })));
		assert.equal(seen[0]?.headers["x-api-key"], "k");
	});

	test("events are decoded as JSON, in order", async () => {
		const { sse } = client(stream("data: {\"n\":1}\n\ndata: [2]\n\n"));
		assert.deepEqual(await collect(sse.stream(call())), [{ n: 1 }, [2]]);
	});

	test("text format keeps the data as written, even when it looks like JSON", async () => {
		const { sse } = client(stream("data: 123\n\n"));
		assert.deepEqual(await collect(sse.stream(call({ dataFormat: "text" }))), ["123"]);
	});

	test("auto format parses JSON and keeps anything else as text", async () => {
		const { sse } = client(stream("data: 123\n\ndata: hello\n\n"));
		assert.deepEqual(await collect(sse.stream(call({ dataFormat: "auto" }))), [123, "hello"]);
	});

	test("json format fails on data that is not JSON, with the data as body", async () => {
		const { sse } = client(stream("data: hello\n\n"));
		await assert.rejects(collect(sse.stream(call())), (error: unknown) =>
			error instanceof RoveError && error.code === "decode_failed" && error.body === "hello"
		);
	});

	test("only message events are yielded when the template names no event type", async () => {
		const { sse } = client(stream("event: ping\ndata: 0\n\ndata: 1\n\nevent: message\ndata: 2\n\n"));
		assert.deepEqual(await collect(sse.stream(call())), [1, 2]);
	});

	test("only events of the template's event type are yielded when it names one", async () => {
		const { sse } = client(stream("event: price\ndata: 1\n\ndata: 2\n\nevent: price\ndata: 3\n\n"));
		assert.deepEqual(await collect(sse.stream(call({ eventType: "price" }))), [1, 3]);
	});

	test("a response that is not an event stream is protocol_error", async () => {
		const { sse } = client(new Response("{}", { headers: { "content-type": "application/json" } }));
		await assert.rejects(collect(sse.stream(call())), isCode("protocol_error"));
	});

	test("a non-2xx status is a status error with the body", async () => {
		const { sse } = client(new Response("no", { status: 403 }));
		await assert.rejects(collect(sse.stream(call())), (error: unknown) =>
			error instanceof RoveError && error.code === "status" && error.status === 403 && error.body === "no"
		);
	});

	test("a redirect is refused, even within the origin", async () => {
		const { sse, seen } = client(new Response(null, { status: 307, headers: { location: "/events2" } }));
		await assert.rejects(collect(sse.stream(call())), isCode("redirect_not_followed"));
		assert.equal(seen.length, 1);
	});

	test("an event over maxResponseBytes fails the stream", async () => {
		const { transport } = scripted(stream(`data: ${"x".repeat(100)}\n\n`));
		const sse = new SseClient({ variables: {}, transport, maxResponseBytes: 50 });
		await assert.rejects(collect(sse.stream(call())), isCode("protocol_error"));
	});

	test("breaking out of the loop cancels the response body", async () => {
		let cancelled = false;
		const endless = new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.enqueue(new TextEncoder().encode("data: 1\n\n"));
			},
			cancel() {
				cancelled = true;
			},
		});
		const { sse } = client(stream(endless));
		for await (const event of sse.stream(call())) {
			assert.equal(event, 1);
			break;
		}
		assert.equal(cancelled, true);
	});

	test("aborting mid-stream rejects with the caller's reason", async () => {
		const reason = new Error("enough");
		const controller = new AbortController();
		const endless = new ReadableStream<Uint8Array>({
			pull(stream) {
				if (controller.signal.aborted) {
					stream.error(controller.signal.reason);
					return;
				}
				stream.enqueue(new TextEncoder().encode("data: 1\n\n"));
			},
		});
		const { sse } = client(stream(endless));
		await assert.rejects(
			(async () => {
				for await (const _event of sse.stream(call(), { signal: controller.signal })) {
					controller.abort(reason);
				}
			})(),
			(error) => error === reason
		);
	});
});
