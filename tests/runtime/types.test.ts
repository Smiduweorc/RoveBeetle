import assert from "node:assert/strict";
import { test } from "node:test";

import type { ResultOf, ToolCall } from "../../src/call.js";
import { HttpClient } from "../../src/protocols/http.js";

// These assertions run in the type checker (`npm run typecheck`). Each
// `@ts-expect-error` is a claim that the line must not compile; if it ever
// compiles, the checker reports the directive as unused and the build fails.

declare const needsKey: ToolCall<"http", { forecast: number }, "WEATHER_KEY">;
declare const needsNothing: ToolCall<"http", string>;
declare const sseCall: ToolCall<"sse", string>;

const withKey = new HttpClient({ variables: { WEATHER_KEY: "k" }, maxResponseBytes: 1024 });
const withNothing = new HttpClient({ variables: {}, maxResponseBytes: 1024 });

test("a client given every variable accepts the call, and the result type comes through", () => {
	const typed = (): Promise<{ forecast: number }> => withKey.call(needsKey);
	const plain = (): Promise<string> => withKey.call(needsNothing);
	assert.equal(typeof typed, "function");
	assert.equal(typeof plain, "function");
});

test("a call needing a variable the client was not given does not compile", () => {
	// @ts-expect-error The client has no WEATHER_KEY, so this call must be refused.
	const missing = (): unknown => withNothing.call(needsKey);
	assert.equal(typeof missing, "function");
});

test("a client misspelling a variable does not accept the call", () => {
	const misspelled = new HttpClient({ variables: { WEATHER_KYE: "k" }, maxResponseBytes: 1024 });
	// @ts-expect-error WEATHER_KYE is not WEATHER_KEY.
	const wrong = (): unknown => misspelled.call(needsKey);
	assert.equal(typeof wrong, "function");
});

test("an http client does not accept a call for another protocol", () => {
	// @ts-expect-error An sse call goes to the sse client.
	const other = (): unknown => withNothing.call(sseCall);
	assert.equal(typeof other, "function");
});

test("ResultOf reads a call's result type", () => {
	const result: ResultOf<typeof needsKey> = { forecast: 1 };
	// @ts-expect-error The result is an object, not a string.
	const wrong: ResultOf<typeof needsKey> = "x";
	assert.deepEqual([result, wrong], [{ forecast: 1 }, "x"]);
});
