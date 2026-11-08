import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { applyAuth, base64, TokenSource } from "../../src/auth.js";
import type { OAuth2Auth } from "../../src/call.js";
import { RoveError } from "../../src/errors.js";
import { isLoopback, secureUrl, HTTP_SCHEMES, WS_SCHEMES } from "../../src/secure.js";
import { clock, gate, json, scripted } from "./transport.js";

const oauth: OAuth2Auth = {
	type: "oauth2",
	tokenUrl: "https://auth.example.com/token",
	clientId: "client",
	clientSecret: "secret",
};

function bearer(token: string, expiresIn?: unknown): Response {
	return json({ access_token: token, token_type: "Bearer", ...(expiresIn === undefined ? {} : { expires_in: expiresIn }) });
}

function isCode(code: string): (error: unknown) => boolean {
	return (error) => error instanceof RoveError && error.code === code;
}

describe("secure URLs", () => {
	test("https is accepted for any host", () => {
		assert.equal(secureUrl("https://api.example.com/x", HTTP_SCHEMES, "t").host, "api.example.com");
	});

	for (const host of ["localhost", "127.0.0.1", "127.255.0.9", "[::1]"]) {
		test(`plain http is accepted for the loopback host ${host}`, () => {
			assert.equal(secureUrl(`http://${host}:8080/`, HTTP_SCHEMES, "t").protocol, "http:");
		});
	}

	for (const host of ["example.com", "128.0.0.1", "10.0.0.1", "localhost.example.com", "[::2]", "0.0.0.0"]) {
		test(`plain http is refused for ${host}`, () => {
			assert.throws(() => secureUrl(`http://${host}/`, HTTP_SCHEMES, "t"), isCode("insecure_url"));
		});
	}

	test("a scheme other than the two named is refused even on loopback", () => {
		assert.throws(() => secureUrl("ftp://localhost/", HTTP_SCHEMES, "t"), isCode("insecure_url"));
		assert.throws(() => secureUrl("ws://localhost/", HTTP_SCHEMES, "t"), isCode("insecure_url"));
	});

	test("websocket URLs need wss, or ws on loopback", () => {
		assert.equal(secureUrl("wss://a.example.com", WS_SCHEMES, "t").protocol, "wss:");
		assert.equal(secureUrl("ws://127.0.0.1:9", WS_SCHEMES, "t").protocol, "ws:");
		assert.throws(() => secureUrl("ws://a.example.com", WS_SCHEMES, "t"), isCode("insecure_url"));
		assert.throws(() => secureUrl("https://a.example.com", WS_SCHEMES, "t"), isCode("insecure_url"));
	});

	test("text that is not an absolute URL is refused with the text as target", () => {
		assert.throws(
			() => secureUrl("/relative", HTTP_SCHEMES, "t"),
			(error: unknown) => error instanceof RoveError && error.code === "insecure_url" && error.target === "/relative"
		);
	});

	test("loopback means localhost, 127.0.0.0/8 and ::1 only", () => {
		assert.deepEqual(
			["localhost", "127.0.0.1", "[::1]", "127.1", "localhost.", "LOCALHOST"].map(isLoopback),
			[true, true, true, false, false, false]
		);
	});
});

describe("static auth", () => {
	const tokens = new TokenSource({ transport: scripted().transport, now: Date.now, maxResponseBytes: 4096 });

	function apply(_auth: Parameters<typeof applyAuth>[0], headers: Record<string, string> = {}): { headers: Headers; url: URL } {
		return { headers: new Headers(headers), url: new URL("https://a.example.com/x?k=old") };
	}

	test("an api key in a header replaces whatever the template set there", async () => {
		const request = apply({ type: "api_key", key: "k1", name: "X-Api-Key", location: "header" }, { "x-api-key": "old" });
		await applyAuth({ type: "api_key", key: "k1", name: "X-Api-Key", location: "header" }, request, tokens, "t", undefined);
		assert.equal(request.headers.get("x-api-key"), "k1");
	});

	test("an api key in the query replaces an argument of the same name", async () => {
		const request = apply({ type: "api_key", key: "k 1&x", name: "k", location: "query" });
		await applyAuth({ type: "api_key", key: "k 1&x", name: "k", location: "query" }, request, tokens, "t", undefined);
		assert.deepEqual(request.url.searchParams.getAll("k"), ["k 1&x"]);
		assert.equal(request.url.search, "?k=k+1%26x");
	});

	test("an api key in a cookie is added to the cookies already there", async () => {
		const auth = { type: "api_key", key: "abc", name: "session", location: "cookie" } as const;
		const fresh = apply(auth);
		await applyAuth(auth, fresh, tokens, "t", undefined);
		assert.equal(fresh.headers.get("cookie"), "session=abc");

		const existing = apply(auth, { cookie: "theme=dark" });
		await applyAuth(auth, existing, tokens, "t", undefined);
		assert.equal(existing.headers.get("cookie"), "theme=dark; session=abc");
	});

	for (const key of ["a;b", "a b", "a,b", "a\"b", "a\\b", "\u00e9"]) {
		test(`a cookie api key containing ${JSON.stringify(key)} is refused instead of splitting the header`, async () => {
			const auth = { type: "api_key", key, name: "s", location: "cookie" } as const;
			await assert.rejects(applyAuth(auth, apply(auth), tokens, "t", undefined), isCode("unsupported_value"));
		});
	}

	test("basic auth is the base64 of user:password in UTF-8", async () => {
		const request = apply({ type: "basic", username: "Aladdin", password: "open sesame" });
		await applyAuth({ type: "basic", username: "Aladdin", password: "open sesame" }, request, tokens, "t", undefined);
		// RFC 7617 section 2's own example.
		assert.equal(request.headers.get("authorization"), "Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ==");
	});

	test("basic auth encodes non-ASCII credentials as UTF-8", async () => {
		// RFC 7617 section 2.1's example, "test" / "123\u00a3".
		assert.equal(base64("test:123\u00a3"), "dGVzdDoxMjPCow==");
	});
});

describe("OAuth2 token requests", () => {
	test("the request is a client credentials grant with HTTP Basic client auth and nothing in the body", async () => {
		const { transport, seen } = scripted(bearer("t1", 3600));
		const tokens = new TokenSource({ transport, now: Date.now, maxResponseBytes: 4096 });

		assert.equal(await tokens.token({ ...oauth, scope: "read write" }, "t", undefined), "t1");
		assert.equal(seen.length, 1);
		const [request] = seen;
		assert.equal(request?.method, "POST");
		assert.equal(request?.url, "https://auth.example.com/token");
		assert.equal(request?.headers["content-type"], "application/x-www-form-urlencoded");
		assert.equal(request?.headers["authorization"], `Basic ${base64("client:secret")}`);
		assert.equal(request?.body, "grant_type=client_credentials&scope=read+write");
		assert.equal(request?.redirect, "manual");
	});

	test("no scope means no scope parameter", async () => {
		const { transport, seen } = scripted(bearer("t1", 60));
		await new TokenSource({ transport, now: Date.now, maxResponseBytes: 4096 }).token(oauth, "t", undefined);
		assert.equal(seen[0]?.body, "grant_type=client_credentials");
	});

	test("an empty scope sends no scope parameter rather than scope=", async () => {
		const { transport, seen } = scripted(bearer("t1", 60));
		await new TokenSource({ transport, now: Date.now, maxResponseBytes: 4096 }).token({ ...oauth, scope: "" }, "t", undefined);
		assert.equal(seen[0]?.body, "grant_type=client_credentials");
	});

	test("the client id and secret are form-encoded before they are joined, so a colon survives", async () => {
		const { transport, seen } = scripted(bearer("t1", 60));
		await new TokenSource({ transport, now: Date.now, maxResponseBytes: 4096 }).token({ ...oauth, clientId: "a:b", clientSecret: "c d+\u00e9" }, "t", undefined);
		assert.equal(seen[0]?.headers["authorization"], `Basic ${base64("a%3Ab:c+d%2B%C3%A9")}`);
	});

	test("a token URL that is plain http on a public host is refused before anything is sent", async () => {
		const { transport, seen } = scripted();
		await assert.rejects(
			new TokenSource({ transport, now: Date.now, maxResponseBytes: 4096 }).token({ ...oauth, tokenUrl: "http://auth.example.com/token" }, "t", undefined),
			isCode("insecure_url")
		);
		assert.equal(seen.length, 0);
	});

	test("a token URL on loopback may be plain http", async () => {
		const { transport } = scripted(bearer("t1", 60));
		assert.equal(await new TokenSource({ transport, now: Date.now, maxResponseBytes: 4096 }).token({ ...oauth, tokenUrl: "http://127.0.0.1:9/t" }, "t", undefined), "t1");
	});

	for (const [label, response] of [
		["a 401", json({ error: "invalid_client" }, { status: 401 })],
		["a 500", new Response("boom", { status: 500 })],
		["a redirect", new Response(null, { status: 302, headers: { location: "https://evil.example.com/" } })],
		["a body that is not JSON", new Response("<html>", { status: 200 })],
		["JSON that is not an object", json([1])],
		["no access_token", json({ token_type: "bearer" })],
		["an empty access_token", json({ access_token: "", token_type: "bearer" })],
		["a token type other than bearer", json({ access_token: "x", token_type: "mac" })],
		["no token type", json({ access_token: "x" })],
	] as const) {
		test(`${label} fails as token_request_failed with the status and body`, async () => {
			const { transport, seen } = scripted(response);
			await assert.rejects(new TokenSource({ transport, now: Date.now, maxResponseBytes: 4096 }).token(oauth, "tool_x", undefined), (error: unknown) => {
				assert.ok(error instanceof RoveError);
				assert.equal(error.code, "token_request_failed");
				assert.equal(error.tool, "tool_x");
				assert.equal(error.status, response.status);
				assert.equal(error.target, "https://auth.example.com/token");
				return true;
			});
			assert.equal(seen.length, 1, "no second attempt with the secret somewhere else");
		});
	}

	test("a 401 keeps the token endpoint's body for the caller to read", async () => {
		const { transport } = scripted(json({ error: "invalid_client" }, { status: 401 }));
		await assert.rejects(new TokenSource({ transport, now: Date.now, maxResponseBytes: 4096 }).token(oauth, "t", undefined), (error: unknown) =>
			error instanceof RoveError && error.body === "{\"error\":\"invalid_client\"}"
		);
	});

	test("a transport failure is token_request_failed with the cause attached", async () => {
		const cause = new TypeError("fetch failed");
		const { transport } = scripted(cause);
		await assert.rejects(new TokenSource({ transport, now: Date.now, maxResponseBytes: 4096 }).token(oauth, "t", undefined), (error: unknown) =>
			error instanceof RoveError && error.code === "token_request_failed" && error.cause === cause
		);
	});

	test("token_type is compared without case", async () => {
		const { transport } = scripted(json({ access_token: "x", token_type: "BEARER", expires_in: 5 }));
		assert.equal(await new TokenSource({ transport, now: Date.now, maxResponseBytes: 4096 }).token(oauth, "t", undefined), "x");
	});
});

describe("OAuth2 token cache", () => {
	test("a cached token is reused until expires_in seconds after the request started", async () => {
		const time = clock();
		const { transport, seen } = scripted(bearer("t1", 60), bearer("t2", 60));
		const tokens = new TokenSource({ transport, now: time.now, maxResponseBytes: 4096 });

		assert.equal(await tokens.token(oauth, "t", undefined), "t1");
		time.advance(59_999);
		assert.equal(await tokens.token(oauth, "t", undefined), "t1");
		assert.equal(seen.length, 1);

		time.advance(1);
		assert.equal(await tokens.token(oauth, "t", undefined), "t2", "expired at exactly 60 s");
		assert.equal(seen.length, 2);
	});

	test("expiry counts from when the token request started, not when it finished", async () => {
		const time = clock();
		const { transport } = scripted(
			async () => {
				time.advance(10_000);
				return bearer("t1", 60);
			},
			bearer("t2", 60)
		);
		const tokens = new TokenSource({ transport, now: time.now, maxResponseBytes: 4096 });

		await tokens.token(oauth, "t", undefined);
		time.advance(49_999);
		assert.equal(await tokens.token(oauth, "t", undefined), "t1");
		time.advance(1);
		assert.equal(await tokens.token(oauth, "t", undefined), "t2");
	});

	for (const [label, expiresIn] of [
		["absent", undefined],
		["zero", 0],
		["negative", -5],
		["not a number", "soon"],
		["a decimal string", "1.5"],
		["infinite", "Infinity"],
	] as const) {
		test(`a token whose expires_in is ${label} is not reused`, async () => {
			const { transport, seen } = scripted(bearer("t1", expiresIn), bearer("t2", expiresIn));
			const tokens = new TokenSource({ transport, now: Date.now, maxResponseBytes: 4096 });
			assert.equal(await tokens.token(oauth, "t", undefined), "t1");
			assert.equal(await tokens.token(oauth, "t", undefined), "t2");
			assert.equal(seen.length, 2);
		});
	}

	test("a clock that goes backwards does not bring back a token with no lifetime", async () => {
		const time = clock();
		const { transport, seen } = scripted(bearer("t1", 0), bearer("t2", 0));
		const tokens = new TokenSource({ transport, now: time.now, maxResponseBytes: 4096 });
		assert.equal(await tokens.token(oauth, "t", undefined), "t1");
		time.advance(-5_000);
		assert.equal(await tokens.token(oauth, "t", undefined), "t2");
		assert.equal(seen.length, 2);
	});

	test("a clock that goes backwards keeps a live token live", async () => {
		const time = clock();
		const { transport, seen } = scripted(bearer("t1", 60));
		const tokens = new TokenSource({ transport, now: time.now, maxResponseBytes: 4096 });
		await tokens.token(oauth, "t", undefined);
		time.advance(-5_000);
		assert.equal(await tokens.token(oauth, "t", undefined), "t1");
		assert.equal(seen.length, 1);
	});

	test("expires_in sent as a string of digits is accepted", async () => {
		const time = clock();
		const { transport, seen } = scripted(bearer("t1", "60"));
		const tokens = new TokenSource({ transport, now: time.now, maxResponseBytes: 4096 });
		await tokens.token(oauth, "t", undefined);
		time.advance(59_000);
		assert.equal(await tokens.token(oauth, "t", undefined), "t1");
		assert.equal(seen.length, 1);
	});

	test("a failed request caches nothing, and the next call starts a new request", async () => {
		const { transport, seen } = scripted(new Response("", { status: 503 }), bearer("t1", 60));
		const tokens = new TokenSource({ transport, now: Date.now, maxResponseBytes: 4096 });
		await assert.rejects(tokens.token(oauth, "t", undefined), isCode("token_request_failed"));
		assert.equal(await tokens.token(oauth, "t", undefined), "t1");
		assert.equal(seen.length, 2);
	});

	test("concurrent calls share one pending request", async () => {
		const answer = gate<Response>();
		const { transport, seen } = scripted(() => answer.promise);
		const tokens = new TokenSource({ transport, now: Date.now, maxResponseBytes: 4096 });

		const first = tokens.token(oauth, "a", undefined);
		const second = tokens.token(oauth, "b", undefined);
		await Promise.resolve();
		answer.open(bearer("t1", 60));

		assert.deepEqual(await Promise.all([first, second]), ["t1", "t1"]);
		assert.equal(seen.length, 1);
	});

	test("concurrent calls share one failure, and nothing is cached", async () => {
		const answer = gate<Response>();
		const { transport, seen } = scripted(() => answer.promise, bearer("t1", 60));
		const tokens = new TokenSource({ transport, now: Date.now, maxResponseBytes: 4096 });

		const first = tokens.token(oauth, "a", undefined);
		const second = tokens.token(oauth, "b", undefined);
		answer.open(new Response("", { status: 500 }));

		await assert.rejects(first, isCode("token_request_failed"));
		await assert.rejects(second, isCode("token_request_failed"));
		assert.equal(await tokens.token(oauth, "c", undefined), "t1");
		assert.equal(seen.length, 2);
	});

	test("a token without expires_in still serves every call that was waiting for it", async () => {
		const answer = gate<Response>();
		const { transport, seen } = scripted(() => answer.promise);
		const tokens = new TokenSource({ transport, now: Date.now, maxResponseBytes: 4096 });
		const both = Promise.all([tokens.token(oauth, "a", undefined), tokens.token(oauth, "b", undefined)]);
		answer.open(bearer("once"));
		assert.deepEqual(await both, ["once", "once"]);
		assert.equal(seen.length, 1);
	});

	test("auth blocks that differ in any field get separate tokens", async () => {
		const variants: OAuth2Auth[] = [
			oauth,
			{ ...oauth, clientSecret: "other" },
			{ ...oauth, tokenUrl: "https://other.example.com/token" },
			{ ...oauth, scope: "read" },
			{ ...oauth, clientId: "other" },
		];
		const { transport, seen } = scripted(...variants.map((_, index) => bearer(`t${index}`, 60)));
		const tokens = new TokenSource({ transport, now: Date.now, maxResponseBytes: 4096 });

		const got = [];
		for (const auth of variants) {
			got.push(await tokens.token(auth, "t", undefined));
		}
		assert.deepEqual(got, ["t0", "t1", "t2", "t3", "t4"]);
		assert.equal(seen.length, 5);
	});

	test("an absent scope and an empty scope are the same token", async () => {
		const { transport, seen } = scripted(bearer("t1", 60));
		const tokens = new TokenSource({ transport, now: Date.now, maxResponseBytes: 4096 });
		await tokens.token(oauth, "t", undefined);
		assert.equal(await tokens.token({ ...oauth, scope: "" }, "t", undefined), "t1");
		assert.equal(seen.length, 1);
	});

	test("two token sources never share a token", async () => {
		const { transport, seen } = scripted(bearer("t1", 60), bearer("t2", 60));
		assert.equal(await new TokenSource({ transport, now: Date.now, maxResponseBytes: 4096 }).token(oauth, "t", undefined), "t1");
		assert.equal(await new TokenSource({ transport, now: Date.now, maxResponseBytes: 4096 }).token(oauth, "t", undefined), "t2");
		assert.equal(seen.length, 2);
	});
});

describe("OAuth2 cancellation", () => {
	test("an already-aborted signal rejects with its reason and sends nothing", async () => {
		const { transport, seen } = scripted();
		const reason = new Error("caller gave up");
		await assert.rejects(new TokenSource({ transport, now: Date.now, maxResponseBytes: 4096 }).token(oauth, "t", AbortSignal.abort(reason)), (error) => error === reason);
		assert.equal(seen.length, 0);
	});

	test("one caller aborting leaves the others waiting, and the request keeps going", async () => {
		const answer = gate<Response>();
		const { transport, seen } = scripted(() => answer.promise);
		const tokens = new TokenSource({ transport, now: Date.now, maxResponseBytes: 4096 });
		const controller = new AbortController();
		const reason = new Error("a gave up");

		const first = tokens.token(oauth, "a", controller.signal);
		const second = tokens.token(oauth, "b", undefined);
		await Promise.resolve();
		controller.abort(reason);

		await assert.rejects(first, (error) => error === reason);
		assert.equal(seen[0]?.signal.aborted, false);
		answer.open(bearer("t1", 60));
		assert.equal(await second, "t1");
	});

	test("when every waiting caller has aborted, the token request is aborted too", async () => {
		const { transport, seen } = scripted(
			(request) =>
				new Promise<Response>((_resolve, reject) => {
					request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
				})
		);
		const tokens = new TokenSource({ transport, now: Date.now, maxResponseBytes: 4096 });
		const a = new AbortController();
		const b = new AbortController();

		const first = tokens.token(oauth, "a", a.signal);
		const second = tokens.token(oauth, "b", b.signal);
		await new Promise((resolve) => setImmediate(resolve));
		a.abort(new Error("a"));
		await assert.rejects(first);
		assert.equal(seen[0]?.signal.aborted, false, "b is still waiting");

		b.abort(new Error("b"));
		await assert.rejects(second);
		assert.equal(seen[0]?.signal.aborted, true);
	});

	test("after an abandoned request, the next call starts a fresh one", async () => {
		const { transport, seen } = scripted(
			(request) =>
				new Promise<Response>((_resolve, reject) => {
					request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
				}),
			bearer("t2", 60)
		);
		const tokens = new TokenSource({ transport, now: Date.now, maxResponseBytes: 4096 });
		const controller = new AbortController();
		const first = tokens.token(oauth, "a", controller.signal);
		await new Promise((resolve) => setImmediate(resolve));
		controller.abort(new Error("gone"));
		await assert.rejects(first);
		await new Promise((resolve) => setImmediate(resolve));

		assert.equal(await tokens.token(oauth, "b", undefined), "t2");
		assert.equal(seen.length, 2);
	});
});
