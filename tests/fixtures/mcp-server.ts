import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
	CallToolRequestSchema,
	CreateMessageResultSchema,
	EmptyResultSchema,
	ListResourcesRequestSchema,
	ListToolsRequestSchema,
	ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// An MCP server built with the official SDK, for the conformance tests. The
// tools cover each result shape the client handles.

const TOOLS = [
	{ name: "echo", description: "Echoes text.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
	{
		name: "add",
		description: "Adds two numbers.",
		inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] },
		outputSchema: { type: "object", properties: { sum: { type: "number" } }, required: ["sum"] },
	},
	{
		name: "wrapped",
		description: "Returns a list the way FastMCP wraps one.",
		inputSchema: { type: "object", properties: {} },
		outputSchema: { type: "object", properties: { result: { type: "array", items: { type: "integer" } } }, required: ["result"], "x-fastmcp-wrap-result": true },
	},
	{ name: "fail", description: "Always fails.", inputSchema: { type: "object", properties: {} } },
	{ name: "slow", description: "Waits until cancelled.", inputSchema: { type: "object", properties: {} } },
	{ name: "images", description: "Returns two content items.", inputSchema: { type: "object", properties: {} } },
	{ name: "environment", description: "Reports two variables.", inputSchema: { type: "object", properties: {} } },
	{ name: "pings", description: "Pings the client, then answers.", inputSchema: { type: "object", properties: {} } },
	{ name: "samples", description: "Asks the client to sample, which it cannot.", inputSchema: { type: "object", properties: {} } },
];

/** Tools are listed two per page, so listing has to follow `nextCursor`. */
const PAGE = 2;

/** What the slow tool saw: whether its request was cancelled. */
export const observed = { cancelled: false };

export function makeServer(): Server {
	const server = new Server({ name: "fixture", version: "1.0.0" }, { capabilities: { tools: {}, resources: {} } });

	server.setRequestHandler(ListToolsRequestSchema, (request) => {
		const start = Number(request.params?.cursor ?? 0);
		const next = start + PAGE;
		return { tools: TOOLS.slice(start, next), ...(next < TOOLS.length ? { nextCursor: String(next) } : {}) };
	});

	server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
		const args = (request.params.arguments ?? {}) as Record<string, unknown>;
		switch (request.params.name) {
		case "echo":
			return { content: [{ type: "text", text: String(args["text"]) }] };
		case "add": {
			const sum = Number(args["a"]) + Number(args["b"]);
			return { content: [{ type: "text", text: JSON.stringify({ sum }) }], structuredContent: { sum } };
		}
		case "wrapped":
			return { content: [{ type: "text", text: "[1,2]" }], structuredContent: { result: [1, 2] } };
		case "fail":
			return { content: [{ type: "text", text: "it broke" }], isError: true };
		case "slow":
			await new Promise<void>((resolve) => {
				extra.signal.addEventListener("abort", () => {
					observed.cancelled = true;
					resolve();
				});
			});
			return { content: [] };
		case "images":
			return {
				content: [
					{ type: "text", text: "caption" },
					{ type: "image", data: "aGk=", mimeType: "image/png" },
				],
			};
		case "environment":
			return {
				content: [{ type: "text", text: `${process.env["FIXTURE_SECRET"] ?? "unset"}|${process.env["FIXTURE_GIVEN"] ?? "unset"}` }],
			};
		case "pings":
			// Through `extra`, so the request travels with the call it belongs to.
			await extra.sendRequest({ method: "ping" }, EmptyResultSchema);
			return { content: [{ type: "text", text: "pinged" }] };
		case "samples":
			try {
				await extra.sendRequest({ method: "sampling/createMessage", params: { messages: [], maxTokens: 1 } }, CreateMessageResultSchema);
				return { content: [{ type: "text", text: "sampled" }] };
			} catch (error) {
				return { content: [{ type: "text", text: `refused: ${(error as Error).message}` }] };
			}
		default:
			throw new Error(`no tool ${request.params.name}`);
		}
	});

	server.setRequestHandler(ListResourcesRequestSchema, () => ({
		resources: [{ uri: "note://1", name: "first-note", mimeType: "text/plain" }],
	}));

	server.setRequestHandler(ReadResourceRequestSchema, (request) => ({
		contents: [{ uri: request.params.uri, mimeType: "text/plain", text: "note one" }],
	}));

	return server;
}
