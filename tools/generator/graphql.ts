import {
	buildClientSchema,
	getIntrospectionQuery,
	getNamedType,
	isEnumType,
	isInputObjectType,
	isListType,
	isNonNullType,
	isScalarType,
	isUnionType,
	type GraphQLField,
	type GraphQLInputType,
	type GraphQLObjectType,
	type GraphQLOutputType,
	type IntrospectionQuery,
} from "graphql";

import type { Auth, GraphqlTemplate } from "../../src/call.js";
import type { ManualTool, Schema } from "./manual.js";

// Discovery for `graphql`: introspect the schema and make one tool per root
// field, with its arguments as the input schema and a query that selects the
// result to `depth` levels. The reference makes these tools with an empty
// input schema and no selection set; a server refuses that query for every
// field that returns an object.

/** The introspection query, as `graphql` defines it. */
export const INTROSPECTION = getIntrospectionQuery({ descriptions: true });

/** The tools a schema offers, from an introspection result's `data`. */
export function toolsFromSchema(
	data: unknown,
	source: { readonly url: string; readonly headers: Readonly<Record<string, string>>; readonly headerFields: readonly string[]; readonly auth?: Auth },
	depth: number
): ManualTool<"graphql">[] {
	const schema = buildClientSchema(data as IntrospectionQuery);
	const tools: ManualTool<"graphql">[] = [];

	for (const [operation, root] of [
		["query", schema.getQueryType()],
		["mutation", schema.getMutationType()],
		["subscription", schema.getSubscriptionType()],
	] as const) {
		if (root === null || root === undefined) {
			continue;
		}
		for (const field of Object.values(root.getFields())) {
			tools.push(toolFor(operation, field, source, depth));
		}
	}
	return tools;
}

function toolFor(
	operation: "query" | "mutation" | "subscription",
	field: GraphQLField<unknown, unknown>,
	source: Parameters<typeof toolsFromSchema>[1],
	depth: number
): ManualTool<"graphql"> {
	const skipped: string[] = [];
	const selection = select(field.type, depth, [], skipped);
	const definitions = field.args.map((arg) => `$${arg.name}: ${String(arg.type)}`).join(", ");
	const passed = field.args.map((arg) => `${arg.name}: $${arg.name}`).join(", ");
	const operationName = `${capitalize(operation)}${capitalize(field.name)}`;
	const query = `${operation} ${operationName}${definitions.length > 0 ? `(${definitions})` : ""} { ${field.name}${passed.length > 0 ? `(${passed})` : ""}${selection} }`;

	const properties: Record<string, Schema> = {};
	const required: string[] = [];
	for (const arg of field.args) {
		properties[arg.name] = inputSchema(arg.type, new Set());
		if (isNonNullType(arg.type) && arg.defaultValue === undefined) {
			required.push(arg.name);
		}
	}

	const template: GraphqlTemplate = {
		url: source.url,
		operationType: operation,
		operationName,
		query,
		headers: source.headers,
		headerFields: source.headerFields,
		...(source.auth === undefined ? {} : { auth: source.auth }),
	};

	return {
		name: field.name,
		description: field.description ?? "",
		tags: [operation],
		inputs: { type: "object", properties, ...(required.length > 0 ? { required } : {}), additionalProperties: false },
		outputs: {
			type: "object",
			properties: { [field.name]: outputSchema(field.type, depth) },
			required: [field.name],
		},
		protocol: "graphql",
		template,
		notes: skipped.length > 0 ? [`Fields that need arguments are not selected: ${skipped.join(", ")}.`] : [],
	};
}

/** The selection set for `type`, to `depth` levels of objects, or "" for a scalar. */
function select(type: GraphQLOutputType, depth: number, path: readonly string[], skipped: string[]): string {
	const named = getNamedType(type);
	if (isScalarType(named) || isEnumType(named)) {
		return "";
	}
	if (isUnionType(named)) {
		return " { __typename }";
	}
	const object = named as GraphQLObjectType;
	const fields: string[] = [];
	for (const field of Object.values(object.getFields())) {
		if (field.args.some((arg) => isNonNullType(arg.type) && arg.defaultValue === undefined)) {
			skipped.push([...path, field.name].join("."));
			continue;
		}
		const inner = getNamedType(field.type);
		if (isScalarType(inner) || isEnumType(inner)) {
			fields.push(field.name);
		} else if (depth > 1) {
			fields.push(`${field.name}${select(field.type, depth - 1, [...path, field.name], skipped)}`);
		}
	}
	return ` { ${fields.length > 0 ? fields.join(" ") : "__typename"} }`;
}

/** JSON Schema for a GraphQL input type. Input objects that refer to themselves stop at an open object. */
function inputSchema(type: GraphQLInputType, seen: ReadonlySet<string>): Schema {
	const nullable = !isNonNullType(type);
	const inner = isNonNullType(type) ? type.ofType : type;
	let schema: Schema;
	if (isListType(inner)) {
		schema = { type: "array", items: inputSchema(inner.ofType, seen) };
	} else if (isEnumType(inner)) {
		schema = { type: "string", enum: inner.getValues().map((value) => value.name) };
	} else if (isInputObjectType(inner)) {
		if (seen.has(inner.name)) {
			schema = { type: "object" };
		} else {
			const next = new Set([...seen, inner.name]);
			const fields = Object.values(inner.getFields());
			const required = fields.filter((field) => isNonNullType(field.type) && field.defaultValue === undefined).map((field) => field.name);
			schema = {
				type: "object",
				properties: Object.fromEntries(fields.map((field) => [field.name, inputSchema(field.type, next)])),
				...(required.length > 0 ? { required } : {}),
				additionalProperties: false,
			};
		}
	} else {
		schema = scalarSchema(inner.name);
	}
	return nullable ? { anyOf: [schema, { type: "null" }] } : schema;
}

/** JSON Schema for what a selection returns, matching {@link select}. `depth` bounds the recursion. */
function outputSchema(type: GraphQLOutputType, depth: number): Schema {
	const nullable = !isNonNullType(type);
	const inner = isNonNullType(type) ? type.ofType : type;
	let schema: Schema;
	if (isListType(inner)) {
		schema = { type: "array", items: outputSchema(inner.ofType, depth) };
	} else if (isEnumType(inner)) {
		schema = { type: "string", enum: inner.getValues().map((value) => value.name) };
	} else if (isScalarType(inner)) {
		schema = scalarSchema(inner.name);
	} else if (isUnionType(inner)) {
		schema = { type: "object", properties: { __typename: { type: "string" } }, required: ["__typename"] };
	} else {
		const object = inner as GraphQLObjectType;
		const properties: Record<string, Schema> = {};
		for (const field of Object.values(object.getFields())) {
			if (field.args.some((arg) => isNonNullType(arg.type) && arg.defaultValue === undefined)) {
				continue;
			}
			const named = getNamedType(field.type);
			if (isScalarType(named) || isEnumType(named)) {
				properties[field.name] = outputSchema(field.type, depth);
			} else if (depth > 1) {
				properties[field.name] = outputSchema(field.type, depth - 1);
			}
		}
		schema =
			Object.keys(properties).length > 0
				? { type: "object", properties, required: Object.keys(properties) }
				: { type: "object", properties: { __typename: { type: "string" } }, required: ["__typename"] };
	}
	return nullable ? { anyOf: [schema, { type: "null" }] } : schema;
}

/** JSON Schema for a scalar: the five built in, and anything else as unknown. */
function scalarSchema(name: string): Schema {
	switch (name) {
	case "String":
	case "ID":
		return { type: "string" };
	case "Int":
		return { type: "integer" };
	case "Float":
		return { type: "number" };
	case "Boolean":
		return { type: "boolean" };
	default:
		return {};
	}
}

function capitalize(value: string): string {
	return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}
