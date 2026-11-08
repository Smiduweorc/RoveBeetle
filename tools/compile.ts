import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// Writes generated modules into a throwaway project and runs `tsc` over them,
// against the real `ToolCall`. If the output compiles, the types are sound;
// nothing else the generator does is worth much if this fails. Used by the
// generator's tests.

const root = dirname(import.meta.dirname);

export interface Compilation {
	readonly ok: boolean;

	/** `tsc` output, empty when it had nothing to say. */
	readonly errors: string;
}

/**
 * Compiles `files`, keyed by path under `src/` (`schema.ts`, `tools/http.ts`),
 * plus an optional `check.ts` that uses them.
 *
 * The project is built with the DOM lib rather than `@types/node`, so this also
 * checks that generated code compiles for a consumer building for the browser.
 */
export async function compileGenerated(files: ReadonlyMap<string, string>): Promise<Compilation> {
	const directory = await mkdtemp(join(tmpdir(), "rove-beetle-"));

	try {
		await mkdir(join(directory, "src", "tools"), { recursive: true });
		// The generated modules import only types from `call.ts`.
		await cp(join(root, "src", "call.ts"), join(directory, "src", "call.ts"));

		for (const [name, source] of files) {
			await mkdir(dirname(join(directory, "src", name)), { recursive: true });
			await writeFile(join(directory, "src", name), source, "utf8");
		}

		await writeFile(join(directory, "package.json"), JSON.stringify({ name: "generated", type: "module" }), "utf8");
		await writeFile(
			join(directory, "tsconfig.json"),
			JSON.stringify({
				compilerOptions: {
					target: "es2022",
					lib: ["es2022", "dom"],
					module: "nodenext",
					moduleResolution: "nodenext",
					types: [],
					strict: true,
					noUncheckedIndexedAccess: true,
					verbatimModuleSyntax: true,
					noEmit: true,
					skipLibCheck: true,
				},
				include: ["src/**/*.ts"],
			}),
			"utf8"
		);

		const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
		const compiled = spawnSync(process.execPath, [tsc, "--project", directory], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

		// `tsc` reports with forward slashes even where the directory was joined
		// with backslashes, so both forms are trimmed.
		const posix = directory.split(/[\\/]/u).join("/");
		return {
			ok: compiled.status === 0,
			errors: compiled.stdout.trim().replaceAll(directory, ".").replaceAll(posix, "."),
		};
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}
