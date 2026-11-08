---
title: Protocols
---

# Protocols

Each protocol has a client on its own subpath. Every client takes
`variables`, a value for each `${VAR}` the tools use (`{}` when there are
none), and every client that buffers a response takes `maxResponseBytes`.
Neither has a default.

| Protocol | Subpath | Client | Send with | Also required | Runs in |
| --- | --- | --- | --- | --- | --- |
| `http` | `./http` | `HttpClient` | `call` | | anywhere with `fetch` |
| `sse` | `./sse` | `SseClient` | `stream` | | anywhere with `fetch` |
| `streamable_http` | `./streamable-http` | `StreamableHttpClient` | `stream` | | anywhere with `fetch` |
| `graphql` | `./graphql` | `GraphqlClient` | `call`; `stream` for subscriptions | | `fetch`; `WebSocket` for subscriptions |
| `websocket` | `./websocket` | `WebSocketClient` | `call` or `stream` | | Node, Bun; browsers without header auth |
| `tcp` | `./tcp` | `TcpClient` | `call` | | Node, Bun |
| `udp` | `./udp` | `UdpClient` | `call` | | Node, Bun |
| `mcp` | `./mcp` | `McpClient` | `call`, then `close()` | `environment` | `fetch` for HTTP servers; Node or Bun for stdio |
| `cli` | `./cli` | `CliClient` | `call` | `environment` | Node, Bun, with bash, or PowerShell on Windows |
| `text` | `./text` | `TextClient` | `call` | nothing, not even `variables` | anywhere |
| `file` | `./file` | `FileClient` | `call` | `root` | Node, Bun |

Construct a client once and share it: it holds its OAuth2 tokens, and the MCP
client its sessions. A call to a streaming tool returns an async iterable;
breaking out of the loop closes the connection.

## HTTP, SSE and streamable HTTP

Arguments in `header_fields` become headers, the `body_field` argument the
body, `{name}` placeholders the path, and the rest the query string. The
generator only accepts placeholders in the path. Redirects are followed
within the origin and refused when they leave it; streaming calls follow
none. Plain `http:` is refused except to `localhost`, `127.0.0.0/8` and `::1`.

An SSE call yields each event's data, only events of the template's
`event_type` (`message` when it has none). A streamable HTTP call yields each
NDJSON line, a whole JSON body once, or byte chunks for anything else.

## GraphQL

Queries and mutations are one `POST`; a result with `errors` fails even when
it has partial `data`. Subscriptions use the `graphql-transport-ws` protocol
at the same URL. A query never has variables filled into it: `$id` is
GraphQL's.

## WebSocket, TCP and UDP

Each call opens its own connection. `webSocket` takes a factory for runtimes
whose `WebSocket` needs help. TCP framing (`length_prefix`, `delimiter`,
`fixed_length`, `stream`) follows the template; a `stream` response over
`max_response_size` fails, where the reference cuts it short. A UDP call waits for
exactly the declared number of datagrams from the target, so pass a signal:
a lost datagram is otherwise waited for forever.

## MCP

Stdio and Streamable HTTP servers, protocol revisions 2024-10-07 to
2025-11-25. `environment` is what a stdio server may inherit from, usually
`process.env`; only `PATH`, `HOME` and the other variables in
`DEFAULT_INHERITED` reach it, plus the server's own `env`. Call `close()` to
stop stdio servers and end HTTP sessions.

## CLI

The template's commands run as one bash script, PowerShell on Windows.
Argument values reach the shell as environment variables, never as script
text. A command that exits non-zero fails the call with its status and
output. `environment` works as for MCP, and the template's
`inherit_env_vars` replaces the default list when it is set.

## File

Relative paths resolve against `root`, and a path that leads outside it,
through `..` or a link, is refused. Pass `"/"` to allow every path.
