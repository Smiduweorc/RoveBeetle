import { exportsOf, SUBPATHS } from "./emit.js";
import { compare } from "./order.js";
import type { Plan } from "./plan.js";

// Keeps the places that list the package's public names in step with the
// generated modules: the export block in `index.ts`, the surface lists the
// built-artifact test checks, and `exports` in `package.json`. The first two
// are edited inside markers, so whatever a person wrote around them survives.

/**
 * A path with forward slashes, whatever the platform builds. Windows joins
 * with backslashes, which would emit `./src\tools/http.js` as a specifier.
 */
export function posix(path: string): string {
	return path.split(/[\\/]/u).join("/");
}

const START = "// rove-beetle:start";
const END = "// rove-beetle:end";

/** The generated export block for `index.ts`. */
export function exportsRegion(plan: Plan): string {
	const blocks: string[] = [];
	for (const protocol of plan.protocols) {
		const tools = plan.tools.filter((tool) => tool.tool.protocol === protocol);
		const { values, types } = exportsOf({ ...plan, tools });
		const from = `"./src/tools/${SUBPATHS[protocol].file}.js"`;
		blocks.push(list("export", values, from), list("export type", types, from));
	}
	const variables = [...new Set(plan.tools.flatMap((tool) => tool.variables))].sort(compare);
	blocks.push(
		[
			"/** Every variable the manual's tools need; a client's `variables` is keyed by these. */",
			`export type VariableName = ${variables.length === 0 ? "never" : variables.map((name) => JSON.stringify(name)).join(" | ")};`,
		].join("\n")
	);
	return blocks.join("\n\n");
}

function list(keyword: string, names: readonly string[], from: string): string {
	return [`${keyword} {`, ...names.map((name) => `\t${name},`), `} from ${from};`].join("\n");
}

/** The generated half of the surface the built-artifact test compares against. */
export function surfaceRegion(plan: Plan): string {
	return [
		"const generatedSurface = [",
		...exportsOf(plan).values.map((name) => `\t${JSON.stringify(name)},`),
		"];",
		"const generatedSubpaths = [",
		...plan.protocols.map((protocol) => `\t${JSON.stringify(`./${SUBPATHS[protocol].file}`)},`),
		"];",
	].join("\n");
}

/** The names inside a file's marked region, which is what the last run wrote. */
export function previousValues(source: string): readonly string[] {
	const start = source.indexOf(START);
	const end = source.indexOf(END);
	if (start === -1 || end === -1 || end < start) {
		return [];
	}
	const region = source.slice(start, end);
	const surface = /const generatedSurface = \[([^\]]*)\]/u.exec(region)?.[1] ?? "";
	return [...surface.matchAll(/"([^"]+)"/gu)].map((match) => match[1] ?? "");
}

/**
 * Replaces a file's marked region, adding one at the end if the file has
 * none. A file the generator has never touched keeps everything it said.
 */
export function withRegion(source: string, content: string, note: string): string {
	const marked = `${START} ${note}\n${content}\n${END}`;
	const start = source.indexOf(START);
	const end = source.indexOf(END);
	if (start === -1 || end === -1 || end < start) {
		return `${source.replace(/\n+$/u, "")}\n\n${marked}\n`;
	}
	return `${source.slice(0, start)}${marked}${source.slice(end + END.length)}`;
}

/** `package.json` with `exports` naming the root and one subpath per protocol the tools use. */
export function withExports(manifest: string, plan: Plan): string {
	const parsed = JSON.parse(manifest) as Record<string, unknown>;
	const exports: Record<string, { types: string; default: string }> = {
		".": { types: "./dist/types/index.d.ts", default: "./dist/index.js" },
	};
	for (const protocol of plan.protocols) {
		const { file } = SUBPATHS[protocol];
		exports[`./${file}`] = { types: `./dist/types/${file}.d.ts`, default: `./dist/${file}.js` };
	}
	parsed["exports"] = exports;
	return `${JSON.stringify(parsed, null, "\t")}\n`;
}
