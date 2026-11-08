// Python's `unicode_escape` for TCP delimiters: the manual writes "\\r\\n"
// and means CR LF. Decoded at generate time, so the runtime gets the real
// characters. Unlike the reference, which encodes to UTF-8 and decodes as
// Latin-1 on the way, non-ASCII text in the delimiter stays as written.

const SIMPLE: Readonly<Record<string, string>> = {
	"\\": "\\",
	"'": "'",
	"\"": "\"",
	a: "\u0007",
	b: "\b",
	f: "\f",
	n: "\n",
	r: "\r",
	t: "\t",
	v: "\v",
};

/**
 * `text` with its escape sequences replaced: the single-character ones,
 * `\ooo` (one to three octal digits), `\xhh`, `\uhhhh` and `\Uhhhhhhhh`. A
 * backslash before any other character stays, as Python leaves it.
 *
 * @throws {Error} For a truncated `\x`, `\u` or `\U`, or `\N{...}`, which
 * needs Python's name table.
 */
export function decodeEscapes(text: string): string {
	let out = "";
	for (let index = 0; index < text.length; index += 1) {
		const char = text[index] ?? "";
		if (char !== "\\" || index === text.length - 1) {
			out += char;
			continue;
		}
		const next = text[index + 1] ?? "";
		const simple = SIMPLE[next];
		if (simple !== undefined) {
			out += simple;
			index += 1;
			continue;
		}
		if (/[0-7]/u.test(next)) {
			const octal = /^[0-7]{1,3}/u.exec(text.slice(index + 1))?.[0] ?? "";
			out += String.fromCodePoint(Number.parseInt(octal, 8));
			index += octal.length;
			continue;
		}
		const width = next === "x" ? 2 : next === "u" ? 4 : next === "U" ? 8 : 0;
		if (width > 0) {
			const hex = text.slice(index + 2, index + 2 + width);
			if (!new RegExp(`^[0-9a-fA-F]{${width}}$`, "u").test(hex)) {
				throw new Error(`has a truncated \\${next} escape`);
			}
			const code = Number.parseInt(hex, 16);
			if (code > 0x10ffff) {
				throw new Error(`has \\${next}${hex}, beyond the last code point`);
			}
			out += String.fromCodePoint(code);
			index += 1 + width;
			continue;
		}
		if (next === "N") {
			throw new Error("uses \\N{...}, which needs Python's character name table; write the character or \\u escape instead");
		}
		out += char;
	}
	return out;
}
