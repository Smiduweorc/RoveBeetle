import openapiTS, { astToString, type OpenAPI3 } from "openapi-typescript";

import { BANNER_MARK, comment } from "./emit.js";
import type { Json } from "./reader.js";
import type { Plan } from "./plan.js";

// Every tool's argument and result schemas as TypeScript, through
// `openapi-typescript`: each JSON Schema becomes one entry under
// `components.schemas` of a synthetic OpenAPI 3.1 document, whose schema
// objects are JSON Schema 2020-12. The schema algebra (`allOf`, `oneOf`,
// `$ref`, nullability) is left to a generator with years of bug reports
// behind it.

export class SchemaError extends Error {
	override readonly name = "SchemaError";
}

/** The components each planned tool's types come from, by name. */
export function components(plan: Plan): Record<string, Json> {
	const schemas: Record<string, Json> = {};
	for (const tool of plan.tools) {
		add(schemas, `${tool.stem}Args`, tool.args as Json, tool.tool.name);
		if (tool.result.kind === "schema") {
			add(schemas, `${tool.stem}Result`, tool.result.schema as Json, tool.tool.name);
		}
	}
	return schemas;
}

/**
 * Adds one tool schema as `name`, lifting its `$defs` and `definitions` into
 * components of their own (`<name>__<def>`): left in place,
 * `openapi-typescript` would type them as a property every value carries.
 */
function add(schemas: Record<string, Json>, name: string, schema: Json, tool: string): void {
	if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
		schemas[name] = schema;
		return;
	}
	const { $defs, definitions, ...rest } = schema as Record<string, Json>;
	for (const group of [$defs, definitions]) {
		if (typeof group === "object" && group !== null && !Array.isArray(group)) {
			for (const [def, value] of Object.entries(group)) {
				schemas[`${name}__${def}`] = rebase(value, name, tool);
			}
		}
	}
	schemas[name] = rebase(rest, name, tool);
}

/** The source of `src/schema.ts`. */
export async function emitSchema(plan: Plan, source: string): Promise<string> {
	const document = {
		openapi: "3.1.0",
		info: { title: "manual", version: "0" },
		paths: {},
		components: { schemas: components(plan) },
	};
	const ast = await openapiTS(document as unknown as OpenAPI3, { immutable: true });
	return [
		`// ${BANNER_MARK} from ${comment(source)}. Do not edit.`,
		"//",
		"// Every tool's argument and result types. The modules in src/tools alias",
		"// into this file, so a name here is public only where one of them exports it.",
		"",
		astToString(ast),
	].join("\n");
}

/**
 * `schema` with its local references pointed at where it now lives:
 * `#/$defs/x` and `#/definitions/x` at the lifted `<name>__x`, `#` and any
 * other `#/...` at `#/components/schemas/<name>` and below. A reference to
 * anything outside the schema cannot be followed at build time and is
 * refused.
 */
function rebase(schema: Json, name: string, tool: string): Json {
	if (Array.isArray(schema)) {
		return schema.map((item) => rebase(item, name, tool));
	}
	if (typeof schema !== "object" || schema === null) {
		return schema;
	}
	const out: Record<string, Json> = {};
	for (const [key, value] of Object.entries(schema)) {
		if (key === "$ref" && typeof value === "string") {
			if (value !== "#" && !value.startsWith("#/")) {
				throw new SchemaError(`${tool}: its schema refers to ${JSON.stringify(value)}, outside the manual; inline it`);
			}
			const def = /^#\/(?:\$defs|definitions)\/([^/]+)(.*)$/u.exec(value);
			out[key] = def === null ? `#/components/schemas/${name}${value.slice(1)}` : `#/components/schemas/${name}__${def[1] ?? ""}${def[2] ?? ""}`;
			continue;
		}
		if (key === "$id" || key === "$schema") {
			// Identifiers would rebase relative references against a URL that
			// is not where the schema now lives; the dialect is fixed by 3.1.
			continue;
		}
		out[key] = rebase(value, name, tool);
	}
	return out;
}
