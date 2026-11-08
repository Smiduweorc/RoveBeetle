---
title: Boundaries
---

# Boundaries

RoveBeetle owns:

- Reading or discovering a UTCP 1.x manual and refusing what it cannot
  generate correctly.
- One typed function per tool, for the protocols the config lists.
- Applying each call template's auth, including fetching and caching OAuth2
  client credentials tokens.
- Sending one call over the tool's protocol and reporting what came back.

| Excluded | Why | Where it goes |
| --- | --- | --- |
| OpenAPI documents | A second generator for the same input | [dung beetle](https://github.com/Smiduweorc/dung-beetle-template) |
| Retries, reconnects, refetching a token after a 401 | Which failures are worth repeating is the caller's call | [Firefly](https://github.com/Smiduweorc/firefly), wrapping the call |
| Timeouts | The caller's numbers | `AbortSignal.timeout()` on the call; the manual's value is in the doc comment |
| Caching results | Freshness is the caller's policy | [Repletes](https://github.com/Smiduweorc/Repletes) |
| Running a call once per idempotency key | Not a protocol concern | [Mycocepurus smithii](https://github.com/Smiduweorc/mycocepurus-smithii) |
| Verifying tokens a tool returns | RoveBeetle only fetches its own | [Lacewing](https://github.com/Smiduweorc/lacewing) |
| Validating arguments and results against the schemas | Types only; a validator is a runtime dependency | Your own validator, on the result |
| Reading `process.env` | Breaks in browsers and hides where secrets come from | Your code, passed to the constructor |
| Calling tools by name at run time | Untyped, and runs whatever the manual says today | `@utcp/sdk` |
| MCP sampling, roots and elicitation | This client declares no capabilities and answers such requests with "method not found" | The official MCP SDK |
| The legacy HTTP+SSE MCP transport (protocol 2024-11-05) | Superseded by Streamable HTTP | The server's Streamable HTTP endpoint |
| Logging and metrics | Libraries do not log | A wrapper around the call |

One process: a token cache and an MCP session belong to one client instance.
Twenty replicas hold twenty tokens.
