import { RoveError } from "./errors.js";

// `UTCP_ARG_<name>_UTCP_ARG` placeholders in `websocket` messages and in
// `tcp` and `udp` request templates. The generator lists which argument
// names a template uses, so only those are replaced.

/**
 * `template` with each named placeholder replaced by its argument, the way
 * the reference implementation does it:
 *
 * | Argument | Template | Inserted as |
 * | --- | --- | --- |
 * | a string | a string that starts with `{` or `[` | the string JSON-escaped without its quotes, so a `"` cannot end the string it sits in |
 * | a string | any other string, or a leaf of an object template | the string |
 * | anything else | anywhere | its JSON text |
 *
 * An object template is filled leaf by leaf and then serialised with
 * `JSON.stringify`, which escapes what it needs to.
 *
 * @throws {RoveError} `unsupported_value` when a placeholder's argument is absent.
 */
export function fillPlaceholders(
	template: string | Readonly<Record<string, unknown>>,
	fields: readonly string[],
	args: Readonly<Record<string, unknown>>,
	tool: string
): string {
	requireFields(fields, args, tool);

	if (typeof template === "string") {
		const trimmed = template.trimStart();
		return fillText(template, fields, args, trimmed.startsWith("{") || trimmed.startsWith("["));
	}
	return JSON.stringify(fillValue(template, fields, args));
}

/**
 * A plain-text template, as `tcp` and `udp` requests are: strings go in as
 * written and anything else as JSON, whatever the template looks like.
 *
 * @throws {RoveError} `unsupported_value` when a placeholder's argument is absent.
 */
export function fillPlainText(
	template: string,
	fields: readonly string[],
	args: Readonly<Record<string, unknown>>,
	tool: string
): string {
	requireFields(fields, args, tool);
	return fillText(template, fields, args, false);
}

function requireFields(fields: readonly string[], args: Readonly<Record<string, unknown>>, tool: string): void {
	for (const name of fields) {
		if (args[name] === undefined) {
			throw new RoveError(`argument ${name} is required by the template`, { code: "unsupported_value", tool });
		}
	}
}

function fillText(text: string, fields: readonly string[], args: Readonly<Record<string, unknown>>, inJson: boolean): string {
	let out = text;
	for (const name of fields) {
		const value = args[name];
		const inserted =
			typeof value === "string" ? (inJson ? JSON.stringify(value).slice(1, -1) : value) : JSON.stringify(value);
		out = out.split(`UTCP_ARG_${name}_UTCP_ARG`).join(inserted);
	}
	return out;
}

function fillValue(value: unknown, fields: readonly string[], args: Readonly<Record<string, unknown>>): unknown {
	if (typeof value === "string") {
		return fillText(value, fields, args, false);
	}
	if (Array.isArray(value)) {
		return value.map((item: unknown) => fillValue(item, fields, args));
	}
	if (typeof value === "object" && value !== null) {
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fillValue(item, fields, args)]));
	}
	return value;
}
