import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { base64 } from "../../src/auth.js";
import type { HttpTemplate, ToolCall } from "../../src/call.js";
import { RoveError } from "../../src/errors.js";
import { HttpClient } from "../../src/protocols/http.js";
import { json, scripted } from "./transport.js";

function template(overrides: Partial<HttpTemplate> = {}): HttpTemplate {
	return {
		url: "https://api.example.com/v1/items",
		pathFields: [],
		method: "GET",
		contentType: "application/json",
		headers: {},
		headerFields: [],
		...overrides,
	};
}

function call<TResult = unknown>(
	overrides: Partial<HttpTemplate> = {},
	args: Record<string, unknown> = {}
): ToolCall<"http", TResult> {
	return { protocol: "http", tool: "list_items", template: template(overrides), args };
}

function client(
	...answers: Parameters<typeof scripted>
): { http: HttpClient<string>; seen: ReturnType<typeof scripted>["seen"] } {
	const { transport, seen } = scripted(...answers);
	return { http: new HttpClient<string>({ variables: { KEY: "k1", HOST: "api.example.com" }, transport, maxResponseBytes: 4096 }), seen };
}

function isCode(code: string): (error: unknown) => boolean {
	return (error) => error instanceof RoveError && error.code === code;
}

describe("constructing an http client", () => {
	test("variables is required, and {} is accepted", () => {
		assert.throws(() => new HttpClient(undefined as never), isCode("variable_missing"));
		assert.throws(() => new HttpClient({} as never), isCode("variable_missing"));
		assert.doesNotThrow(() => new HttpClient({ variables: {}, maxResponseBytes: 4096 }));
	});

	test("an empty variable value is refused at construction, not at the first call", () => {
		assert.throws(() => new HttpClient({ variables: { KEY: "" }, maxResponseBytes: 4096 }), isCode("variable_missing"));
	});

	test("constructing a client sends nothing", () => {
		const { seen } = client();
		assert.equal(seen.length, 0);
	});

	test("a call for another protocol is refused", async () => {
		const { http } = client();
		const sse = { protocol: "sse", tool: "x", template: template(), args: {} } as unknown as ToolCall<"http", unknown, string>;
		await assert.rejects(http.call(sse), isCode("unsupported_value"));
	});

	test("the default clock is Date.now, read for each token's expiry", async () => {
		const original = Date.now;
		let now = 1_000_000;
		Date.now = (): number => now;
		try {
			const { transport, seen } = scripted(
				json({ access_token: "t1", token_type: "bearer", expires_in: 60 }),
				json({}),
				json({ access_token: "t2", token_type: "bearer", expires_in: 60 }),
				json({})
			);
			const http = new HttpClient({ variables: {}, transport, maxResponseBytes: 4096 });
			const authed = call({ auth: { type: "oauth2", tokenUrl: "https://a.example.com/t", clientId: "i", clientSecret: "s" } });
			await http.call(authed);
			now += 60_000;
			await http.call(authed);
			assert.deepEqual(
				seen.map((request) => request.headers["authorization"]),
				[`Basic ${base64("i:s")}`, "Bearer t1", `Basic ${base64("i:s")}`, "Bearer t2"]
			);
		} finally {
			Date.now = original;
		}
	});

	test("the default transport is the global fetch, looked up at call time", async () => {
		const original = globalThis.fetch;
		let seen = "";
		const http = new HttpClient({ variables: {}, maxResponseBytes: 4096 });
		globalThis.fetch = (async (request: Request) => {
			seen = request.url;
			return json({ ok: true });
		}) as typeof fetch;
		try {
			assert.deepEqual(await http.call(call()), { ok: true });
			assert.equal(seen, "https://api.example.com/v1/items");
		} finally {
			globalThis.fetch = original;
		}
	});
});

describe("where arguments go", () => {
	test("header fields become headers, the body field the body, path fields the path, and the rest the query", async () => {
		const { http, seen } = client(json({}));
		await http.call(
			call(
				{
					url: "https://api.example.com/v1/users/{user_id}/posts",
					pathFields: ["user_id"],
					method: "POST",
					headerFields: ["x-trace"],
					bodyField: "body",
				},
				{ user_id: "u/1 ?", "x-trace": "abc", body: { title: "hi" }, limit: 10, draft: false }
			)
		);
		const [request] = seen;
		assert.equal(request?.method, "POST");
		assert.equal(request?.url, "https://api.example.com/v1/users/u%2F1%20%3F/posts?limit=10&draft=false");
		assert.equal(request?.headers["x-trace"], "abc");
		assert.equal(request?.headers["content-type"], "application/json");
		assert.equal(request?.body, "{\"title\":\"hi\"}");
	});

	test("a path field used twice is filled in both places", async () => {
		const { http, seen } = client(json({}));
		await http.call(call({ url: "https://a.example.com/{id}/x/{id}", pathFields: ["id"] }, { id: 7 }));
		assert.equal(seen[0]?.url, "https://a.example.com/7/x/7");
	});

	test("a brace in a variable's value is text, not a placeholder", async () => {
		const { transport, seen } = scripted(json({}));
		const http = new HttpClient({ variables: { SEG: "{id}" }, transport, maxResponseBytes: 4096 });
		await http.call({ protocol: "http", tool: "t", template: template({ url: "https://a.example.com/${SEG}" }), args: { id: 1 } });
		assert.equal(seen[0]?.url, "https://a.example.com/%7Bid%7D?id=1");
	});

	test("a missing path field is refused before anything is sent", async () => {
		const { http, seen } = client();
		await assert.rejects(http.call(call({ url: "https://a.example.com/{id}", pathFields: ["id"] }, {})), isCode("unsupported_value"));
		assert.equal(seen.length, 0);
	});

	test("an array goes on the query as one repeated key", async () => {
		const { http, seen } = client(json({}));
		await http.call(call({}, { tag: ["a", "b c", 3] }));
		assert.equal(seen[0]?.url, "https://api.example.com/v1/items?tag=a&tag=b+c&tag=3");
	});

	test("an empty array sends nothing", async () => {
		const { http, seen } = client(json({}));
		await http.call(call({}, { tag: [] }));
		assert.equal(seen[0]?.url, "https://api.example.com/v1/items");
	});

	test("null and undefined arguments send nothing", async () => {
		const { http, seen } = client(json({}));
		await http.call(call({ headerFields: ["h"] }, { a: null, b: undefined, h: null }));
		assert.equal(seen[0]?.url, "https://api.example.com/v1/items");
		assert.equal(seen[0]?.headers["h"], undefined);
	});

	test("query values that are unicode are percent-encoded as UTF-8", async () => {
		const { http, seen } = client(json({}));
		await http.call(call({}, { q: "gr\u00fc\u00dfe \u2603" }));
		assert.equal(seen[0]?.url, "https://api.example.com/v1/items?q=gr%C3%BC%C3%9Fe+%E2%98%83");
	});

	for (const [label, value] of [
		["an object", { a: 1 }],
		["an array holding an object", [{ a: 1 }]],
		["a nested array", [[1]]],
	] as const) {
		test(`${label} in the query is refused`, async () => {
			const { http, seen } = client();
			await assert.rejects(http.call(call({}, { filter: value })), isCode("unsupported_value"));
			assert.equal(seen.length, 0);
		});
	}

	test("an object as a header is refused", async () => {
		const { http } = client();
		await assert.rejects(http.call(call({ headerFields: ["h"] }, { h: { a: 1 } })), isCode("unsupported_value"));
	});

	for (const value of ["a\r\nx-evil: 1", "a\nb", "a\0b"]) {
		test(`a header argument containing ${JSON.stringify(value)} is refused, so it cannot add a header`, async () => {
			const { http, seen } = client();
			await assert.rejects(http.call(call({ headerFields: ["h"] }, { h: value })), isCode("unsupported_value"));
			assert.equal(seen.length, 0);
		});
	}

	test("a template header carrying a line break after substitution is refused", async () => {
		const { transport } = scripted();
		const http = new HttpClient({ variables: { V: "a\r\nb" }, transport, maxResponseBytes: 4096 });
		await assert.rejects(
			http.call({ protocol: "http", tool: "t", template: template({ headers: { h: "${V}" } }), args: {} }),
			isCode("unsupported_value")
		);
	});

	test("a header field argument overrides a template header of the same name", async () => {
		const { http, seen } = client(json({}));
		await http.call(call({ headers: { "x-mode": "fixed" }, headerFields: ["x-mode"] }, { "x-mode": "chosen" }));
		assert.equal(seen[0]?.headers["x-mode"], "chosen");
	});
});

describe("request bodies", () => {
	const post = (contentType: string, body: unknown, headers: Record<string, string> = {}): ToolCall<"http", unknown, string> =>
		call({ method: "POST", bodyField: "body", contentType, headers }, { body });

	test("application/json and +json types send JSON", async () => {
		const { http, seen } = client(json({}), json({}));
		await http.call(post("application/json", [1, "a"]));
		await http.call(post("application/merge-patch+json; charset=utf-8", "text"));
		assert.equal(seen[0]?.body, "[1,\"a\"]");
		assert.equal(seen[1]?.body, "\"text\"");
	});

	test("a form content type sends an object as form fields, arrays repeated", async () => {
		const { http, seen } = client(json({}));
		await http.call(post("application/x-www-form-urlencoded", { a: "x y", b: [1, 2], c: undefined, d: null }));
		assert.equal(seen[0]?.body, "a=x+y&b=1&b=2");
	});

	test("any other content type sends a string as written", async () => {
		const { http, seen } = client(json({}));
		await http.call(post("text/csv", "a,b\n1,2"));
		assert.equal(seen[0]?.body, "a,b\n1,2");
		assert.equal(seen[0]?.headers["content-type"], "text/csv");
	});

	test("an object with a content type that cannot carry it is refused", async () => {
		const { http, seen } = client();
		await assert.rejects(http.call(post("text/plain", { a: 1 })), isCode("unsupported_value"));
		assert.equal(seen.length, 0);
	});

	test("a content-type header in the template wins over contentType", async () => {
		const { http, seen } = client(json({}));
		await http.call(post("application/json", "raw", { "Content-Type": "text/plain" }));
		assert.equal(seen[0]?.headers["content-type"], "text/plain");
		assert.equal(seen[0]?.body, "raw");
	});

	test("no body argument means no body and no content type", async () => {
		const { http, seen } = client(json({}));
		await http.call(call({ method: "POST", bodyField: "body" }, {}));
		assert.equal(seen[0]?.body, "");
		assert.equal(seen[0]?.headers["content-type"], undefined);
	});

	test("without a body field, every argument goes on the query", async () => {
		const { http, seen } = client(json({}));
		await http.call(call({ method: "POST" }, { body: "x" }));
		assert.equal(seen[0]?.url, "https://api.example.com/v1/items?body=x");
	});
});

describe("auth on http calls", () => {
	test("an api key in the query replaces an argument with the same name", async () => {
		const { http, seen } = client(json({}));
		await http.call(call({ auth: { type: "api_key", key: "${KEY}", name: "key", location: "query" } }, { key: "spoof", a: 1 }));
		assert.equal(seen[0]?.url, "https://api.example.com/v1/items?key=k1&a=1");
	});

	test("an api key in a header replaces a header argument with the same name", async () => {
		const { http, seen } = client(json({}));
		await http.call(
			call({ headerFields: ["X-Api-Key"], auth: { type: "api_key", key: "$KEY", name: "X-Api-Key", location: "header" } }, { "X-Api-Key": "spoof" })
		);
		assert.equal(seen[0]?.headers["x-api-key"], "k1");
	});

	test("basic auth is sent as an Authorization header", async () => {
		const { http, seen } = client(json({}));
		await http.call(call({ auth: { type: "basic", username: "$KEY", password: "p" } }));
		assert.equal(seen[0]?.headers["authorization"], `Basic ${base64("k1:p")}`);
	});

	test("oauth2 fetches a token through the same transport, then sends it as Bearer", async () => {
		const { http, seen } = client(json({ access_token: "tok", token_type: "bearer", expires_in: 60 }), json({}), json({}));
		const authed = call({
			auth: { type: "oauth2", tokenUrl: "https://${HOST}/token", clientId: "id", clientSecret: "$KEY" },
		});
		await http.call(authed);
		await http.call(authed);
		assert.deepEqual(
			seen.map((request) => request.url),
			["https://api.example.com/token", "https://api.example.com/v1/items", "https://api.example.com/v1/items"]
		);
		assert.equal(seen[1]?.headers["authorization"], "Bearer tok");
		assert.equal(seen[0]?.headers["authorization"], `Basic ${base64("id:k1")}`);
	});

	test("a failed token request fails the call and sends nothing to the tool", async () => {
		const { http, seen } = client(new Response("", { status: 401 }));
		await assert.rejects(
			http.call(call({ auth: { type: "oauth2", tokenUrl: "https://a.example.com/t", clientId: "i", clientSecret: "s" } })),
			isCode("token_request_failed")
		);
		assert.equal(seen.length, 1);
	});

	test("a variable the client was not given fails the call with variable_missing", async () => {
		const { http, seen } = client();
		await assert.rejects(http.call(call({ auth: { type: "basic", username: "$NOPE", password: "x" } })), isCode("variable_missing"));
		assert.equal(seen.length, 0);
	});
});

describe("secure URLs on http calls", () => {
	test("plain http to a public host is refused after variables are filled", async () => {
		const { transport, seen } = scripted();
		const http = new HttpClient({ variables: { HOST: "api.example.com" }, transport, maxResponseBytes: 4096 });
		await assert.rejects(
			http.call({ protocol: "http", tool: "t", template: template({ url: "http://${HOST}/x" }), args: {} }),
			isCode("insecure_url")
		);
		assert.equal(seen.length, 0);
	});

	test("plain http to loopback is allowed", async () => {
		const { http, seen } = client(json({}));
		await http.call(call({ url: "http://127.0.0.1:8080/x" }));
		assert.equal(seen[0]?.url, "http://127.0.0.1:8080/x");
	});
});

describe("redirects", () => {
	const to = (location: string, status = 302): Response => new Response(null, { status, headers: { location } });

	test("every request is sent with redirect: manual", async () => {
		const { http, seen } = client(json({}));
		await http.call(call());
		assert.equal(seen[0]?.redirect, "manual");
	});

	test("a same-origin redirect is followed and keeps the credentials", async () => {
		const { http, seen } = client(to("/v2/items"), json({ moved: true }));
		const result = await http.call(call({ auth: { type: "api_key", key: "$KEY", name: "X-Api-Key", location: "header" } }));
		assert.deepEqual(result, { moved: true });
		assert.equal(seen[1]?.url, "https://api.example.com/v2/items");
		assert.equal(seen[1]?.headers["x-api-key"], "k1");
	});

	test("an api key in the query is put back on the redirected URL", async () => {
		const { http, seen } = client(to("https://api.example.com/v2/items?page=2"), json({}));
		await http.call(call({ auth: { type: "api_key", key: "$KEY", name: "key", location: "query" } }));
		assert.equal(seen[1]?.url, "https://api.example.com/v2/items?page=2&key=k1");
	});

	test("a redirect to another origin is refused and nothing is sent there", async () => {
		const { http, seen } = client(to("https://evil.example.org/steal"));
		await assert.rejects(
			http.call(call({ auth: { type: "api_key", key: "$KEY", name: "X-Api-Key", location: "header" } })),
			(error: unknown) => error instanceof RoveError && error.code === "cross_origin_redirect" && error.target === "https://evil.example.org/steal"
		);
		assert.equal(seen.length, 1);
	});

	test("a redirect to another port or scheme is another origin", async () => {
		for (const location of ["https://api.example.com:8443/x", "http://api.example.com/x"]) {
			const { http, seen } = client(to(location));
			await assert.rejects(http.call(call()), isCode("cross_origin_redirect"), location);
			assert.equal(seen.length, 1);
		}
	});

	for (const [status, method, expectedMethod, keepsBody] of [
		[301, "POST", "GET", false],
		[302, "POST", "GET", false],
		[303, "POST", "GET", false],
		[303, "PUT", "GET", false],
		[307, "POST", "POST", true],
		[308, "PUT", "PUT", true],
		[301, "PUT", "PUT", true],
		[302, "DELETE", "DELETE", false],
	] as const) {
		test(`a ${status} after ${method} is followed with ${expectedMethod}${keepsBody ? " and the same body" : ""}`, async () => {
			const { http, seen } = client(to("/next", status), json({}));
			await http.call(
				call({ method, bodyField: method === "DELETE" ? undefined : "body" }, method === "DELETE" ? {} : { body: { a: 1 } })
			);
			assert.equal(seen[1]?.method, expectedMethod);
			assert.equal(seen[1]?.body, keepsBody ? "{\"a\":1}" : "");
			assert.equal(seen[1]?.headers["content-type"], keepsBody ? "application/json" : undefined);
		});
	}

	test("a 303 after GET stays a GET with every header it had", async () => {
		const { http, seen } = client(to("/next", 303), json({}));
		await http.call(call({ headers: { "content-type": "application/json", "content-language": "en" } }));
		assert.equal(seen[1]?.method, "GET");
		assert.equal(seen[1]?.headers["content-type"], "application/json");
		assert.equal(seen[1]?.headers["content-language"], "en");
	});

	test("twenty redirects are followed and the twenty-first is refused", async () => {
		const hops = Array.from({ length: 20 }, (_, index) => to(`/hop${index}`));
		const { http: ok, seen: okSeen } = client(...hops.slice(0, 19), json({ done: true }));
		assert.deepEqual(await ok.call(call()), { done: true });
		assert.equal(okSeen.length, 20);

		const { http: tooMany, seen } = client(...hops, json({}));
		await assert.rejects(tooMany.call(call()), isCode("redirect_not_followed"));
		assert.equal(seen.length, 20);
	});

	test("a 3xx without a Location is returned as a status error, not followed", async () => {
		const { http } = client(new Response("", { status: 302 }));
		await assert.rejects(http.call(call()), (error: unknown) => error instanceof RoveError && error.code === "status" && error.status === 302);
	});

	test("a 304 is not a redirect", async () => {
		const { http, seen } = client(new Response(null, { status: 304, headers: { location: "/x" } }));
		await assert.rejects(http.call(call()), isCode("status"));
		assert.equal(seen.length, 1);
	});

	test("an opaque redirect, which a browser returns, is refused because it cannot be checked", async () => {
		const opaque = Object.defineProperty(new Response(null, { status: 200 }), "type", { value: "opaqueredirect" });
		const { http } = client(opaque);
		await assert.rejects(http.call(call()), isCode("redirect_not_followed"));
	});
});

describe("responses", () => {
	test("JSON is parsed", async () => {
		const { http } = client(json({ items: [1] }));
		assert.deepEqual(await http.call(call()), { items: [1] });
	});

	test("+json media types are parsed", async () => {
		const { http } = client(new Response("{\"a\":1}", { headers: { "content-type": "application/problem+json; charset=utf-8" } }));
		assert.deepEqual(await http.call(call()), { a: 1 });
	});

	test("anything else is returned as text", async () => {
		const { http } = client(new Response("plain \u2603", { headers: { "content-type": "text/plain" } }));
		assert.equal(await http.call(call()), "plain \u2603");
	});

	test("a response with no content type is text", async () => {
		const response = new Response("x");
		response.headers.delete("content-type");
		const { http } = client(response);
		assert.equal(await http.call(call()), "x");
	});

	test("204 and 205 resolve to undefined", async () => {
		const { http } = client(new Response(null, { status: 204 }), new Response(null, { status: 205 }));
		assert.equal(await http.call(call()), undefined);
		assert.equal(await http.call(call()), undefined);
	});

	test("an empty JSON body resolves to undefined and an empty text body to an empty string", async () => {
		const { http } = client(
			new Response("", { headers: { "content-type": "application/json" } }),
			new Response("", { headers: { "content-type": "text/plain" } })
		);
		assert.equal(await http.call(call()), undefined);
		assert.equal(await http.call(call()), "");
	});

	test("malformed JSON is decode_failed with the raw body", async () => {
		const { http } = client(new Response("<html>oops", { headers: { "content-type": "application/json" } }));
		await assert.rejects(http.call(call()), (error: unknown) =>
			error instanceof RoveError && error.code === "decode_failed" && error.body === "<html>oops" && error.cause instanceof SyntaxError
		);
	});

	test("a non-2xx status is a status error carrying the status, headers and body", async () => {
		const { http } = client(json({ error: "nope" }, { status: 422, statusText: "Unprocessable", headers: { "retry-after": "5" } }));
		await assert.rejects(http.call(call()), (error: unknown) => {
			assert.ok(error instanceof RoveError);
			assert.equal(error.code, "status");
			assert.equal(error.status, 422);
			assert.equal(error.tool, "list_items");
			assert.equal(error.target, "https://api.example.com/v1/items");
			assert.equal(error.headers?.get("retry-after"), "5");
			assert.equal(error.body, "{\"error\":\"nope\"}");
			assert.match(error.message, /^rovebeetle: GET https:\/\/api\.example\.com\/v1\/items failed with HTTP 422 Unprocessable$/u);
			return true;
		});
	});

	test("the edges of 2xx: 200 and 299 succeed, 199 and 300 do not", async () => {
		const { http } = client(json(1, { status: 200 }), json(2, { status: 299 }));
		assert.equal(await http.call(call()), 1);
		assert.equal(await http.call(call()), 2);
		const informational = Object.defineProperty(new Response(null, { status: 200 }), "status", { value: 199 });
		Object.defineProperty(informational, "ok", { value: false });
		const { http: low } = client(informational);
		await assert.rejects(low.call(call()), isCode("status"));
		const { http: high } = client(new Response(null, { status: 300 }));
		await assert.rejects(high.call(call()), isCode("status"));
	});
});

describe("failures and cancellation", () => {
	test("a transport that throws is transport_failed with the cause", async () => {
		const cause = new TypeError("fetch failed");
		const { http } = client(cause);
		await assert.rejects(http.call(call()), (error: unknown) =>
			error instanceof RoveError && error.code === "transport_failed" && error.cause === cause && error.target === "https://api.example.com/v1/items"
		);
	});

	test("an aborted call rejects with the caller's reason, unwrapped", async () => {
		const reason = new Error("caller timeout");
		const controller = new AbortController();
		const { http } = client((request) => {
			controller.abort(reason);
			return Promise.reject(request.signal.reason);
		});
		await assert.rejects(http.call(call(), { signal: controller.signal }), (error) => error === reason);
	});

	test("the caller's signal reaches the transport", async () => {
		const controller = new AbortController();
		const { http, seen } = client(json({}));
		await http.call(call(), { signal: controller.signal });
		controller.abort();
		assert.equal(seen[0]?.signal.aborted, true);
	});

	test("an abort while the body is read rejects with the caller's reason", async () => {
		const reason = new Error("late");
		const controller = new AbortController();
		const body = new ReadableStream({
			pull() {
				controller.abort(reason);
				throw reason;
			},
		});
		const { http } = client(new Response(body, { headers: { "content-type": "text/plain" } }));
		await assert.rejects(http.call(call(), { signal: controller.signal }), (error) => error === reason);
	});
});

describe("the response size limit", () => {
	const limited = (maxResponseBytes: number, ...answers: Parameters<typeof scripted>): HttpClient<string> =>
		new HttpClient<string>({ variables: {}, transport: scripted(...answers).transport, maxResponseBytes });

	for (const [label, value] of [
		["missing", undefined],
		["zero", 0],
		["negative", -1],
		["fractional", 1.5],
		["NaN", NaN],
		["Infinity", Infinity],
		["a string", "1024"],
	] as const) {
		test(`maxResponseBytes ${label} is refused at construction`, () => {
			assert.throws(
				() => new HttpClient({ variables: {}, maxResponseBytes: value as number }),
				(error: unknown) => error instanceof RoveError && error.code === "unsupported_value" && error.message.includes("maxResponseBytes")
			);
		});
	}

	test("a body of exactly the limit is read", async () => {
		const http = limited(5, new Response("12345", { headers: { "content-type": "text/plain" } }));
		assert.equal(await http.call(call()), "12345");
	});

	test("a body one byte over the limit fails with protocol_error", async () => {
		const http = limited(5, new Response("123456", { headers: { "content-type": "text/plain" } }));
		await assert.rejects(http.call(call()), isCode("protocol_error"));
	});

	test("the limit counts bytes, not characters", async () => {
		const http = limited(5, new Response("\u00e9\u00e9\u00e9", { headers: { "content-type": "text/plain" } }));
		await assert.rejects(http.call(call()), isCode("protocol_error"));
	});

	test("a body split over many chunks is counted across them", async () => {
		const chunks = ["ab", "cd", "ef"].map((text) => new TextEncoder().encode(text));
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				const next = chunks.shift();
				if (next === undefined) {
					controller.close();
				} else {
					controller.enqueue(next);
				}
			},
		});
		const http = limited(5, new Response(body, { headers: { "content-type": "text/plain" } }));
		await assert.rejects(http.call(call()), isCode("protocol_error"));
	});

	test("a content-length over the limit fails on the header, whatever arrives", async () => {
		const http = limited(5, new Response("12", { headers: { "content-length": "6", "content-type": "text/plain" } }));
		await assert.rejects(http.call(call()), isCode("protocol_error"));
	});

	test("an error body over the limit still reports the status, without the body", async () => {
		const http = limited(3, new Response("too long", { status: 500 }));
		await assert.rejects(http.call(call()), (error: unknown) =>
			error instanceof RoveError && error.code === "status" && error.status === 500 && error.body === undefined
		);
	});

	test("a token response over the limit fails the token request", async () => {
		const http = limited(10, json({ access_token: "a".repeat(64), token_type: "bearer", expires_in: 60 }));
		await assert.rejects(
			http.call(call({ auth: { type: "oauth2", tokenUrl: "https://a.example.com/t", clientId: "i", clientSecret: "s" } })),
			isCode("token_request_failed")
		);
	});
});
