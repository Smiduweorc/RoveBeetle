import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, test } from "node:test";

const root = fileURLToPath(new URL("../..", import.meta.url));
const cli = join(root, "tools", "generator", "cli.ts");

let project: string;

/** A scratch copy of the files the generator edits, with `manual` and `config` written in. */
async function setUp(manual: unknown, config: string): Promise<void> {
	await writeFile(join(project, "manual.json"), JSON.stringify(manual));
	await writeFile(join(project, "rovebeetle.config.ts"), config);
}

function run(...args: string[]): { status: number | null; stderr: string } {
	const result = spawnSync(process.execPath, ["--import", "tsx", cli, "--config", join(project, "rovebeetle.config.ts"), ...args], {
		cwd: root,
		encoding: "utf8",
	});
	return { status: result.status, stderr: result.stderr };
}

const tool = (name: string, protocol: "http" | "text" = "http"): Record<string, unknown> => ({
	name,
	tool_call_template: protocol === "http" ? { call_template_type: "http", url: "https://api.example.com/x" } : { call_template_type: "text", content: "x" },
});

beforeEach(async () => {
	project = await mkdtemp(join(tmpdir(), "rove-beetle-cli-"));
	await mkdir(join(project, "tests", "dist"), { recursive: true });
	await cp(join(root, "tests", "dist", "public-api.test.js"), join(project, "tests", "dist", "public-api.test.js"));
	await writeFile(join(project, "index.ts"), "// hand-written header\nexport { RoveError } from \"./src/errors.js\";\n");
	await writeFile(join(project, "package.json"), JSON.stringify({ name: "x", exports: { ".": {} } }, null, "\t"));
});

afterEach(async () => {
	await rm(project, { recursive: true, force: true });
});

const read = (path: string): Promise<string> => readFile(join(project, path), "utf8");

describe("the generate command", () => {
	test("--help prints usage and exits 0", () => {
		const result = run("--help");
		assert.equal(result.status, 0);
		assert.match(result.stderr, /Usage: npm run generate/u);
	});

	test("an unknown flag or an empty --manual exits 2", () => {
		assert.equal(run("--nope").status, 2);
		assert.equal(run("--manual", "").status, 2);
	});

	test("a missing config exits 1 and says how to write one", () => {
		const result = run();
		assert.equal(result.status, 1);
		assert.match(result.stderr, /does not exist; create it/u);
	});

	test("a first run writes the modules, the regions and the exports, and reports the new names", async () => {
		await setUp({ utcp_version: "1", tools: [tool("get_a"), tool("motd", "text")] }, "export default { manual: \"./manual.json\", protocols: [\"http\", \"text\"] };");
		const result = run();
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stderr, /src\/tools\/http\.ts written/u);
		assert.match(result.stderr, /public names added: getA, motd/u);
		assert.match(result.stderr, /subpaths: http, text/u);

		assert.match(await read("src/tools/http.ts"), /export function getA/u);
		const index = await read("index.ts");
		assert.match(index, /^\/\/ hand-written header\nexport \{ RoveError \}/u);
		assert.match(index, /export \{\n\tgetA,\n\} from "\.\/src\/tools\/http\.js";/u);
		assert.match(index, /export type VariableName = never;/u);
		assert.deepEqual(Object.keys(JSON.parse(await read("package.json")).exports as object), [".", "./http", "./text"]);
		assert.match(await read("package.json"), /\n\t"exports"/u);
		assert.match(await read("tests/dist/public-api.test.js"), /const generatedSurface = \[\n\t"getA",\n\t"motd",\n\];/u);
	});

	test("a second run changes nothing and adds no names", async () => {
		await setUp({ utcp_version: "1", tools: [tool("get_a")] }, "export default { manual: \"./manual.json\", protocols: [\"http\"] };");
		run();
		const result = run();
		assert.equal(result.status, 0);
		assert.match(result.stderr, /src\/tools\/http\.ts unchanged/u);
		assert.match(result.stderr, /public names added: none/u);
	});

	test("--dry-run reports what would change and writes nothing", async () => {
		await setUp({ utcp_version: "1", tools: [tool("get_a")] }, "export default { manual: \"./manual.json\", protocols: [\"http\"] };");
		const result = run("--dry-run");
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stderr, /src\/tools\/http\.ts would write/u);
		await assert.rejects(read("src/tools/http.ts"));
		assert.equal(await read("index.ts"), "// hand-written header\nexport { RoveError } from \"./src/errors.js\";\n");
	});

	test("a tool that disappears is reported as a removed name, and its module goes when its protocol does", async () => {
		await setUp({ utcp_version: "1", tools: [tool("get_a"), tool("motd", "text")] }, "export default { manual: \"./manual.json\", protocols: [\"http\", \"text\"] };");
		run();
		await setUp({ utcp_version: "1", tools: [tool("get_a")] }, "export default { manual: \"./manual.json\", protocols: [\"http\"] };");
		const result = run();
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stderr, /public names removed: motd/u);
		assert.match(result.stderr, /src\/tools\/text\.ts removed/u);
		await assert.rejects(read("src/tools/text.ts"));
	});

	test("a hand-written module where a generated one would go is never overwritten", async () => {
		await setUp({ utcp_version: "1", tools: [tool("get_a")] }, "export default { manual: \"./manual.json\", protocols: [\"http\"] };");
		await mkdir(join(project, "src", "tools"), { recursive: true });
		await writeFile(join(project, "src", "tools", "http.ts"), "// mine\n");
		const result = run();
		assert.equal(result.status, 1);
		assert.match(result.stderr, /was not written by this generator/u);
		assert.equal(await read("src/tools/http.ts"), "// mine\n");
	});

	test("a hand-written file in src/tools that the generator would not write is left alone", async () => {
		await setUp({ utcp_version: "1", tools: [tool("get_a")] }, "export default { manual: \"./manual.json\", protocols: [\"http\"] };");
		await mkdir(join(project, "src", "tools"), { recursive: true });
		await writeFile(join(project, "src", "tools", "extra.ts"), "// mine\n");
		assert.equal(run().status, 0);
		assert.equal(await read("src/tools/extra.ts"), "// mine\n");
	});

	test("a refused manual exits 1 with every problem and writes nothing", async () => {
		await setUp({ utcp_version: "0.1", tools: [{ name: "a" }] }, "export default { manual: \"./manual.json\", protocols: [\"http\"] };");
		const result = run();
		assert.equal(result.status, 1);
		assert.match(result.stderr, /utcp_version/u);
		assert.match(result.stderr, /tool_call_template: is required/u);
		await assert.rejects(read("src/schema.ts"));
	});

	test("a protocol the config does not allow exits 1 with a skip block", async () => {
		await setUp({ utcp_version: "1", tools: [tool("get_a"), tool("motd", "text")] }, "export default { manual: \"./manual.json\", protocols: [\"http\"] };");
		const result = run();
		assert.equal(result.status, 1);
		assert.match(result.stderr, /skip: \["motd"\]/u);
	});

	test("--manual reads another manual with the rest of the config applied", async () => {
		await setUp({ utcp_version: "1", tools: [tool("get_a")] }, "export default { manual: \"./manual.json\", protocols: [\"http\"], names: { get_b: \"fetchB\" } };");
		await writeFile(join(project, "other.json"), JSON.stringify({ utcp_version: "1", tools: [tool("get_b")] }));
		const result = run("--manual", join(project, "other.json"));
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stderr, /public names added: fetchB/u);
	});

	test("a literal secret in the manual is a warning, and the run goes on", async () => {
		await setUp(
			{ utcp_version: "1", tools: [{ name: "a", tool_call_template: { call_template_type: "http", url: "https://a", auth: { auth_type: "api_key", api_key: "sk_live" } } }] },
			"export default { manual: \"./manual.json\", protocols: [\"http\"] };"
		);
		const result = run();
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stderr, /warning: a: auth\.api_key is written in the manual/u);
	});

	test("a misspelled config key exits 1 naming it", async () => {
		await setUp({ utcp_version: "1", tools: [] }, "export default { manual: \"./manual.json\", protocol: [\"http\"] };");
		const result = run();
		assert.equal(result.status, 1);
		assert.match(result.stderr, /`protocol` is not a config key/u);
	});
});
