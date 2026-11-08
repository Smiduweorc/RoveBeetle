import { RESERVED } from "./config.js";

// Turns a tool's name in the manual into the names a reader sees. Tool names
// are snake_case in most manuals (`get_forecast`) and `server.tool` for MCP;
// both read as one camelCase function (`getForecast`, `weatherGetForecast`).

/**
 * The words an identifier is built from: runs of letters and digits, split
 * again where one word runs into the next in camel case, so `getHTTPStatus`
 * comes apart into `get`, `HTTP`, `Status`.
 */
const WORDS = /[A-Z]+(?![a-z])|[A-Z][a-z0-9]*|[a-z0-9]+/gu;

function words(value: string): readonly string[] {
	return value.match(WORDS) ?? [];
}

function capitalize(value: string): string {
	return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

/**
 * The function name for a tool, or `undefined` when its name has no letters
 * or digits to build one from, or builds a reserved word.
 */
export function functionName(tool: string): string | undefined {
	const [first, ...rest] = words(tool).map((word) => word.toLowerCase());
	if (first === undefined) {
		return undefined;
	}
	const name = `${first}${rest.map(capitalize).join("")}`;
	const safe = /^\d/u.test(name) ? `_${name}` : name;
	return RESERVED.has(safe) ? undefined : safe;
}

/** The type-name stem for a function: `getForecast` gives `GetForecast`. */
export function typeStem(name: string): string {
	return capitalize(name.replace(/^_/u, ""));
}
