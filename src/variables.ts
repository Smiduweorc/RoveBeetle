import type { Auth, McpServer, Protocol, TemplateOf } from "./call.js";
import { RoveError } from "./errors.js";

// Fills `${NAME}` and `$NAME` in a template from the values the client was
// given. The generator runs the same function with a recorder in place of the
// values, so the set of variables a tool needs is computed by the code that
// substitutes them and the two cannot disagree.
//
// Which fields are substituted is the rule in `resolveTemplate` below. The
// spec substitutes every string; the reference client therefore rewrites a
// GraphQL `$id` and looks up a shell's `$HOME` in its own environment. Fields
// that are payloads or code for another interpreter are left alone.

const VARIABLE = /\$\{([A-Za-z0-9_]+)\}|\$([A-Za-z0-9_]+)/gu;

/**
 * A JSON Schema `$ref` in string content, which the spec leaves unsubstituted.
 * `$refresh_token` is a variable, so the next character must not continue the
 * name.
 */
const SCHEMA_REF = /\$ref(?![A-Za-z0-9_])/u;

/** Looks up one variable. Throws when it is missing. */
export type Lookup = (name: string) => string;

/** Every variable name in `text`, in order of appearance, duplicates included. */
export function variablesIn(text: string): readonly string[] {
	if (SCHEMA_REF.test(text)) {
		return [];
	}
	return [...text.matchAll(VARIABLE)].map((match) => match[1] ?? match[2] ?? "");
}

/** `text` with every variable replaced through `lookup`. */
export function substitute(text: string, lookup: Lookup): string {
	if (SCHEMA_REF.test(text)) {
		return text;
	}
	return text.replace(VARIABLE, (_match, braced: string | undefined, bare: string | undefined) =>
		lookup(braced ?? bare ?? "")
	);
}

/**
 * Checks the values handed to a client's constructor: every one a non-empty
 * string. An empty value would send `Authorization: Bearer ` and fail far from
 * where the mistake was made.
 *
 * @throws {RoveError} `variable_missing`, naming the variable.
 */
export function checkVariables(variables: Readonly<Record<string, unknown>>): ReadonlyMap<string, string> {
	const checked = new Map<string, string>();

	for (const [name, value] of Object.entries(variables)) {
		if (typeof value !== "string" || value.length === 0) {
			throw new RoveError(`variable ${name} must be a non-empty string`, { code: "variable_missing" });
		}
		checked.set(name, value);
	}

	return checked;
}

/** A {@link Lookup} over checked values, reporting which tool asked. */
export function lookupIn(variables: ReadonlyMap<string, string>, tool: string): Lookup {
	return (name) => {
		const value = variables.get(name);
		if (value === undefined) {
			throw new RoveError(
				`tool ${tool} needs variable ${name}, which the client was not given; add it to \`variables\``,
				{ code: "variable_missing", tool }
			);
		}
		return value;
	};
}

/**
 * `template` with variables filled in every field the protocol substitutes.
 *
 * | Protocol | Substituted | Left as written |
 * | --- | --- | --- |
 * | `http`, `sse`, `streamable_http` | `url`, header values, auth | `contentType`, field names |
 * | `graphql` | `url`, header values, auth | `query` (GraphQL variables are `$name`) |
 * | `websocket` | `url`, header values, auth, `protocol` | `message` (a payload) |
 * | `tcp`, `udp` | `host` | `requestTemplate` (a payload) |
 * | `mcp` | stdio `command`, `args`, `env` values, `cwd`; http `url`, header values; auth | names |
 * | `cli` | `envVars` values, `workingDir` | `commands` (the shell owns `$`) |
 * | `text` | nothing | `content` (data) |
 * | `file` | `path` | |
 */
export function resolveTemplate<P extends Protocol>(
	protocol: P,
	template: TemplateOf[P],
	lookup: Lookup
): TemplateOf[P] {
	const fill = (text: string): string => substitute(text, lookup);
	const fillRecord = (record: Readonly<Record<string, string>>): Record<string, string> =>
		Object.fromEntries(Object.entries(record).map(([key, value]) => [key, fill(value)]));

	// Each branch narrows `template` itself rather than through `protocol`,
	// which TypeScript cannot correlate with the generic parameter.
	const resolved = ((): TemplateOf[Protocol] => {
		const any = template as TemplateOf[Protocol];
		switch (protocol) {
		case "http":
		case "sse":
		case "streamable_http":
		case "graphql": {
			const http = any as TemplateOf["http"];
			return {
				...http,
				url: fill(http.url),
				headers: fillRecord(http.headers),
				...(http.auth === undefined ? {} : { auth: resolveAuth(http.auth, fill) }),
			};
		}
		case "websocket": {
			const socket = any as TemplateOf["websocket"];
			return {
				...socket,
				url: fill(socket.url),
				headers: fillRecord(socket.headers),
				...(socket.protocol === undefined ? {} : { protocol: fill(socket.protocol) }),
				...(socket.auth === undefined ? {} : { auth: resolveAuth(socket.auth, fill) }),
			};
		}
		case "tcp":
		case "udp": {
			const socket = any as TemplateOf["tcp"];
			return { ...socket, host: fill(socket.host) };
		}
		case "mcp": {
			const mcp = any as TemplateOf["mcp"];
			return {
				...mcp,
				server: resolveServer(mcp.server, fill, fillRecord),
				...(mcp.auth === undefined ? {} : { auth: resolveAuth(mcp.auth, fill) }),
			};
		}
		case "cli": {
			const cli = any as TemplateOf["cli"];
			return {
				...cli,
				envVars: fillRecord(cli.envVars),
				...(cli.workingDir === undefined ? {} : { workingDir: fill(cli.workingDir) }),
			};
		}
		case "text":
			return any;
		case "file": {
			const file = any as TemplateOf["file"];
			return { path: fill(file.path) };
		}
		}
	})();

	return resolved as TemplateOf[P];
}

function resolveAuth<A extends Auth>(auth: A, fill: (text: string) => string): A {
	switch (auth.type) {
	case "api_key":
		return { ...auth, key: fill(auth.key) };
	case "basic":
		return { ...auth, username: fill(auth.username), password: fill(auth.password) };
	case "oauth2":
		return {
			...auth,
			tokenUrl: fill(auth.tokenUrl),
			clientId: fill(auth.clientId),
			clientSecret: fill(auth.clientSecret),
			...(auth.scope === undefined ? {} : { scope: fill(auth.scope) }),
		};
	}
}

function resolveServer(
	server: McpServer,
	fill: (text: string) => string,
	fillRecord: (record: Readonly<Record<string, string>>) => Record<string, string>
): McpServer {
	if (server.transport === "http") {
		return { ...server, url: fill(server.url), headers: fillRecord(server.headers) };
	}
	return {
		...server,
		command: fill(server.command),
		args: server.args.map(fill),
		env: fillRecord(server.env),
		...(server.cwd === undefined ? {} : { cwd: fill(server.cwd) }),
	};
}
