import { readFile } from "node:fs/promises";
import { extname, isAbsolute, resolve } from "node:path";

import { parse as parseYaml } from "yaml";

import type { Protocol, TemplateOf } from "../../src/call.js";
import { concat } from "../../src/payload.js";
import { CliClient } from "../../src/protocols/cli.js";
import { GraphqlClient } from "../../src/protocols/graphql.js";
import { HttpClient } from "../../src/protocols/http.js";
import { McpClient } from "../../src/protocols/mcp.js";
import { StreamableHttpClient } from "../../src/protocols/streamable-http.js";
import { TcpClient } from "../../src/protocols/tcp.js";
import { UdpClient } from "../../src/protocols/udp.js";
import { WebSocketClient } from "../../src/protocols/websocket.js";
import { ConfigError } from "./config.js";
import { toolsFromSchema, INTROSPECTION } from "./graphql.js";
import { formatOf, readManual, readMcpSource, readTemplate, type ManualTool, type Schema } from "./manual.js";
import { compare } from "./order.js";
import { Fields, Problems } from "./reader.js";

// Gets the manual the config names. A path or a URL is read as a manual. A
// call template is run through the same protocol client the runtime uses, as
// UTCP's `register_manual` does: GET it, read it, run it, ask the socket, or
// list the MCP server's tools or the GraphQL schema's fields.

/**
 * The largest manual the generator reads, in bytes. GitHub's OpenAPI
 * document, the largest API description we know of, is 12.9 MB; a manual
 * over this is not a manual.
 */
const MAX_MANUAL_BYTES = 64 * 1024 * 1024;

/** The tools a source yields, and where they came from, for messages and banners. */
export interface Discovered {
	readonly tools: readonly ManualTool[];
	/** The protocol the manual was discovered over, which the config must allow. */
	readonly via: Protocol | undefined;
}

/**
 * Reads or discovers the manual.
 *
 * @throws {ConfigError} For a source that is not usable, {@link ManualError}
 * for a manual with problems, and the protocol client's `RoveError` when
 * the source cannot be reached.
 */
export async function discover(
	source: string | Readonly<Record<string, unknown>>,
	root: string,
	options: { readonly graphqlDepth: number | undefined; readonly environment: Readonly<Record<string, string | undefined>> }
): Promise<Discovered> {
	if (typeof source === "string") {
		if (/^[a-z][a-z0-9+.-]*:/iu.test(source) && !/^[a-z]:[\\/]/iu.test(source)) {
			return { tools: await fromUrl(source), via: undefined };
		}
		const path = isAbsolute(source) ? source : resolve(root, source);
		return { tools: readManual(parseDocument(await readFile(path, "utf8"), path), source), via: undefined };
	}

	const problems = new Problems();
	const fields = Fields.of(source, "manual", problems);
	const protocol = fields?.raw("call_template_type");
	const name = "the manual call template in rovebeetle.config.ts";
	if (fields === undefined || typeof protocol !== "string") {
		throw new ConfigError(`${name} needs a call_template_type`);
	}
	if (protocol === "graphql") {
		return { tools: await fromGraphql(fields, problems, options.graphqlDepth), via: "graphql" };
	}
	if (protocol === "mcp") {
		return { tools: await fromMcp(fields, problems, options.environment), via: "mcp" };
	}

	const template = readTemplate(protocol as Protocol, fields, { name: "manual", inputs: {}, outputs: {} }, []);
	problems.throwIfAny(name);
	if (template === undefined) {
		throw new ConfigError(`${name} has a call_template_type of ${JSON.stringify(protocol)}, which is not a UTCP protocol`);
	}

	const manual = await fetchManual(protocol as Protocol, template, options.environment, root);
	// Tools from a socket or WebSocket manual may leave out their own template
	// and are then called through the source's, as the reference does.
	const inherits = protocol === "tcp" || protocol === "udp" || protocol === "websocket";
	return { tools: readManual(manual, describeSource(protocol, source), inherits ? source : undefined), via: protocol as Protocol };
}

function describeSource(protocol: string, source: Readonly<Record<string, unknown>>): string {
	const where = source["url"] ?? source["file_path"] ?? source["host"] ?? "the configured command";
	return `the ${protocol} manual at ${String(where)}`;
}

async function fromUrl(url: string): Promise<ManualTool[]> {
	const client = new HttpClient({ variables: {}, maxResponseBytes: MAX_MANUAL_BYTES });
	const body = await client.call({
		protocol: "http",
		tool: "manual",
		template: { url, pathFields: [], method: "GET", contentType: "application/json", headers: { accept: "application/json, application/yaml;q=0.9" }, headerFields: [] },
		args: {},
	});
	return readManual(typeof body === "string" ? parseDocument(body, url) : body, url);
}

async function fetchManual(
	protocol: Protocol,
	template: TemplateOf[Protocol],
	environment: Readonly<Record<string, string | undefined>>,
	root: string
): Promise<unknown> {
	const variables = {};
	const limit = MAX_MANUAL_BYTES;
	const ask = { type: "utcp" };

	switch (protocol) {
	case "http":
	case "sse": {
		const http = template as TemplateOf["http"];
		const body = await new HttpClient({ variables, maxResponseBytes: limit }).call({
			protocol: "http",
			tool: "manual",
			template: { ...http, method: protocol === "http" ? http.method : "GET", contentType: http.contentType ?? "application/json" },
			args: {},
		});
		return typeof body === "string" ? parseDocument(body, http.url) : body;
	}
	case "streamable_http": {
		const chunks: (unknown | Uint8Array)[] = [];
		for await (const chunk of new StreamableHttpClient({ variables, maxResponseBytes: limit }).stream({
			protocol,
			tool: "manual",
			template: template as TemplateOf["streamable_http"],
			args: {},
		})) {
			chunks.push(chunk);
		}
		const [first] = chunks;
		if (chunks.length === 1 && !(first instanceof Uint8Array)) {
			return first;
		}
		const bytes = chunks.filter((chunk): chunk is Uint8Array => chunk instanceof Uint8Array);
		return parseDocument(new TextDecoder().decode(concat(bytes)), (template as TemplateOf["streamable_http"]).url);
	}
	case "websocket": {
		const socket = template as TemplateOf["websocket"];
		const reply = await new WebSocketClient({ variables, maxResponseBytes: limit }).call({
			protocol,
			tool: "manual",
			template: { ...socket, message: ask, messageFields: [], responseFormat: "text" },
			args: {},
		});
		return parseDocument(String(reply), socket.url);
	}
	case "tcp":
	case "udp": {
		const socket = template as TemplateOf["tcp"] & TemplateOf["udp"];
		const call = { protocol, tool: "manual", template: { ...socket, requestFormat: "json" as const, responseEncoding: "utf-8" }, args: ask };
		const reply =
			protocol === "tcp"
				? await new TcpClient({ variables, maxResponseBytes: limit }).call(call as never)
				: await new UdpClient({ variables, maxResponseBytes: limit }).call(call as never);
		return parseDocument(String(reply), `${socket.host}:${socket.port}`);
	}
	case "cli": {
		const cli = template as TemplateOf["cli"];
		const output = await new CliClient({ variables, environment, maxResponseBytes: limit }).call<string>({
			protocol,
			tool: "manual",
			template: { ...cli, dataFormat: "text", workingDir: cli.workingDir ?? root },
			args: {},
		});
		return parseDocument(output, "the manual command's output");
	}
	case "text":
		return parseDocument((template as TemplateOf["text"]).content, "the manual's text content");
	case "file": {
		const path = resolve(root, (template as TemplateOf["file"]).path);
		return parseDocument(await readFile(path, "utf8"), path);
	}
	case "graphql":
	case "mcp":
		throw new Error(`${protocol} discovery is handled before this point`);
	}
}

async function fromGraphql(fields: Fields, problems: Problems, depth: number | undefined): Promise<ManualTool[]> {
	if (depth === undefined) {
		throw new ConfigError("rovebeetle.config.ts: `graphql.depth` is required when the manual is discovered from a GraphQL schema");
	}
	fields.only(["name", "call_template_type", "url", "headers", "header_fields", "auth", "allowed_communication_protocols", "operation_type"]);
	const template = readTemplate("graphql", fields, { name: "manual", inputs: {}, outputs: { type: "string" } }, []) as TemplateOf["graphql"] | undefined;
	problems.throwIfAny("the graphql manual call template in rovebeetle.config.ts");
	if (template === undefined) {
		throw new ConfigError("the graphql manual call template in rovebeetle.config.ts could not be read");
	}

	const client = new GraphqlClient({ variables: {}, maxResponseBytes: MAX_MANUAL_BYTES });
	const data = await client.call({
		protocol: "graphql",
		tool: "manual",
		template: { ...template, operationType: "query", query: INTROSPECTION, headerFields: [] },
		args: {},
	});
	return toolsFromSchema(data, template, depth);
}

async function fromMcp(
	fields: Fields,
	problems: Problems,
	environment: Readonly<Record<string, string | undefined>>
): Promise<ManualTool[]> {
	const source = readMcpSource(fields);
	problems.throwIfAny("the mcp manual call template in rovebeetle.config.ts");
	if (source === undefined) {
		throw new ConfigError("the mcp manual call template in rovebeetle.config.ts names no servers");
	}

	const client = new McpClient({ variables: {}, environment, maxResponseBytes: MAX_MANUAL_BYTES });
	const tools: ManualTool[] = [];
	try {
		for (const serverName of Object.keys(source.servers).sort(compare)) {
			const server = source.servers[serverName];
			if (server === undefined) {
				continue;
			}
			const probe: TemplateOf["mcp"] = {
				serverName,
				server,
				toolName: "",
				dataFormat: "auto",
				unwrapResult: false,
				...(source.auth === undefined ? {} : { auth: source.auth }),
			};
			for (const listed of await client.listTools(probe)) {
				const outputs = (listed["outputSchema"] ?? {}) as Schema;
				tools.push({
					name: `${serverName}.${String(listed["name"])}`,
					description: typeof listed["description"] === "string" ? listed["description"] : "",
					tags: [],
					inputs: (listed["inputSchema"] ?? {}) as Schema,
					outputs,
					protocol: "mcp",
					template: { ...probe, toolName: String(listed["name"]), dataFormat: formatOf(outputs), unwrapResult: outputs["x-fastmcp-wrap-result"] === true },
					notes: [],
				});
			}
			if (source.resources) {
				for (const resource of await client.listResources(probe)) {
					const description = typeof resource["description"] === "string" ? ` ${resource["description"]}` : "";
					tools.push({
						name: `${serverName}.resource_${String(resource["name"])}`,
						description: `Reads ${String(resource["uri"])}.${description}`,
						tags: ["resource"],
						inputs: { type: "object", properties: {} },
						outputs: {},
						protocol: "mcp",
						template: { ...probe, toolName: `resource_${String(resource["name"])}`, resourceUri: String(resource["uri"]) },
						notes: [],
					});
				}
			}
		}
	} finally {
		await client.close();
	}
	return tools;
}

/** JSON, or YAML for a `.yaml` or `.yml` path or anything that is not JSON. */
export function parseDocument(text: string, where: string): unknown {
	const extension = extname(where).toLowerCase();
	if (extension !== ".yaml" && extension !== ".yml") {
		try {
			return JSON.parse(text) as unknown;
		} catch {
			// Not JSON; YAML is a superset, so try it before giving up.
		}
	}
	try {
		return parseYaml(text, { maxAliasCount: 100 }) as unknown;
	} catch (cause) {
		throw new ConfigError(`${where} is neither JSON nor YAML: ${(cause as Error).message}`);
	}
}
