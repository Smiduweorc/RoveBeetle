// The `mcp` protocol. HTTP servers need only `fetch`; stdio servers need Node
// (`node:child_process`, loaded when one is first used).

export { McpClient } from "./src/protocols/mcp.js";
export type { McpClientOptions } from "./src/protocols/mcp.js";
export { PROTOCOL_VERSIONS } from "./src/mcp.js";
