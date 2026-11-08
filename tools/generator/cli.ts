import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { RoveError } from "../../src/errors.js";
import { ConfigError, loadConfig } from "./config.js";
import { discover } from "./discover.js";
import { BANNER_MARK, emitTools } from "./emit.js";
import { plan, PlanError } from "./plan.js";
import { ManualError } from "./reader.js";
import { emitSchema, SchemaError } from "./schema.js";
import { exportsRegion, posix, previousValues, surfaceRegion, withExports, withRegion } from "./surface.js";

// The command a person runs. Diagnostics go to stderr, nothing goes to stdout,
// and the exit code is the part a script reads: 0 wrote or would write, 1 the
// manual or the configuration was refused or could not be reached, 2 the
// command line was wrong.

const HELP = `Usage: npm run generate -- [options]

Writes one function per tool from the UTCP manual named in rovebeetle.config.ts.

Options:
  --config <path>  Configuration file. Default: ./rovebeetle.config.ts
  --manual <path>  A manual file or https URL to read in place of the
                   configured source, with the rest of the config applied.
                   Resolved against the working directory.
  --dry-run        Discover and report what would change; write nothing.
  --help           Print this and exit.

Discovering a manual can contact servers and, for cli and stdio mcp sources,
run the commands the config names: review the config as you review code.
`;

const TOOLS = join("src", "tools");
const SCHEMA = join("src", "schema.ts");
const INDEX = "index.ts";
const SURFACE = join("tests", "dist", "public-api.test.js");
const MANIFEST = "package.json";

function report(line: string): void {
	process.stderr.write(`${line}\n`);
}

async function main(argv: readonly string[]): Promise<number> {
	let options;
	try {
		({ values: options } = parseArgs({
			args: [...argv],
			options: {
				config: { type: "string", default: "rovebeetle.config.ts" },
				manual: { type: "string" },
				"dry-run": { type: "boolean", default: false },
				help: { type: "boolean", default: false },
			},
			strict: true,
		}));
	} catch (cause) {
		report(cause instanceof Error ? cause.message : String(cause));
		report(HELP);
		return 2;
	}

	if (options.help) {
		process.stderr.write(HELP);
		return 0;
	}
	if (options.manual !== undefined && options.manual.length === 0) {
		report("--manual needs a path or a URL.");
		return 2;
	}

	try {
		await generate(resolve(options.config), options["dry-run"], options.manual);
		return 0;
	} catch (error) {
		if (
			error instanceof ConfigError ||
			error instanceof ManualError ||
			error instanceof PlanError ||
			error instanceof SchemaError ||
			error instanceof RoveError
		) {
			report(error.message);
			return 1;
		}
		throw error;
	}
}

async function generate(configPath: string, dryRun: boolean, override: string | undefined): Promise<void> {
	const config = await loadConfig(configPath);
	const root = dirname(configPath);
	const manual =
		override === undefined ? config.manual : /^https?:/iu.test(override) ? override : resolve(process.cwd(), override);
	const source = typeof manual === "string" ? manual : `a ${String(manual["call_template_type"])} manual call template`;

	// The generator is a build tool run by the maintainer, so it may read the
	// environment: a cli or stdio mcp source inherits from it, through the
	// same allowlist the runtime applies.
	const { tools, via } = await discover(manual, root, { graphqlDepth: config.graphql?.depth, environment: process.env });
	const planned = plan(tools, config, via);
	const written = dryRun ? "would write" : "written";

	for (const warning of planned.warnings) {
		report(`warning: ${warning}`);
	}

	const files = new Map<string, string>([[SCHEMA, await emitSchema(planned, source)]]);
	for (const [name, content] of emitTools(planned, source)) {
		files.set(join(TOOLS, name), content);
	}

	if (!dryRun) {
		await mkdir(join(root, TOOLS), { recursive: true });
	}

	for (const [file, content] of files) {
		const path = join(root, file);
		const existing = await read(path);
		if (existing !== undefined && !existing.includes(BANNER_MARK)) {
			throw new PlanError(`${posix(file)} exists and was not written by this generator; move it aside before generating again`);
		}
		if (existing === content) {
			report(`${posix(file)} unchanged`);
			continue;
		}
		if (!dryRun) {
			await writeFile(path, content, "utf8");
		}
		report(`${posix(file)} ${written}`);
	}

	await removeStale(root, files, dryRun);
	await updateSurface(root, planned, dryRun, written);
}

/** Deletes modules an earlier run wrote and this one no longer produces. */
async function removeStale(root: string, files: ReadonlyMap<string, string>, dryRun: boolean): Promise<void> {
	let present: string[];
	try {
		present = await readdir(join(root, TOOLS));
	} catch {
		return;
	}
	for (const entry of present.sort()) {
		const file = join(TOOLS, entry);
		if (!entry.endsWith(".ts") || files.has(file)) {
			continue;
		}
		const existing = await read(join(root, file));
		if (existing?.includes(BANNER_MARK) !== true) {
			continue;
		}
		if (!dryRun) {
			await rm(join(root, file));
		}
		report(`${posix(file)} ${dryRun ? "would be removed" : "removed"}, the manual no longer has tools for it`);
	}
}

async function updateSurface(root: string, planned: ReturnType<typeof plan>, dryRun: boolean, written: string): Promise<void> {
	const surfacePath = join(root, SURFACE);
	const before = previousValues((await read(surfacePath)) ?? "");
	const after = planned.tools.map((tool) => tool.name);

	const updates: [string, (existing: string) => string][] = [
		[INDEX, (existing) => withRegion(existing, exportsRegion(planned), "generated exports")],
		[SURFACE, (existing) => withRegion(existing, surfaceRegion(planned), "generated public surface")],
		[MANIFEST, (existing) => withExports(existing, planned)],
	];

	for (const [file, update] of updates) {
		const path = join(root, file);
		const existing = await read(path);
		if (existing === undefined) {
			report(`${posix(file)} is missing, so its generated part was skipped`);
			continue;
		}
		const updated = update(existing);
		if (updated === existing) {
			report(`${posix(file)} unchanged`);
			continue;
		}
		if (!dryRun) {
			await writeFile(path, updated, "utf8");
		}
		report(`${posix(file)} ${written}`);
	}

	const added = after.filter((name) => !before.includes(name)).sort();
	const removed = before.filter((name) => !after.includes(name)).sort();
	report(`public names added: ${added.length > 0 ? added.join(", ") : "none"}`);
	report(`public names removed: ${removed.length > 0 ? removed.join(", ") : "none"}`);
	report(`subpaths: ${planned.protocols.length > 0 ? planned.protocols.join(", ") : "none"}`);
}

async function read(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch {
		return undefined;
	}
}

process.exitCode = await main(process.argv.slice(2));
