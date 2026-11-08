import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { makeServer } from "./mcp-server.js";

// The fixture server over stdio, run as a child process by the tests.
await makeServer().connect(new StdioServerTransport());
