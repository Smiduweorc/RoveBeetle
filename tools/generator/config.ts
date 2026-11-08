import { access } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import type { Protocol } from "../../src/call.js";
import { variablesIn } from "../../src/variables.js";
import { PROTOCOLS } from "./manual.js";

/**
 * What `rovebeetle.config.ts` exports by default. This is all of it.
 */
export interface GeneratorConfig {
	/**
	 * Where the manual comes from: a path (resolved against this file) or an
	 * `https:` URL of a UTCP manual in JSON or YAML, or a UTCP manual call
	 * template, the same object UTCP puts in `manual_call_templates`, to
	 * discover the manual over that protocol. The config is build-time code,
	 * so credentials come from `process.env` here; a `${VAR}` in it is an
	 * error.
	 */
	readonly manual: string | Readonly<Record<string, unknown>>;

	/**
	 * The protocols this package may speak. A tool using any other stops the
	 * run, and so does a protocol listed here that no tool uses. No default:
	 * whether your package spawns shells (`cli`) or processes (stdio `mcp`)
	 * is your decision.
	 */
	readonly protocols: readonly Protocol[];

	/** Function names for tools whose generated name reads badly or collides, keyed by the tool's name in the manual. */
	readonly names?: Readonly<Record<string, string>>;

	/** Tools to leave out, by their name in the manual. Each one must exist. */
	readonly skip?: readonly string[];

	/**
	 * Required when `manual` is a `graphql` call template. `depth` is how many
	 * levels of object fields a discovered tool's query selects: 1 selects the
	 * scalar fields of the result, 2 also those of the objects inside it.
	 * Every level multiplies what each call pulls, so the number is yours.
	 */
	readonly graphql?: { readonly depth: number };
}

/** A configuration that names its own fix. */
export class ConfigError extends Error {
	override readonly name = "ConfigError";
}

const KEYS = ["manual", "protocols", "names", "skip", "graphql"];

/** Words a generated function cannot be named. */
export const RESERVED = new Set(
	"break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with yield let static implements interface package private protected public await arguments eval".split(
		" "
	)
);

/**
 * Loads and checks a config file.
 *
 * @throws {ConfigError} Naming the key and the fix.
 */
export async function loadConfig(path: string): Promise<GeneratorConfig> {
	try {
		await access(path);
	} catch {
		throw new ConfigError(`${path} does not exist; create it with \`export default { manual: "...", protocols: ["http"] }\``);
	}

	let module: { default?: unknown };
	try {
		module = (await import(pathToFileURL(path).href)) as { default?: unknown };
	} catch (cause) {
		throw new ConfigError(`${path} could not be loaded: ${(cause as Error).message}`);
	}
	return checkConfig(module.default, path);
}

/**
 * Checks a config object.
 *
 * @throws {ConfigError} Naming the key and the fix.
 */
export function checkConfig(value: unknown, path: string): GeneratorConfig {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new ConfigError(`${path} must export a default object, such as \`export default { manual: "./manual.json", protocols: ["http"] }\``);
	}
	const config = value as Record<string, unknown>;

	for (const key of Object.keys(config)) {
		if (!KEYS.includes(key)) {
			throw new ConfigError(`${path}: \`${key}\` is not a config key; the keys are ${KEYS.join(", ")}`);
		}
	}

	const { manual, protocols, names, skip, graphql } = config;

	if (typeof manual === "string") {
		if (manual.length === 0) {
			throw new ConfigError(`${path}: \`manual\` is empty; give a path, an https URL, or a manual call template`);
		}
	} else if (typeof manual !== "object" || manual === null || Array.isArray(manual)) {
		throw new ConfigError(`${path}: \`manual\` is required: a path, an https URL, or a manual call template`);
	} else {
		const variable = findVariable(manual);
		if (variable !== undefined) {
			throw new ConfigError(
				`${path}: \`manual\` contains \${${variable}}; the config is code, so read it with process.env["${variable}"] instead`
			);
		}
	}

	if (!Array.isArray(protocols) || protocols.length === 0) {
		throw new ConfigError(`${path}: \`protocols\` is required: the protocols this package may speak, such as ["http"]`);
	}
	for (const protocol of protocols) {
		if (!(PROTOCOLS as readonly unknown[]).includes(protocol)) {
			throw new ConfigError(`${path}: \`protocols\` has ${JSON.stringify(protocol)}; the protocols are ${PROTOCOLS.join(", ")}`);
		}
	}
	if (new Set(protocols).size !== protocols.length) {
		throw new ConfigError(`${path}: \`protocols\` lists a protocol twice`);
	}

	if (names !== undefined) {
		if (typeof names !== "object" || names === null || Array.isArray(names)) {
			throw new ConfigError(`${path}: \`names\` must map tool names to function names`);
		}
		for (const [tool, name] of Object.entries(names)) {
			if (typeof name !== "string" || !/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(name) || RESERVED.has(name)) {
				throw new ConfigError(`${path}: \`names\` gives ${JSON.stringify(tool)} the name ${JSON.stringify(name)}, which is not a usable function name`);
			}
		}
	}

	if (skip !== undefined && (!Array.isArray(skip) || skip.some((item) => typeof item !== "string"))) {
		throw new ConfigError(`${path}: \`skip\` must be a list of tool names`);
	}

	if (graphql !== undefined) {
		if (typeof graphql !== "object" || graphql === null || Array.isArray(graphql)) {
			throw new ConfigError(`${path}: \`graphql\` must be { depth: number }`);
		}
		for (const key of Object.keys(graphql)) {
			if (key !== "depth") {
				throw new ConfigError(`${path}: \`graphql.${key}\` is not a config key; the only one is depth`);
			}
		}
		const { depth } = graphql as { depth?: unknown };
		if (typeof depth !== "number" || !Number.isSafeInteger(depth) || depth < 1) {
			throw new ConfigError(`${path}: \`graphql.depth\` must be a whole number of at least 1, such as 2`);
		}
	}

	return config as unknown as GeneratorConfig;
}

/**
 * The first `${NAME}` or `$NAME` anywhere in a value, so a config cannot hope
 * for substitution. A `cli` template's commands are skipped: the shell owns
 * `$` there.
 */
function findVariable(value: unknown): string | undefined {
	if (typeof value === "string") {
		return variablesIn(value)[0];
	}
	if (Array.isArray(value)) {
		for (const item of value) {
			const found = findVariable(item);
			if (found !== undefined) {
				return found;
			}
		}
		return undefined;
	}
	if (typeof value === "object" && value !== null) {
		for (const [key, item] of Object.entries(value)) {
			if (key === "commands") {
				continue;
			}
			const found = findVariable(item);
			if (found !== undefined) {
				return found;
			}
		}
	}
	return undefined;
}
