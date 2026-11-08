import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";

import { buildSchema, graphql, type GraphQLSchema } from "graphql";
import { useServer } from "graphql-ws/use/ws";
import { WebSocketServer } from "ws";

import type { GraphqlTemplate, ToolCall } from "../../src/call.js";
import { RoveError } from "../../src/errors.js";
import { GraphqlClient } from "../../src/protocols/graphql.js";
import { json, scripted } from "./transport.js";

const schema: GraphQLSchema = buildSchema(`
	type User { id: ID!, name: String! }
	type Query { user(id: ID!): User, broken: String }
	type Mutation { rename(id: ID!, name: String!): User! }
	type Subscription { ticks(count: Int!): Int!, failing: Int! }
`);

const root = {
	user: ({ id }: { id: string }) => (id === "missing" ? null : { id, name: `user ${id}` }),
	broken: () => {
		throw new Error("resolver exploded");
	},
	rename: ({ id, name }: { id: string; name: string }) => ({ id, name }),
	ticks: async function* ({ count }: { count: number }) {
		for (let tick = 1; tick <= count; tick += 1) {
			yield { ticks: tick };
		}
	},
	failing: async function* () {
		yield { failing: 1 };
		throw new Error("stream exploded");
	},
};

/** A transport that executes the request against `schema`, as a GraphQL server would. */
function executing(): ReturnType<typeof scripted> {
	const answer = async (request: Request): Promise<Response> => {
		const { query, variables, operationName } = (await request.json()) as {
			query: string;
			variables: Record<string, unknown>;
			operationName?: string;
		};
		const result = await graphql({ schema, source: query, rootValue: root, variableValues: variables, operationName });
		return json(result);
	};
	return scripted(answer, answer, answer, answer);
}

function template(overrides: Partial<GraphqlTemplate> = {}): GraphqlTemplate {
	return {
		url: "https://api.example.com/graphql",
		operationType: "query",
		query: "query User($id: ID!) { user(id: $id) { id name } }",
		headers: {},
		headerFields: [],
		...overrides,
	};
}

function call<T = unknown>(overrides: Partial<GraphqlTemplate> = {}, args: Record<string, unknown> = {}): ToolCall<"graphql", T> {
	return { protocol: "graphql", tool: "user", template: template(overrides), args };
}

function isCode(code: string): (error: unknown) => boolean {
	return (error) => error instanceof RoveError && error.code === code;
}

describe("graphql queries and mutations", () => {
	test("maxResponseBytes is required", () => {
		assert.throws(() => new GraphqlClient({ variables: {} } as never), isCode("unsupported_value"));
	});

	test("a query is one POST of query, variables and operation name, and resolves with data", async () => {
		const { transport, seen } = executing();
		const client = new GraphqlClient({ variables: {}, transport, maxResponseBytes: 4096 });
		const data = await client.call(call({ operationName: "User" }, { id: "7" }));
		assert.deepEqual(data, { user: { id: "7", name: "user 7" } });
		assert.equal(seen[0]?.method, "POST");
		assert.equal(seen[0]?.headers["content-type"], "application/json");
		assert.match(seen[0]?.headers["accept"] ?? "", /application\/graphql-response\+json/u);
		assert.deepEqual(JSON.parse(seen[0]?.body ?? ""), {
			query: "query User($id: ID!) { user(id: $id) { id name } }",
			variables: { id: "7" },
			operationName: "User",
		});
	});

	test("a mutation works the same way", async () => {
		const { transport } = executing();
		const client = new GraphqlClient({ variables: {}, transport, maxResponseBytes: 4096 });
		const data = await client.call(
			call({ operationType: "mutation", query: "mutation R($id: ID!, $name: String!) { rename(id: $id, name: $name) { name } }" }, { id: "1", name: "n" })
		);
		assert.deepEqual(data, { rename: { name: "n" } });
	});

	test("header fields become headers and are not sent as variables", async () => {
		const { transport, seen } = executing();
		const client = new GraphqlClient({ variables: {}, transport, maxResponseBytes: 4096 });
		await client.call(call({ headerFields: ["x-tenant"] }, { id: "1", "x-tenant": "acme" }));
		assert.equal(seen[0]?.headers["x-tenant"], "acme");
		assert.deepEqual(JSON.parse(seen[0]?.body ?? "").variables, { id: "1" });
	});

	test("an argument named body is a variable like any other", async () => {
		const { transport, seen } = scripted(json({ data: {} }));
		const client = new GraphqlClient({ variables: {}, transport, maxResponseBytes: 4096 });
		await client.call(call({}, { body: "x" }));
		assert.deepEqual(JSON.parse(seen[0]?.body ?? "").variables, { body: "x" });
	});

	test("the query is never substituted, so $id stays a GraphQL variable", async () => {
		const { transport, seen } = executing();
		const client = new GraphqlClient({ variables: { id: "should-not-appear" }, transport, maxResponseBytes: 4096 });
		await client.call(call({}, { id: "1" }));
		assert.match(JSON.parse(seen[0]?.body ?? "").query, /\$id: ID!/u);
	});

	test("errors in the result fail the call, with the result as body, even next to partial data", async () => {
		const { transport } = executing();
		const client = new GraphqlClient({ variables: {}, transport, maxResponseBytes: 4096 });
		await assert.rejects(client.call(call({ query: "{ broken user(id: \"1\") { id } }" })), (error: unknown) =>
			error instanceof RoveError &&
			error.code === "status" &&
			error.status === 200 &&
			error.message.includes("resolver exploded") &&
			JSON.parse(error.body ?? "").data.user.id === "1"
		);
	});

	test("a null result with no errors resolves with that data", async () => {
		const { transport } = executing();
		const client = new GraphqlClient({ variables: {}, transport, maxResponseBytes: 4096 });
		assert.deepEqual(await client.call(call({}, { id: "missing" })), { user: null });
	});

	test("an HTTP error status is a status error with the body", async () => {
		const { transport } = scripted(json({ errors: [{ message: "bad" }] }, { status: 400 }));
		const client = new GraphqlClient({ variables: {}, transport, maxResponseBytes: 4096 });
		await assert.rejects(client.call(call()), (error: unknown) => error instanceof RoveError && error.code === "status" && error.status === 400);
	});

	for (const [label, body] of [
		["not JSON", "<html>"],
		["not an object", "[1]"],
		["neither data nor errors", "{}"],
	] as const) {
		test(`a body that is ${label} is decode_failed`, async () => {
			const { transport } = scripted(new Response(body, { headers: { "content-type": "application/json" } }));
			const client = new GraphqlClient({ variables: {}, transport, maxResponseBytes: 4096 });
			await assert.rejects(client.call(call()), isCode("decode_failed"));
		});
	}

	test("a subscription is refused by call()", async () => {
		const client = new GraphqlClient({ variables: {}, transport: scripted().transport, maxResponseBytes: 4096 });
		await assert.rejects(client.call(call({ operationType: "subscription" })), isCode("unsupported_value"));
	});

	test("auth is applied to the POST", async () => {
		const { transport, seen } = scripted(json({ data: {} }));
		const client = new GraphqlClient({ variables: { KEY: "k" }, transport, maxResponseBytes: 4096 });
		await client.call(call({ auth: { type: "api_key", key: "Bearer $KEY", name: "Authorization", location: "header" } }));
		assert.equal(seen[0]?.headers["authorization"], "Bearer k");
	});
});

describe("graphql subscriptions", () => {
	let server: WebSocketServer;
	let port: number;
	const handshakes: Record<string, string | string[] | undefined>[] = [];
	let disposer: { dispose: () => void | Promise<void> };

	before(async () => {
		server = new WebSocketServer({ host: "127.0.0.1", port: 0, path: "/graphql" });
		server.on("connection", (_socket, request) => handshakes.push(request.headers));
		await new Promise<void>((resolve) => server.once("listening", () => resolve()));
		port = (server.address() as AddressInfo).port;
		disposer = useServer({ schema, roots: { subscription: root } }, server);
	});

	after(async () => {
		await disposer.dispose();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});

	const subscription = (query: string, overrides: Partial<GraphqlTemplate> = {}): ToolCall<"graphql", unknown> =>
		call({ url: `http://127.0.0.1:${port}/graphql`, operationType: "subscription", query, ...overrides }, { count: 3 });

	async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
		const out: T[] = [];
		for await (const item of iterable) {
			out.push(item);
		}
		return out;
	}

	test("a subscription yields each result's data until the server completes it", async () => {
		const client = new GraphqlClient({ variables: {}, maxResponseBytes: 4096 });
		const events = await collect(client.stream(subscription("subscription T($count: Int!) { ticks(count: $count) }")));
		assert.deepEqual(events, [{ ticks: 1 }, { ticks: 2 }, { ticks: 3 }]);
	});

	test("the WebSocket URL is the template's URL with ws in place of http, and auth goes in the handshake", async () => {
		const client = new GraphqlClient({ variables: { KEY: "k" }, maxResponseBytes: 4096 });
		await collect(
			client.stream(
				subscription("subscription T($count: Int!) { ticks(count: $count) }", {
					auth: { type: "api_key", key: "$KEY", name: "X-Api-Key", location: "header" },
				})
			)
		);
		assert.equal(handshakes.at(-1)?.["x-api-key"], "k");
		assert.equal(handshakes.at(-1)?.["sec-websocket-protocol"], "graphql-transport-ws");
	});

	test("an error while the subscription runs fails the stream after the results before it", async () => {
		const client = new GraphqlClient({ variables: {}, maxResponseBytes: 4096 });
		const got: unknown[] = [];
		await assert.rejects(
			(async () => {
				for await (const event of client.stream(subscription("subscription { failing }"))) {
					got.push(event);
				}
			})(),
			isCode("status")
		);
		assert.deepEqual(got, [{ failing: 1 }]);
	});

	test("a subscription the server rejects fails with status", async () => {
		const client = new GraphqlClient({ variables: {}, maxResponseBytes: 4096 });
		await assert.rejects(collect(client.stream(subscription("subscription { nope }"))), isCode("status"));
	});

	test("breaking out early completes the operation and closes the connection", async () => {
		const client = new GraphqlClient({ variables: {}, maxResponseBytes: 4096 });
		for await (const event of client.stream(subscription("subscription T($count: Int!) { ticks(count: $count) }"))) {
			assert.deepEqual(event, { ticks: 1 });
			break;
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.equal(server.clients.size, 0);
	});

	test("a query is refused by stream()", async () => {
		const client = new GraphqlClient({ variables: {}, maxResponseBytes: 4096 });
		await assert.rejects(collect(client.stream(call())), isCode("unsupported_value"));
	});

	test("a plain ws URL to a public host is refused", async () => {
		const client = new GraphqlClient({ variables: {}, maxResponseBytes: 4096 });
		await assert.rejects(
			collect(client.stream(call({ url: "http://api.example.com/graphql", operationType: "subscription" }))),
			isCode("insecure_url")
		);
	});
});
