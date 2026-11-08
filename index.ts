// Public surface. Everything reachable from here is API you have to keep;
// anything else under `src/` is internal and free to change. Each protocol's
// client is on its own subpath (`./http.js` and siblings), so importing this
// file loads no protocol and no `node:` module.
//
// The `.js` extension is required: under `nodenext` resolution the specifier
// must match the emitted file, not the `.ts` source.

export type {
	ApiKeyAuth,
	Auth,
	BasicAuth,
	CallOptions,
	CliCommand,
	CliTemplate,
	DataFormat,
	FileTemplate,
	GraphqlTemplate,
	HttpTemplate,
	McpServer,
	McpTemplate,
	OAuth2Auth,
	Protocol,
	ResultOf,
	SseTemplate,
	StreamableHttpTemplate,
	TcpFraming,
	TcpTemplate,
	TemplateOf,
	TextTemplate,
	ToolCall,
	UdpTemplate,
	Variables,
	WebSocketTemplate,
} from "./src/call.js";
export type { Transport } from "./src/auth.js";
export type { ClientOptions } from "./src/session.js";
export { RoveError } from "./src/errors.js";
export type { RoveErrorCode, RoveErrorInit } from "./src/errors.js";

// Everything between the markers below belongs to the generator. Edits inside
// them are overwritten on the next run; everything above is yours.
// rove-beetle:start generated exports
export {
	getForecast,
} from "./src/tools/http.js";

export type {
	GetForecastArgs,
	GetForecastResult,
} from "./src/tools/http.js";

export {
	watchAlerts,
} from "./src/tools/sse.js";

export type {
	WatchAlertsArgs,
	WatchAlertsResult,
} from "./src/tools/sse.js";

/** Every variable the manual's tools need; a client's `variables` is keyed by these. */
export type VariableName = "CLIENT_ID" | "CLIENT_SECRET" | "WEATHER_API_KEY";
// rove-beetle:end
