// The `cli` protocol. Node-only: runs bash or PowerShell with `node:child_process`.

export { CliClient } from "./src/protocols/cli.js";
export { DEFAULT_INHERITED } from "./src/environment.js";
export type { CliClientOptions } from "./src/protocols/cli.js";
