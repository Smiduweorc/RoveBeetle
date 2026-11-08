import { parse as parseGraphql, Kind, type OperationDefinitionNode } from "graphql";

import type {
	Auth,
	CliCommand,
	DataFormat,
	McpServer,
	OAuth2Auth,
	Protocol,
	TcpFraming,
	TemplateOf,
} from "../../src/call.js";
import { decodeEscapes } from "./escapes.js";
import { Fields, Problems, type Json } from "./reader.js";

// Reads a UTCP 1.x manual and turns each tool's call template into the shape
// the runtime reads, with every default the spec defines filled in. The
// field names, types and defaults are the `python-utcp` pydantic models at
// bb8e2f6, which is where the spec is actually written down.

export const PROTOCOLS: readonly Protocol[] = [
	"http",
	"sse",
	"streamable_http",
	"graphql",
	"websocket",
	"tcp",
	"udp",
	"mcp",
	"cli",
	"text",
	"file",
];

/** A JSON Schema, as the manual gives it. */
export type Schema = { readonly [key: string]: Json };

/** One tool, read and checked. */
export interface ManualTool<P extends Protocol = Protocol> {
	/** The name in the manual, used for messages and as the call's `tool`. */
	readonly name: string;
	readonly description: string;
	readonly tags: readonly string[];
	readonly inputs: Schema;
	readonly outputs: Schema;
	readonly protocol: P;
	readonly template: TemplateOf[P];
	/**
	 * Values the manual gives that the runtime does not apply (timeouts,
	 * reconnects, chunk sizes), for the tool's doc comment.
	 */
	readonly notes: readonly string[];
}

/** RFC 9110 `token`: what a header or cookie name may be made of. */
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;

/** `{name}` that is not the `{NAME}` of a `${NAME}` variable. */
const PATH_PLACEHOLDER = /(?<!\$)\{([^{}]+)\}/gu;

/**
 * The tools in `value`, a parsed manual. `source` names it in messages.
 *
 * @throws {ManualError} Listing every problem found.
 */
export function readManual(value: unknown, source: string, inherit?: Readonly<Record<string, unknown>>): ManualTool[] {
	const problems = new Problems();
	const tools: ManualTool[] = [];

	if (typeof value === "object" && value !== null && ("openapi" in value || "swagger" in value)) {
		problems.add("manual", "is an OpenAPI document; RoveBeetle reads UTCP manuals, and dung beetle (https://github.com/Smiduweorc/dung-beetle-template) generates clients from OpenAPI");
		problems.throwIfAny(source);
	}

	const manual = Fields.of(value, "manual", problems);
	if (manual !== undefined) {
		manual.only(["utcp_version", "manual_version", "tools", "info"]);
		const version = manual.required("utcp_version");
		if (version.length > 0 && !/^1(\.\d+){0,2}$/u.test(version)) {
			manual.problem("utcp_version", `is ${JSON.stringify(version)}; only UTCP 1.x manuals are supported`);
		}
		manual.string("manual_version");

		const list = manual.raw("tools");
		if (!Array.isArray(list)) {
			manual.problem("tools", "must be a list of tools");
		} else {
			list.forEach((item, index) => {
				const tool = readTool(item, `tools[${index}]`, problems, inherit);
				if (tool !== undefined) {
					tools.push(tool);
				}
			});
		}

		const seen = new Set<string>();
		for (const tool of tools) {
			if (seen.has(tool.name)) {
				problems.add("tools", `two tools are named ${JSON.stringify(tool.name)}`);
			}
			seen.add(tool.name);
		}
	}

	problems.throwIfAny(source);
	return tools;
}

/**
 * One tool. `inherit` is the manual source's own template, which a tool from
 * a socket or WebSocket manual without one of its own is called through, as
 * the reference does.
 */
function readTool(value: unknown, path: string, problems: Problems, inherit: Readonly<Record<string, unknown>> | undefined): ManualTool | undefined {
	const tool = Fields.of(value, path, problems);
	if (tool === undefined) {
		return undefined;
	}
	tool.only(["name", "description", "inputs", "outputs", "tags", "average_response_size", "tool_call_template"]);

	const name = tool.required("name");
	const description = tool.string("description", "");
	const tags = tool.strings("tags") ?? [];
	tool.integer("average_response_size", undefined, 0);
	const inputs = schemaOf(tool, "inputs");
	const outputs = schemaOf(tool, "outputs");

	const template =
		tool.has("tool_call_template") || inherit === undefined
			? tool.object("tool_call_template")
			: Fields.of(inherit, `${path} (inherited from the manual source)`, problems);
	if (template === undefined) {
		if (!tool.has("tool_call_template")) {
			tool.problem("tool_call_template", "is required");
		}
		return undefined;
	}

	const protocol = template.raw("call_template_type");
	if (typeof protocol !== "string" || !(PROTOCOLS as readonly string[]).includes(protocol)) {
		template.problem("call_template_type", `must be one of ${PROTOCOLS.join(", ")}, found ${JSON.stringify(protocol ?? null)}`);
		return undefined;
	}

	const notes: string[] = [];
	const read = readTemplate(protocol as Protocol, template, { name, inputs, outputs }, notes);
	if (read === undefined) {
		return undefined;
	}
	return { name, description, tags, inputs, outputs, protocol: protocol as Protocol, template: read, notes };
}

function schemaOf(tool: Fields, key: string): Schema {
	const value = tool.raw(key);
	if (value === undefined) {
		return {};
	}
	if (typeof value !== "object" || Array.isArray(value)) {
		tool.problem(key, "must be a JSON Schema object");
		return {};
	}
	return value as Schema;
}

interface ToolFacts {
	readonly name: string;
	readonly inputs: Schema;
	readonly outputs: Schema;
}

/** Fields every call template may carry. */
const COMMON = ["name", "call_template_type", "auth", "allowed_communication_protocols"];

/**
 * One tool's call template in the runtime's shape, or `undefined` when it is
 * refused (the reason is in `problems`). Exported for the generator's manual
 * sources, which are call templates too.
 */
export function readTemplate(protocol: Protocol, template: Fields, tool: ToolFacts, notes: string[]): TemplateOf[Protocol] | undefined {
	template.string("name");
	if (template.has("allowed_communication_protocols")) {
		const list = template.strings("allowed_communication_protocols");
		if (list !== undefined && list.length > 0) {
			template.problem(
				"allowed_communication_protocols",
				"is decided in rovebeetle.config.ts, by `protocols`; remove it from the manual's templates"
			);
		}
	}
	template.absent(
		"auth_tools",
		"applies to tools converted from OpenAPI, which RoveBeetle does not do; generate OpenAPI documents with dung beetle"
	);

	switch (protocol) {
	case "http": {
		template.only([...COMMON, "url", "http_method", "content_type", "headers", "body_field", "header_fields", "auth_tools"]);
		const request = requestFields(template, "body");
		return {
			...request,
			method: template.choice("http_method", ["GET", "POST", "PUT", "DELETE", "PATCH"] as const, "GET"),
			contentType: template.string("content_type", "application/json"),
		};
	}
	case "sse": {
		template.only([...COMMON, "url", "event_type", "reconnect", "retry_timeout", "headers", "body_field", "header_fields"]);
		const request = requestFields(template, undefined);
		const reconnect = template.boolean("reconnect", true);
		const retry = template.integer("retry_timeout", 30000, 0);
		notes.push(`The manual sets reconnect to ${String(reconnect)} and retry_timeout to ${String(retry)} ms. This client never reconnects; wrap the call to retry.`);
		const eventType = template.string("event_type");
		return { ...request, ...(eventType === undefined ? {} : { eventType }), dataFormat: formatOf(itemSchema(tool.outputs)) };
	}
	case "streamable_http": {
		template.only([...COMMON, "url", "http_method", "content_type", "chunk_size", "timeout", "headers", "body_field", "header_fields"]);
		const request = requestFields(template, undefined);
		const timeout = template.integer("timeout", 60000, 0);
		const chunk = template.integer("chunk_size", 4096, 1);
		notes.push(`The manual sets timeout to ${String(timeout)} ms and chunk_size to ${String(chunk)} bytes. Neither is applied: pass AbortSignal.timeout() for a timeout.`);
		return {
			...request,
			method: template.choice("http_method", ["GET", "POST"] as const, "GET"),
			contentType: template.string("content_type", "application/octet-stream"),
		};
	}
	case "graphql":
		return readGraphql(template, tool);
	case "websocket": {
		template.only([...COMMON, "url", "message", "protocol", "keep_alive", "response_format", "timeout", "headers", "header_fields"]);
		const url = template.required("url");
		const auth = readAuth(template, true);
		const message = template.raw("message");
		let messageFields: readonly string[] = [];
		if (message !== undefined) {
			if (typeof message !== "string" && (typeof message !== "object" || Array.isArray(message))) {
				template.problem("message", "must be a string or an object");
			} else {
				messageFields = placeholderFields(JSON.stringify(message), "UTCP_ARG_", "_UTCP_ARG", tool.inputs);
			}
		}
		const timeout = template.integer("timeout", 30, 0);
		const keepAlive = template.boolean("keep_alive", true);
		notes.push(`The manual sets timeout to ${String(timeout)} s and keep_alive to ${String(keepAlive)}. Neither is applied: each call opens and closes its own connection.`);
		const responseFormat = template.raw("response_format");
		const protocolName = template.string("protocol");
		return {
			url,
			...(message === undefined ? {} : { message: message as string | Record<string, unknown> }),
			messageFields,
			...(protocolName === undefined ? {} : { protocol: protocolName }),
			...(responseFormat === undefined ? {} : { responseFormat: template.choice("response_format", ["json", "text", "raw"] as const, "raw") }),
			headers: headersOf(template),
			headerFields: headerFieldsOf(template),
			...(auth === undefined ? {} : { auth }),
		};
	}
	case "tcp":
	case "udp":
		return readSocket(protocol, template, tool, notes);
	case "mcp":
		return readMcp(template, tool);
	case "cli": {
		template.only([...COMMON, "commands", "env_vars", "inherit_env_vars", "working_dir"]);
		template.absent("auth", "has no meaning for cli, which the spec gives no auth");
		const steps = template.objects("commands");
		const commands: CliCommand[] = [];
		if (steps === undefined || steps.length === 0) {
			template.problem("commands", "must be a non-empty list of commands");
		} else {
			steps.forEach((step, index) => {
				step.only(["command", "append_to_final_output"]);
				const command = step.required("command");
				const append = step.raw("append_to_final_output");
				if (append !== undefined && typeof append !== "boolean") {
					step.problem("append_to_final_output", "must be true or false");
				}
				// The spec's default: only the last command's output is kept.
				commands.push({ command, appendToFinalOutput: typeof append === "boolean" ? append : index === steps.length - 1 });
			});
		}
		const inherit = template.strings("inherit_env_vars");
		const workingDir = template.string("working_dir");
		return {
			commands,
			dataFormat: formatOf(tool.outputs),
			envVars: template.stringRecord("env_vars"),
			...(inherit === undefined ? {} : { inheritEnvVars: inherit }),
			...(workingDir === undefined ? {} : { workingDir }),
		};
	}
	case "text": {
		template.only([...COMMON, "content", "base_url", "auth_tools"]);
		template.absent("auth", "has no meaning for text");
		template.absent("base_url", "only applies to OpenAPI content, which RoveBeetle does not convert");
		const content = template.raw("content");
		if (typeof content !== "string") {
			template.problem("content", "is required and must be a string");
		}
		return { content: typeof content === "string" ? content : "" };
	}
	case "file": {
		template.only([...COMMON, "file_path", "auth_tools"]);
		template.absent("auth", "has no meaning for file");
		return { path: template.required("file_path") };
	}
	}
}

/** The fields every request-shaped HTTP template shares. */
interface RequestShape {
	readonly url: string;
	readonly pathFields: readonly string[];
	readonly headers: Readonly<Record<string, string>>;
	readonly bodyField?: string;
	readonly headerFields: readonly string[];
	readonly auth?: Auth;
}

function requestFields(template: Fields, defaultBodyField: string | undefined): RequestShape {
	const url = template.required("url");
	const pathFields = pathFieldsOf(template, url);
	const bodyField = template.has("body_field") ? template.string("body_field") : defaultBodyField;
	const auth = readAuth(template, true);
	return {
		url,
		pathFields,
		headers: headersOf(template),
		...(bodyField === undefined ? {} : { bodyField }),
		headerFields: headerFieldsOf(template),
		...(auth === undefined ? {} : { auth }),
	};
}

/**
 * The `{name}` placeholders in a URL, which must all sit in the path: one in
 * the host or port would let an argument move the request to another machine.
 */
function pathFieldsOf(template: Fields, url: string): readonly string[] {
	const names = [...url.matchAll(PATH_PLACEHOLDER)].map((match) => match[1] ?? "");
	const authority = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/iu.exec(url)?.[1] ?? "";
	if ([...authority.matchAll(PATH_PLACEHOLDER)].length > 0) {
		template.problem("url", "has a {placeholder} in its host or port; arguments may only fill the path");
	}
	const query = url.includes("?") ? url.slice(url.indexOf("?")) : "";
	if ([...query.matchAll(PATH_PLACEHOLDER)].length > 0) {
		template.problem("url", "has a {placeholder} in its query string; leave it out, and the argument is sent as a query parameter");
	}
	return [...new Set(names)];
}

function headersOf(template: Fields): Readonly<Record<string, string>> {
	const headers = template.stringRecord("headers");
	for (const [name, value] of Object.entries(headers)) {
		if (!TOKEN.test(name)) {
			template.problem("headers", `has ${JSON.stringify(name)}, which is not a valid header name`);
		}
		if (/[\r\n\0]/u.test(value)) {
			template.problem("headers", `has a value for ${name} containing a line break or NUL`);
		}
	}
	return headers;
}

function headerFieldsOf(template: Fields): readonly string[] {
	const fields = template.strings("header_fields") ?? [];
	for (const name of fields) {
		if (!TOKEN.test(name)) {
			template.problem("header_fields", `has ${JSON.stringify(name)}, which is not a valid header name`);
		}
	}
	return fields;
}

/** The template's auth, or `undefined`. `allowed` is false for protocols the spec gives none. */
function readAuth(template: Fields, allowed: boolean): Auth | undefined {
	const auth = template.object("auth");
	if (auth === undefined) {
		return undefined;
	}
	if (!allowed) {
		template.problem("auth", "has no meaning for this protocol");
		return undefined;
	}
	const type = auth.choice("auth_type", ["api_key", "basic", "oauth2"] as const, "api_key");
	if (!auth.has("auth_type")) {
		auth.problem("auth_type", "is required");
	}
	switch (type) {
	case "api_key": {
		auth.only(["auth_type", "api_key", "var_name", "location"]);
		const name = auth.string("var_name", "X-Api-Key");
		const location = auth.choice("location", ["header", "query", "cookie"] as const, "header");
		if (location !== "query" && !TOKEN.test(name)) {
			auth.problem("var_name", `is ${JSON.stringify(name)}, which is not a valid ${location} name`);
		}
		const key = auth.required("api_key");
		if (/[\r\n\0]/u.test(key)) {
			auth.problem("api_key", "contains a line break or NUL");
		}
		return { type, key, name, location };
	}
	case "basic":
		auth.only(["auth_type", "username", "password"]);
		return { type, username: auth.required("username"), password: auth.required("password") };
	case "oauth2": {
		auth.only(["auth_type", "token_url", "client_id", "client_secret", "scope"]);
		const scope = auth.string("scope");
		return {
			type,
			tokenUrl: auth.required("token_url"),
			clientId: auth.required("client_id"),
			clientSecret: auth.required("client_secret"),
			...(scope === undefined ? {} : { scope }),
		};
	}
	}
}

/**
 * The argument names that appear as `<open><name><close>` in a template,
 * matched against the tool's input properties, longest first, so
 * `UTCP_ARG_user_id_UTCP_ARG` is `user_id` even when `user` is also an input.
 */
export function placeholderFields(text: string, open: string, close: string, inputs: Schema): readonly string[] {
	const properties = typeof inputs["properties"] === "object" && inputs["properties"] !== null ? Object.keys(inputs["properties"]) : [];
	const found = new Set<string>();
	const pattern = new RegExp(`${open}([A-Za-z0-9_]+?)${close}`, "gu");
	for (const match of text.matchAll(pattern)) {
		found.add(match[1] ?? "");
	}
	// A lazy match stops at the first close marker; names that contain the
	// marker's own underscores are recovered from the declared inputs.
	for (const name of properties) {
		if (text.includes(`${open}${name}${close}`)) {
			found.add(name);
		}
	}
	return [...found].filter((name) => text.includes(`${open}${name}${close}`)).sort();
}

/** For a streamed result, the schema of one item: `items` when the result is declared as a list. */
export function itemSchema(outputs: Schema): Schema {
	const items = outputs["items"];
	return outputs["type"] === "array" && typeof items === "object" && items !== null && !Array.isArray(items) ? (items as Schema) : outputs;
}

/** `text` for a string schema, `auto` for none at all, `json` for anything else. */
export function formatOf(schema: Schema): DataFormat {
	if (Object.keys(schema).length === 0) {
		return "auto";
	}
	return schema["type"] === "string" ? "text" : "json";
}

function readGraphql(template: Fields, tool: ToolFacts): TemplateOf["graphql"] | undefined {
	template.only([...COMMON, "url", "operation_type", "operation_name", "headers", "header_fields", "query", "variable_types"]);
	const url = template.required("url");
	const operationType = template.choice("operation_type", ["query", "mutation", "subscription"] as const, "query");
	const operationName = template.string("operation_name");
	const headerFields = headerFieldsOf(template);
	const auth = readAuth(template, true);
	const variableTypes = template.stringRecord("variable_types");
	let query = template.string("query");

	if (query === undefined) {
		// The reference builds `query($a: String) { name(a: $a) }` at call
		// time, which has no selection set and so only works for a field
		// that returns a scalar.
		const scalar = ["string", "number", "integer", "boolean"].includes(String(tool.outputs["type"]));
		if (!scalar) {
			template.problem(
				"query",
				"is required unless the tool's outputs are a scalar: a generated query has no selection set, which a server refuses for an object result"
			);
			return undefined;
		}
		const properties =
			typeof tool.inputs["properties"] === "object" && tool.inputs["properties"] !== null ? Object.keys(tool.inputs["properties"]) : [];
		const variables = properties.filter((name) => !headerFields.includes(name)).sort();
		const field = tool.name.includes(".") ? tool.name.slice(tool.name.indexOf(".") + 1) : tool.name;
		const definitions = variables.map((name) => `$${name}: ${variableTypes[name] ?? "String"}`).join(", ");
		const passed = variables.map((name) => `${name}: $${name}`).join(", ");
		query = `${operationType}${definitions.length > 0 ? `(${definitions})` : ""} { ${field}${passed.length > 0 ? `(${passed})` : ""} }`;
	}

	try {
		const document = parseGraphql(query);
		const operations = document.definitions.filter((definition): definition is OperationDefinitionNode => definition.kind === Kind.OPERATION_DEFINITION);
		const chosen = operationName === undefined ? operations : operations.filter((operation) => operation.name?.value === operationName);
		if (operationName === undefined && operations.length !== 1) {
			template.problem("operation_name", `is required: the query has ${operations.length} operations`);
		} else if (chosen.length !== 1) {
			template.problem("operation_name", `names no operation in the query: ${JSON.stringify(operationName)}`);
		} else if (chosen[0]?.operation !== operationType) {
			template.problem("operation_type", `is ${operationType}, and the query's operation is a ${String(chosen[0]?.operation)}`);
		}
	} catch (cause) {
		template.problem("query", `is not valid GraphQL: ${(cause as Error).message}`);
	}

	return {
		url,
		operationType,
		...(operationName === undefined ? {} : { operationName }),
		query,
		headers: headersOf(template),
		headerFields,
		...(auth === undefined ? {} : { auth }),
	};
}

function readSocket(protocol: "tcp" | "udp", template: Fields, tool: ToolFacts, notes: string[]): TemplateOf["tcp"] | TemplateOf["udp"] {
	const common = ["host", "port", "request_data_format", "request_data_template", "response_byte_format", "timeout"];
	template.only(
		protocol === "tcp"
			? [...COMMON, ...common, "framing_strategy", "length_prefix_bytes", "length_prefix_endian", "message_delimiter", "interpret_escape_sequences", "fixed_message_length", "max_response_size"]
			: [...COMMON, ...common, "number_of_response_datagrams"]
	);
	template.absent("auth", `has no meaning for ${protocol}, which the spec gives no auth`);

	const host = template.required("host");
	const port = template.integer("port", undefined, 1);
	if (port === undefined) {
		if (!template.has("port")) {
			template.problem("port", "is required");
		}
	} else if (port > 65535) {
		template.problem("port", `must be at most 65535, found ${port}`);
	}
	const requestTemplate = template.string("request_data_template");
	// `null` here means "return the bytes", so it is not the same as absent.
	const responseEncoding = template.isNull("response_byte_format") ? null : template.string("response_byte_format", "utf-8");
	if (responseEncoding !== null) {
		try {
			new TextDecoder(responseEncoding);
		} catch {
			template.problem("response_byte_format", `is ${JSON.stringify(responseEncoding)}, which is not an encoding this runtime can decode`);
		}
	}
	const timeout = template.integer("timeout", 30000, 0);
	notes.push(`The manual sets timeout to ${String(timeout)} ms. It is not applied: pass AbortSignal.timeout().`);

	const base = {
		host,
		port: port ?? 0,
		requestFormat: template.choice("request_data_format", ["json", "text"] as const, "json"),
		...(requestTemplate === undefined ? {} : { requestTemplate }),
		requestFields: requestTemplate === undefined ? [] : placeholderFields(requestTemplate, "UTCP_ARG_", "_UTCP_ARG", tool.inputs),
		responseEncoding,
	};

	if (protocol === "udp") {
		return { ...base, datagrams: template.integer("number_of_response_datagrams", 1, 0) ?? 1 };
	}
	return { ...base, framing: readFraming(template) };
}

function readFraming(template: Fields): TcpFraming {
	const strategy = template.choice("framing_strategy", ["length_prefix", "delimiter", "fixed_length", "stream"] as const, "stream");
	switch (strategy) {
	case "length_prefix":
		return {
			strategy,
			bytes: template.choice("length_prefix_bytes", [1, 2, 4, 8] as const, 4),
			endian: template.choice("length_prefix_endian", ["big", "little"] as const, "big"),
		};
	case "delimiter": {
		const written = template.string("message_delimiter", "\u0000");
		const interpret = template.boolean("interpret_escape_sequences", true);
		let delimiter = written;
		if (interpret) {
			try {
				delimiter = decodeEscapes(written);
			} catch (cause) {
				template.problem("message_delimiter", (cause as Error).message);
			}
		}
		if (delimiter.length === 0) {
			template.problem("message_delimiter", "is empty, so no response could ever end");
		}
		return { strategy, delimiter };
	}
	case "fixed_length": {
		const length = template.integer("fixed_message_length", undefined, 1);
		if (length === undefined && !template.has("fixed_message_length")) {
			template.problem("fixed_message_length", "is required with fixed_length framing");
		}
		return { strategy, length: length ?? 1 };
	}
	case "stream":
		return { strategy, maxResponseSize: template.integer("max_response_size", 65536, 1) ?? 65536 };
	}
}

function readMcp(template: Fields, tool: ToolFacts): TemplateOf["mcp"] | undefined {
	const source = readMcpSource(template);
	if (source === undefined) {
		return undefined;
	}
	const { servers, auth } = source;
	const names = Object.keys(servers).sort();
	const dot = tool.name.indexOf(".");
	let serverName: string | undefined;
	let toolName = tool.name;

	if (dot !== -1 && names.includes(tool.name.slice(0, dot))) {
		serverName = tool.name.slice(0, dot);
		toolName = tool.name.slice(dot + 1);
	} else if (names.length === 1) {
		serverName = names[0];
	} else {
		template.problem(
			"config.mcpServers",
			`has ${names.length} servers (${names.join(", ")}) and the tool name ${JSON.stringify(tool.name)} does not say which; name it server.tool`
		);
		return undefined;
	}
	if (toolName.startsWith("resource_")) {
		template.problem(
			"config",
			`${JSON.stringify(tool.name)} reads a resource, whose URI only the server knows; discover the manual from the server instead`
		);
		return undefined;
	}
	const server = servers[serverName ?? ""];
	if (server === undefined) {
		return undefined;
	}
	if (server.transport === "stdio" && auth !== undefined) {
		template.problem("auth", "has no meaning for a stdio server");
	}

	return {
		serverName: serverName ?? "",
		server,
		toolName,
		...(auth === undefined ? {} : { auth }),
		dataFormat: formatOf(tool.outputs),
		unwrapResult: tool.outputs["x-fastmcp-wrap-result"] === true,
	};
}

/** An `mcp` manual source: its servers, its auth, and whether resources become tools. */
export interface McpSource {
	readonly servers: Readonly<Record<string, McpServer>>;
	readonly auth?: OAuth2Auth;
	readonly resources: boolean;
}

/** Reads an `mcp` manual call template, reporting into `fields`' problems. */
export function readMcpSource(template: Fields): McpSource | undefined {
	template.only([...COMMON, "config", "register_resources_as_tools"]);
	const resources = template.boolean("register_resources_as_tools", false);
	const auth = readAuth(template, true);
	if (auth !== undefined && auth.type !== "oauth2") {
		template.problem("auth", "must be oauth2 for mcp, the only auth the spec gives it");
	}
	const servers = readServers(template);
	return servers === undefined ? undefined : { servers, resources, ...(auth?.type === "oauth2" ? { auth } : {}) };
}

/** `config.mcpServers`, each entry a stdio command or an HTTP URL. */
function readServers(template: Fields): Record<string, McpServer> | undefined {
	const config = template.object("config");
	if (config === undefined) {
		template.problem("config", "is required, with mcpServers");
		return undefined;
	}
	config.only(["mcpServers"]);
	const list = config.object("mcpServers");
	if (list === undefined) {
		config.problem("mcpServers", "is required");
		return undefined;
	}

	const servers: Record<string, McpServer> = {};
	const names = list.keys();
	if (names.length === 0) {
		config.problem("mcpServers", "names no server");
		return undefined;
	}
	for (const name of names) {
		const entry = list.object(name);
		if (entry !== undefined) {
			const server = readServer(entry);
			if (server !== undefined) {
				servers[name] = server;
			}
		}
	}
	return servers;
}

function readServer(entry: Fields): McpServer | undefined {
	entry.only(["command", "args", "env", "cwd", "transport", "url", "headers"]);
	const transport = entry.string("transport");
	if (entry.has("command")) {
		if (transport !== undefined && transport !== "stdio") {
			entry.problem("transport", `is ${JSON.stringify(transport)} for a server with a command`);
		}
		const cwd = entry.string("cwd");
		return {
			transport: "stdio",
			command: entry.required("command"),
			args: entry.strings("args") ?? [],
			env: entry.stringRecord("env"),
			...(cwd === undefined ? {} : { cwd }),
		};
	}
	if (entry.has("url")) {
		if (transport === "sse") {
			entry.problem(
				"transport",
				"is the legacy HTTP+SSE transport of protocol 2024-11-05, which this client does not speak; use the server's Streamable HTTP endpoint"
			);
		} else if (transport !== undefined && !["http", "streamable-http", "streamable_http"].includes(transport)) {
			entry.problem("transport", `is ${JSON.stringify(transport)}; expected http or streamable-http`);
		}
		return { transport: "http", url: entry.required("url"), headers: headersOf(entry) };
	}
	entry.problem("command", "or url is required");
	return undefined;
}
