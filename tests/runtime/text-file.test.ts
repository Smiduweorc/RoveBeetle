import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, describe, test } from "node:test";

import type { ToolCall } from "../../src/call.js";
import { RoveError } from "../../src/errors.js";
import { FileClient } from "../../src/protocols/file.js";
import { TextClient } from "../../src/protocols/text.js";

function isCode(code: string): (error: unknown) => boolean {
	return (error) => error instanceof RoveError && error.code === code;
}

describe("text calls", () => {
	test("the result is the content as written, $ signs included", async () => {
		const call: ToolCall<"text", string> = { protocol: "text", tool: "price", template: { content: "costs $PRICE \u2603" }, args: { ignored: 1 } };
		assert.equal(await new TextClient().call(call), "costs $PRICE \u2603");
	});

	test("a call for another protocol is refused", async () => {
		const other = { protocol: "file", tool: "x", template: { path: "a" }, args: {} } as unknown as ToolCall<"text", string>;
		await assert.rejects(new TextClient().call(other), isCode("unsupported_value"));
	});
});

describe("file calls", () => {
	let root: string;

	before(async () => {
		root = await mkdtemp(join(tmpdir(), "rovebeetle-file-"));
		await writeFile(join(root, "notes.txt"), "hello \u2603");
		await writeFile(join(root, "big.txt"), "x".repeat(100));
		await writeFile(join(tmpdir(), "rovebeetle-outside.txt"), "secret");
	});

	after(async () => {
		await rm(root, { recursive: true, force: true });
		await rm(join(tmpdir(), "rovebeetle-outside.txt"), { force: true });
	});

	const read = (path: string): ToolCall<"file", string, string> => ({ protocol: "file", tool: "read", template: { path }, args: {} });
	const client = (overrides: Partial<ConstructorParameters<typeof FileClient>[0]> = {}): FileClient<string> =>
		new FileClient<string>({ variables: { DIR: "." }, root, maxResponseBytes: 64, ...overrides });

	test("root and maxResponseBytes are required", () => {
		assert.throws(() => new FileClient({ variables: {}, maxResponseBytes: 1 } as never), isCode("unsupported_value"));
		assert.throws(() => new FileClient({ variables: {}, root } as never), isCode("unsupported_value"));
	});

	test("a relative path is read from the root, as UTF-8", async () => {
		assert.equal(await client().call(read("notes.txt")), "hello \u2603");
	});

	test("variables in the path are filled", async () => {
		assert.equal(await client().call(read("$DIR/notes.txt")), "hello \u2603");
	});

	test("root may be a file URL", async () => {
		assert.equal(await client({ root: pathToFileURL(`${root}/`) }).call(read("notes.txt")), "hello \u2603");
	});

	test("an absolute path inside the root is read", async () => {
		assert.equal(await client().call(read(join(root, "notes.txt"))), "hello \u2603");
	});

	for (const path of ["../rovebeetle-outside.txt", "sub/../../rovebeetle-outside.txt"]) {
		test(`${path} resolves outside the root and is refused`, async () => {
			await assert.rejects(client().call(read(path)), isCode("unsupported_value"));
		});
	}

	test("an absolute path outside the root is refused", async () => {
		await assert.rejects(client().call(read(join(tmpdir(), "rovebeetle-outside.txt"))), isCode("unsupported_value"));
	});

	test("a root of / allows any path", async () => {
		assert.equal(await client({ root: "/" }).call(read(join(tmpdir(), "rovebeetle-outside.txt"))), "secret");
	});

	test("a file over maxResponseBytes is protocol_error, and one at the limit is read", async () => {
		await assert.rejects(client({ maxResponseBytes: 99 }).call(read("big.txt")), isCode("protocol_error"));
		assert.equal((await client({ maxResponseBytes: 100 }).call(read("big.txt"))).length, 100);
	});

	test("a missing file is transport_failed with the system error as cause", async () => {
		await assert.rejects(client().call(read("nope.txt")), (error: unknown) =>
			error instanceof RoveError && error.code === "transport_failed" && (error.cause as { code?: string }).code === "ENOENT"
		);
	});

	test("an aborted signal rejects with its reason", async () => {
		const reason = new Error("stop");
		await assert.rejects(client().call(read("notes.txt"), { signal: AbortSignal.abort(reason) }), (error) => error === reason);
	});

	test("a link inside the root that leads outside it is refused", async () => {
		// A directory junction, which Windows creates without admin rights;
		// elsewhere the type is ignored and it is an ordinary symlink.
		const outside = await mkdtemp(join(tmpdir(), "rovebeetle-outside-dir-"));
		await writeFile(join(outside, "secret.txt"), "secret");
		await symlink(outside, join(root, "escape"), "junction");
		try {
			await assert.rejects(client().call(read("escape/secret.txt")), isCode("unsupported_value"));
		} finally {
			await rm(outside, { recursive: true, force: true });
		}
	});

	test("a link inside the root that leads elsewhere inside it is followed", async () => {
		await mkdir(join(root, "real"), { recursive: true });
		await writeFile(join(root, "real", "inner.txt"), "inner");
		await symlink(join(root, "real"), join(root, "alias"), "junction");
		assert.equal(await client().call(read("alias/inner.txt")), "inner");
	});
});
