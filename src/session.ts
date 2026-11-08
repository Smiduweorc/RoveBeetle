import { globalTransport, TokenSource, type Transport } from "./auth.js";
import type { Protocol, TemplateOf, ToolCall, Variables } from "./call.js";
import { RoveError } from "./errors.js";
import { checkVariables, lookupIn, resolveTemplate } from "./variables.js";

/** What every protocol client is constructed with. */
export interface ClientOptions<TVariables extends string> {
	/**
	 * A value for every variable the tools you call need. Required, even when
	 * empty: `{}` records that this API needs no credentials. The generated
	 * `Variables` type in the package root lists every name the manual uses.
	 */
	readonly variables: Variables<TVariables>;

	/**
	 * Sends requests, token requests included. Defaults to the global `fetch`,
	 * looked up at call time. Protocols that do not speak HTTP use it only for
	 * OAuth2 token requests.
	 */
	readonly transport?: Transport;

	/** Milliseconds since the epoch, for OAuth2 token expiry. Defaults to `Date.now`. */
	readonly now?: () => number;
}

/**
 * The state one client instance owns: its variables and its OAuth2 tokens.
 * Internal: each protocol client holds one and exposes nothing of it.
 */
export class Session {
	readonly transport: Transport;
	readonly tokens: TokenSource;
	readonly #variables: ReadonlyMap<string, string>;

	/**
	 * `limit` bounds token responses too: the client's `maxResponseBytes`,
	 * which the client validates right after constructing this.
	 */
	constructor(options: ClientOptions<string>, limit: number) {
		if (typeof options !== "object" || options === null || typeof options.variables !== "object" || options.variables === null) {
			throw new RoveError("variables is required; pass {} when the tools need none", { code: "variable_missing" });
		}
		this.#variables = checkVariables(options.variables);
		this.transport = options.transport ?? globalTransport;
		this.tokens = new TokenSource({ transport: this.transport, now: options.now ?? Date.now, maxResponseBytes: limit });
	}

	/** The call's template with this client's variables filled in. */
	resolve<P extends Protocol>(call: ToolCall<P, unknown, string>, expected: readonly P[]): TemplateOf[P] {
		if (!expected.includes(call.protocol)) {
			throw new RoveError(
				`tool ${call.tool} uses ${call.protocol}, and this client sends ${expected.join(" and ")}`,
				{ code: "unsupported_value", tool: call.tool }
			);
		}
		return resolveTemplate(call.protocol, call.template, lookupIn(this.#variables, call.tool));
	}
}
