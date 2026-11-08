// Consumes the build output the way an installed package is consumed, so the
// entry points, the emitted specifiers and the published surface all get
// exercised. Runs under Node (`npm run test:dist`, which builds first) and
// under Bun (`npm run test:dist:bun`).

import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { test } from "node:test";

import * as pkg from "../../dist/index.js";
import * as http from "../../dist/http.js";

// Update these lists by hand: a name added or removed here is a change to the
// package's public API, and semver applies to it. Which subpaths exist is the
// generator's part, below; what each one exports is fixed here.
const publicSurface = ["RoveError"];
const subpathSurfaces = {
	"./http": ["HttpClient"],
	"./sse": ["SseClient"],
	"./streamable-http": ["StreamableHttpClient"],
	"./graphql": ["GraphqlClient"],
	"./websocket": ["WebSocketClient"],
	"./tcp": ["TcpClient"],
	"./udp": ["UdpClient"],
	"./mcp": ["McpClient", "PROTOCOL_VERSIONS"],
	"./cli": ["CliClient", "DEFAULT_INHERITED"],
	"./text": ["TextClient"],
	"./file": ["FileClient"],
};

// Subpaths that may import `node:` modules. Every other entry point has to
// load in a browser, so nothing reachable from it may import one. `mcp`
// loads `node:child_process` only when a stdio server is used, through a
// dynamic import this check counts.
const nodeOnly = new Set(["./cli", "./tcp", "./udp", "./file", "./mcp"]);

// The generator rewrites the block below and prints what it added or removed,
// so a generated change to the public API is still something a person reads in
// review rather than something that lands unannounced.
// rove-beetle:start generated public surface
const generatedSurface = [
	"getForecast",
	"watchAlerts",
];
const generatedSubpaths = [
	"./http",
	"./sse",
];
// rove-beetle:end

const SPECIFIERS =
	/(?:^|\n)\s*(?:import|export)\s[^;]*?\sfrom\s+["']([^"']+)["']|(?:^|\n)\s*import\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/gu;

const manifest = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));

test("the built root exports exactly the intended surface", () => {
	assert.deepEqual(Object.keys(pkg).sort(), [...publicSurface, ...generatedSurface].sort());
});

test("every subpath in package.json exports exactly its intended surface", async () => {
	const subpaths = Object.keys(manifest.exports).filter((key) => key !== ".");
	assert.deepEqual(subpaths.sort(), [...generatedSubpaths].sort());

	for (const subpath of subpaths) {
		const module = await import(new URL(`../../${manifest.exports[subpath].default}`, import.meta.url).href);
		assert.deepEqual(Object.keys(module).sort(), [...subpathSurfaces[subpath]].sort(), subpath);
	}
});

test("type declarations are emitted where every export points", async () => {
	for (const entry of Object.values(manifest.exports)) {
		await access(new URL(`../../${entry.types}`, import.meta.url));
	}
});

test("nothing reachable from the root or a portable subpath imports a node: module", async () => {
	for (const [subpath, entry] of Object.entries(manifest.exports)) {
		if (nodeOnly.has(subpath)) {
			continue;
		}
		// Every specifier reachable through static imports and re-exports in
		// the emitted JavaScript: relative ones are followed and recorded as
		// `file:` URLs, anything else is recorded as written.
		const reached = new Set();
		const pending = [new URL(`../../${entry.default}`, import.meta.url).href];
		while (pending.length > 0) {
			const href = pending.pop();
			if (reached.has(href)) {
				continue;
			}
			reached.add(href);
			if (!href.startsWith("file:")) {
				continue;
			}
			const source = await readFile(new URL(href), "utf8");
			for (const match of source.matchAll(SPECIFIERS)) {
				const specifier = match[1] ?? match[2] ?? match[3];
				pending.push(specifier.startsWith(".") ? new URL(specifier, href).href : specifier);
			}
		}
		const builtins = [...reached].filter((specifier) => specifier.startsWith("node:") || !specifier.startsWith("file:"));
		assert.deepEqual(builtins, [], `${subpath} reaches ${builtins.join(", ")}`);
	}
});

test("a generated tool works through the built root and http subpath", async () => {
	const client = new http.HttpClient({
		variables: { WEATHER_API_KEY: "k" },
		maxResponseBytes: 4096,
		transport: async (request) =>
			new Response(JSON.stringify({ url: request.url, key: request.headers.get("x-api-key") }), {
				headers: { "content-type": "application/json" },
			}),
	});
	assert.deepEqual(await client.call(pkg.getForecast({ city: "Oslo" })), {
		url: "https://api.example.com/v1/forecast/Oslo",
		key: "k",
	});
});

test("errors from the built artifact are the exported RoveError", async () => {
	const client = new http.HttpClient({
		variables: {},
		maxResponseBytes: 4096,
		transport: async () => new Response("nope", { status: 500 }),
	});
	const error = await client
		.call({
			protocol: "http",
			tool: "probe",
			template: { url: "https://api.example.com/x", pathFields: [], method: "GET", contentType: "application/json", headers: {}, headerFields: [] },
			args: {},
		})
		.then(
			() => undefined,
			(caught) => caught
		);
	assert.ok(error instanceof pkg.RoveError);
	assert.equal(error.code, "status");
	assert.equal(error.status, 500);
});
