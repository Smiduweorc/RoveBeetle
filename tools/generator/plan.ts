import type { Auth, Protocol, TemplateOf } from "../../src/call.js";
import { resolveTemplate } from "../../src/variables.js";
import type { GeneratorConfig } from "./config.js";
import { itemSchema, placeholderFields, type ManualTool, type Schema } from "./manual.js";
import { functionName, typeStem } from "./names.js";
import { compare } from "./order.js";

// Decides what gets written: which tools, under which names, with which
// types and variables, and which protocols the package exports. Every
// refusal is collected so one run lists everything to fix.

/** What one tool's call resolves to: a schema for the generated types, or a fixed type. */
export type ResultShape = { readonly kind: "schema"; readonly schema: Schema } | { readonly kind: "type"; readonly text: string };

export interface PlannedTool {
	readonly tool: ManualTool;
	readonly name: string;
	readonly stem: string;
	/** The input schema, with every argument a template places marked required. */
	readonly args: Schema;
	/** Whether a call needs an argument object at all. */
	readonly argsRequired: boolean;
	readonly result: ResultShape;
	/** Every variable the template needs, sorted. */
	readonly variables: readonly string[];
	/** How a consumer calls it: `call`, `stream`, or either. */
	readonly methods: readonly ("call" | "stream")[];
}

export interface Plan {
	readonly tools: readonly PlannedTool[];
	/** The protocols the generated tools use, which become the package's subpaths. */
	readonly protocols: readonly Protocol[];
	/** Things worth saying that do not stop the run. */
	readonly warnings: readonly string[];
}

export class PlanError extends Error {
	override readonly name = "PlanError";
}

/**
 * The plan for `tools` under `config`.
 *
 * @throws {PlanError} Listing every problem, with blocks to paste where a
 * config change settles them.
 */
export function plan(tools: readonly ManualTool[], config: GeneratorConfig, via: Protocol | undefined): Plan {
	const problems: string[] = [];
	const warnings: string[] = [];
	const skip = new Set(config.skip ?? []);
	const names = config.names ?? {};
	const known = new Set(tools.map((tool) => tool.name));

	for (const name of skip) {
		if (!known.has(name)) {
			problems.push(`skip lists ${JSON.stringify(name)}, which the manual does not have`);
		}
	}
	for (const name of Object.keys(names)) {
		if (!known.has(name)) {
			problems.push(`names renames ${JSON.stringify(name)}, which the manual does not have`);
		}
	}

	const kept = tools.filter((tool) => !skip.has(tool.name));
	const allowed = new Set(config.protocols);

	const refused = kept.filter((tool) => !allowed.has(tool.protocol));
	if (refused.length > 0) {
		const protocols = [...new Set(refused.map((tool) => tool.protocol))].sort(compare);
		problems.push(
			[
				`${refused.length} tool${refused.length === 1 ? " uses" : "s use"} ${protocols.join(", ")}, which \`protocols\` does not allow:`,
				...refused.map((tool) => `  ${tool.name} (${tool.protocol})`),
				`Add ${protocols.map((protocol) => JSON.stringify(protocol)).join(", ")} to \`protocols\`, or leave the tools out:`,
				`  skip: ${JSON.stringify(refused.map((tool) => tool.name).sort(compare))},`,
			].join("\n")
		);
	}
	if (via !== undefined && !allowed.has(via)) {
		problems.push(`the manual is discovered over ${via}, which \`protocols\` does not allow; add "${via}"`);
	}

	const used = new Set(kept.filter((tool) => allowed.has(tool.protocol)).map((tool) => tool.protocol));
	for (const protocol of config.protocols) {
		if (!used.has(protocol) && protocol !== via) {
			problems.push(`\`protocols\` lists ${protocol}, which no tool uses; remove it`);
		}
	}

	const planned: PlannedTool[] = [];
	for (const tool of kept.filter((candidate) => allowed.has(candidate.protocol))) {
		const name = names[tool.name] ?? functionName(tool.name);
		if (name === undefined) {
			problems.push(`${JSON.stringify(tool.name)} gives no usable function name; name it under \`names\``);
			continue;
		}
		const args = argsSchema(tool, problems);
		planned.push({
			tool,
			name,
			stem: typeStem(name),
			args,
			argsRequired: Array.isArray(args["required"]) && args["required"].length > 0,
			result: resultShape(tool),
			variables: variablesOf(tool),
			methods: methodsOf(tool),
		});
		warnings.push(...literalSecrets(tool));
	}

	const byName = new Map<string, PlannedTool[]>();
	for (const tool of planned) {
		byName.set(tool.name, [...(byName.get(tool.name) ?? []), tool]);
	}
	const collisions = [...byName.values()].filter((group) => group.length > 1);
	if (collisions.length > 0) {
		problems.push(
			[
				`${collisions.length} function name${collisions.length === 1 ? " is" : "s are"} wanted by more than one tool. Paste this under \`names\` and pick the names:`,
				...collisions.flatMap((group) => group.map((tool) => `  ${JSON.stringify(tool.tool.name)}: ${JSON.stringify(tool.name)},`)),
			].join("\n")
		);
	}

	if (problems.length > 0) {
		throw new PlanError(problems.join("\n\n"));
	}

	return {
		tools: planned.sort((left, right) => compare(left.name, right.name)),
		protocols: [...used].sort(compare),
		warnings,
	};
}

/**
 * The tool's input schema, with every argument its template places in a
 * URL path, a message or a command added to `required`: the call cannot be
 * made without them. An argument a template places that the inputs do not
 * declare is a problem.
 */
function argsSchema(tool: ManualTool, problems: string[]): Schema {
	const placed = placedFields(tool);
	if (placed.length === 0) {
		return Object.keys(tool.inputs).length === 0 ? { type: "object", properties: {} } : tool.inputs;
	}
	const properties = typeof tool.inputs["properties"] === "object" && tool.inputs["properties"] !== null ? (tool.inputs["properties"] as Schema) : {};
	for (const name of placed) {
		if (!(name in properties)) {
			problems.push(`${tool.name}: its template uses argument ${JSON.stringify(name)}, which its inputs do not declare`);
		}
	}
	const required = new Set(Array.isArray(tool.inputs["required"]) ? (tool.inputs["required"] as string[]) : []);
	for (const name of placed) {
		required.add(name);
	}
	return { ...tool.inputs, type: "object", properties, required: [...required].sort(compare) };
}

function placedFields(tool: ManualTool): readonly string[] {
	switch (tool.protocol) {
	case "http":
	case "sse":
	case "streamable_http":
		return (tool.template as TemplateOf["http"]).pathFields;
	case "websocket":
		return (tool.template as TemplateOf["websocket"]).messageFields;
	case "tcp":
	case "udp":
		return (tool.template as TemplateOf["tcp"]).requestFields;
	case "cli":
		return [
			...new Set(
				(tool.template as TemplateOf["cli"]).commands.flatMap((step) => placeholderFields(step.command, "UTCP_ARG_", "_UTCP_END", tool.inputs))
			),
		];
	default:
		return [];
	}
}

function resultShape(tool: ManualTool): ResultShape {
	const schema = (value: Schema): ResultShape => ({ kind: "schema", schema: value });
	switch (tool.protocol) {
	case "sse":
		return schema(itemSchema(tool.outputs));
	case "streamable_http":
		return schema(itemSchema(tool.outputs));
	case "graphql":
		return (tool.template as TemplateOf["graphql"]).operationType === "subscription" ? schema(itemSchema(tool.outputs)) : schema(tool.outputs);
	case "websocket": {
		const format = (tool.template as TemplateOf["websocket"]).responseFormat;
		return format === "json" ? schema(tool.outputs) : format === "text" ? { kind: "type", text: "string" } : { kind: "type", text: "string | Uint8Array" };
	}
	case "tcp":
	case "udp":
		return { kind: "type", text: (tool.template as TemplateOf["tcp"]).responseEncoding === null ? "Uint8Array" : "string" };
	case "text":
	case "file":
		return { kind: "type", text: "string" };
	case "cli":
		return (tool.template as TemplateOf["cli"]).dataFormat === "text" ? { kind: "type", text: "string" } : schema(tool.outputs);
	case "mcp": {
		const template = tool.template as TemplateOf["mcp"];
		if (template.resourceUri !== undefined) {
			return { kind: "type", text: "readonly Readonly<Record<string, unknown>>[]" };
		}
		const result = (tool.outputs["properties"] as Schema | undefined)?.["result"];
		return template.unwrapResult && typeof result === "object" && result !== null ? schema(result as Schema) : schema(tool.outputs);
	}
	case "http":
		return schema(tool.outputs);
	}
}

function methodsOf(tool: ManualTool): readonly ("call" | "stream")[] {
	switch (tool.protocol) {
	case "sse":
	case "streamable_http":
		return ["stream"];
	case "websocket":
		return ["call", "stream"];
	case "graphql":
		return (tool.template as TemplateOf["graphql"]).operationType === "subscription" ? ["stream"] : ["call"];
	default:
		return ["call"];
	}
}

/** The variables a template needs, computed by the runtime's own substitution. */
function variablesOf(tool: ManualTool): readonly string[] {
	const found = new Set<string>();
	resolveTemplate(tool.protocol, tool.template, (name) => {
		found.add(name);
		return "";
	});
	return [...found].sort(compare);
}

/** Auth fields written as literals, which would be published inside the package. */
function literalSecrets(tool: ManualTool): string[] {
	const auth = (tool.template as { auth?: Auth }).auth;
	if (auth === undefined) {
		return [];
	}
	const secrets: [string, string][] =
		auth.type === "api_key" ? [["api_key", auth.key]] : auth.type === "basic" ? [["password", auth.password]] : [["client_secret", auth.clientSecret]];
	return secrets
		.filter(([, value]) => !/\$\{?[A-Za-z0-9_]+/u.test(value))
		.map(([field]) => `${tool.name}: auth.${field} is written in the manual, not a \${VARIABLE}, so it will be published inside the package`);
}
