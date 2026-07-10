# Provider Architecture

Status: accepted for the first public implementation.

## Decision

The provider keeps Codex's native browser contract at the outer boundary and uses Cloudflare Browser
Run behind an authenticated Worker:

```text
browser_observe / browser_step
  -> cloudflare-browser-provider stdio adapter
  -> POST /v1/calls
  -> Durable Object selected by a salted browser identity
  -> @cloudflare/playwright acquire/connect
  -> Cloudflare Browser Run
```

The command adapter reads exactly one `ComputerUseCallParams` JSON object from standard input and
writes exactly one `ComputerUseCallResponse` JSON object to standard output. Successful calls always
carry an inline `inputImage` data URL. The Worker and Durable Object are provider implementation
details; Codex does not gain another browser vocabulary or an MCP lifecycle.

## Why this shape

- A Durable Object provides a single serialization point for one browser identity while allowing
  different threads to run concurrently.
- Cloudflare's `acquire` and `connect` APIs support reconnection. The official Playwright
  documentation states that closing a browser obtained with `connect` disconnects the Worker while
  leaving the Browser Run session alive.
- Durable Object storage holds a hashed session mapping, bounded page recovery state, and call-ID
  replay records. Plain thread and environment identifiers are not used as Durable Object names or
  storage keys.
- A one-shot command adapter remains compatible with Codex's existing external command-provider seam
  and can be upgraded or rolled back independently.
- The public Cloudflare browser MCP servers remain useful products, but wrapping either one would
  add translation and lifecycle layers without improving this contract.

## Isolation and lifecycle

The default identity is the Codex thread ID. Deployments may select environment, call, or shared
isolation explicitly. The Worker derives an HMAC-SHA-256 name from the selected identity and a
deployment secret before addressing a Durable Object.

The Durable Object acquires a Browser Run session with a bounded inactivity timeout, reconnects for
each call, and disconnects after returning the observation. If a stored session has expired or was
evicted, the provider acquires a replacement and restores the last safe HTTP(S) URL and scroll
position. Cookies and other in-memory browser state cannot survive provider-side session eviction;
recovery is reported in the observation text.

Every call ID receives an at-most-once record before browser actions start. Completed responses are
replayed for a bounded window. Older mutating calls retain a tombstone so the provider fails closed
instead of repeating an action whose outcome is uncertain.

## Source harvest

| Source                                                      | Pinned evidence                                       | Decision                                                                                                    |
| ----------------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Cloudflare Browser Run Playwright and session documentation | Pages modified April-May 2026                         | Adopt `acquire`, `connect`, inactivity timeout, and explicit expiry recovery semantics.                     |
| `cloudflare/playwright-mcp`                                 | `ee81e278966626f9ad72d94bdb16f949d06744e5`            | Track action and Worker integration patterns; do not fork or wrap its MCP protocol.                         |
| `cloudflare/mcp-server-cloudflare` Browser Rendering app    | `52c633e37684fadb94ae236f74909b9bbefc0db8`            | Adopt the inline PNG/base64 response pattern concept; do not reuse its URL-only tool schema or OAuth layer. |
| Codex browser command-provider contract                     | `ComputerUseCallParams` and `ComputerUseCallResponse` | Treat as the external compatibility authority, including native `inputImage` content.                       |

Both referenced Cloudflare repositories and `@cloudflare/playwright` are Apache-2.0 licensed. No
source file from either repository is vendored here.

## Explicit non-goals

- Signed-in Chrome profile transport.
- General crawl, PDF, AI extraction, or URL snapshot APIs.
- Site-policy bypass or attempts to disguise Browser Run traffic.
- Persisting typed values, credentials, cookies, headers, or screenshots in logs.
- Changing the names or transcript semantics of Codex native browser tools.

## Primary references

- https://developers.cloudflare.com/browser-run/playwright/
- https://developers.cloudflare.com/browser-run/cdp/session-management/
- https://developers.cloudflare.com/browser-run/features/reuse-sessions/
- https://developers.cloudflare.com/browser-run/reference/browser-close-reasons/
- https://developers.cloudflare.com/browser-run/limits/
- https://github.com/cloudflare/playwright-mcp
- https://github.com/cloudflare/mcp-server-cloudflare/tree/main/apps/browser-rendering
