// Reads untrusted JSON one field at a time, collecting every problem instead
// of stopping at the first, so a broken manual is fixed in one round. Each
// problem names the path to the field, the way a person would look it up:
// `tools[3].tool_call_template.auth.location`.

/** Every problem found in one document. */
export class ManualError extends Error {
	override readonly name = "ManualError";

	readonly problems: readonly string[];

	constructor(source: string, problems: readonly string[]) {
		super(
			[`${source} cannot be generated from, for ${problems.length} reason${problems.length === 1 ? "" : "s"}:`, ...problems.map((problem) => `  ${problem}`)].join(
				"\n"
			)
		);
		this.problems = problems;
	}
}

/** Collects problems while reading. */
export class Problems {
	readonly list: string[] = [];

	add(path: string, problem: string): void {
		this.list.push(`${path}: ${problem}`);
	}

	/** @throws {ManualError} If anything was added. */
	throwIfAny(source: string): void {
		if (this.list.length > 0) {
			throw new ManualError(source, this.list);
		}
	}
}

export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };

/** A JSON object being read, which remembers its path and which keys were read. */
export class Fields {
	readonly path: string;
	readonly #value: Readonly<Record<string, unknown>>;
	readonly #problems: Problems;

	private constructor(value: Readonly<Record<string, unknown>>, path: string, problems: Problems) {
		this.#value = value;
		this.path = path;
		this.#problems = problems;
	}

	/** `value` as an object, or `undefined` (and a problem) when it is not one. */
	static of(value: unknown, path: string, problems: Problems): Fields | undefined {
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			problems.add(path, `must be an object, found ${describe(value)}`);
			return undefined;
		}
		return new Fields(value as Record<string, unknown>, path, problems);
	}

	at(key: string): string {
		return `${this.path}.${key}`;
	}

	problem(key: string, text: string): void {
		this.#problems.add(this.at(key), text);
	}

	/** The raw value; `null` reads as absent, as the reference's serializer writes absent fields as `null`. */
	raw(key: string): unknown {
		const value = this.#value[key];
		return value === null ? undefined : value;
	}

	has(key: string): boolean {
		return this.raw(key) !== undefined;
	}

	/** Whether the document wrote `null` itself, for the one field where that differs from absent. */
	isNull(key: string): boolean {
		return this.#value[key] === null;
	}

	/**
	 * Refuses every key not in `known`. A misspelled field would otherwise
	 * fall back to its default: `in` for `location` sends an api key in a
	 * header the provider never reads.
	 */
	only(known: readonly string[]): void {
		for (const key of Object.keys(this.#value)) {
			if (!known.includes(key)) {
				this.problem(key, `is not a field of this object; expected one of ${known.join(", ")}`);
			}
		}
	}

	string(key: string): string | undefined;
	string(key: string, fallback: string): string;
	string(key: string, fallback?: string): string | undefined {
		const value = this.raw(key);
		if (value === undefined) {
			return fallback;
		}
		if (typeof value !== "string") {
			this.problem(key, `must be a string, found ${describe(value)}`);
			return fallback;
		}
		return value;
	}

	required(key: string): string {
		const value = this.raw(key);
		if (value === undefined) {
			this.problem(key, "is required");
			return "";
		}
		if (typeof value !== "string" || value.length === 0) {
			this.problem(key, `must be a non-empty string, found ${describe(value)}`);
			return "";
		}
		return value;
	}

	boolean(key: string, fallback: boolean): boolean {
		const value = this.raw(key);
		if (value === undefined) {
			return fallback;
		}
		if (typeof value !== "boolean") {
			this.problem(key, `must be true or false, found ${describe(value)}`);
			return fallback;
		}
		return value;
	}

	/** A safe integer at least `min`. */
	integer(key: string, fallback: number | undefined, min: number): number | undefined {
		const value = this.raw(key);
		if (value === undefined) {
			return fallback;
		}
		if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) {
			this.problem(key, `must be an integer of at least ${min}, found ${describe(value)}`);
			return fallback;
		}
		return value;
	}

	choice<T extends string | number>(key: string, choices: readonly T[], fallback: T): T {
		const value = this.raw(key);
		if (value === undefined) {
			return fallback;
		}
		if (!choices.includes(value as T)) {
			this.problem(key, `must be one of ${choices.map((choice) => JSON.stringify(choice)).join(", ")}, found ${describe(value)}`);
			return fallback;
		}
		return value as T;
	}

	strings(key: string): readonly string[] | undefined {
		const value = this.raw(key);
		if (value === undefined) {
			return undefined;
		}
		if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
			this.problem(key, `must be a list of strings, found ${describe(value)}`);
			return undefined;
		}
		return value as string[];
	}

	stringRecord(key: string): Readonly<Record<string, string>> {
		const value = this.raw(key);
		if (value === undefined) {
			return {};
		}
		if (typeof value !== "object" || Array.isArray(value) || Object.values(value as object).some((item) => typeof item !== "string")) {
			this.problem(key, `must be an object of strings, found ${describe(value)}`);
			return {};
		}
		return value as Record<string, string>;
	}

	object(key: string): Fields | undefined {
		const value = this.raw(key);
		return value === undefined ? undefined : Fields.of(value, this.at(key), this.#problems);
	}

	/** A list of objects; items that are not objects are reported and left out. */
	objects(key: string): Fields[] | undefined {
		const value = this.raw(key);
		if (value === undefined) {
			return undefined;
		}
		if (!Array.isArray(value)) {
			this.problem(key, `must be a list, found ${describe(value)}`);
			return undefined;
		}
		return value
			.map((item: unknown, index) => Fields.of(item, `${this.at(key)}[${index}]`, this.#problems))
			.filter((item) => item !== undefined);
	}

	/** The object's keys, in the order the document wrote them. */
	keys(): string[] {
		return Object.keys(this.#value);
	}

	/** Refuses a field that has to be absent (or `null`), with the reason. */
	absent(key: string, reason: string): void {
		if (this.has(key)) {
			this.problem(key, reason);
		}
	}
}

export function describe(value: unknown): string {
	if (value === null) {
		return "null";
	}
	if (Array.isArray(value)) {
		return "a list";
	}
	if (typeof value === "string") {
		return JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}...` : value);
	}
	if (typeof value === "object") {
		return "an object";
	}
	return String(value);
}
