# Cloudflare Browser Provider

`cloudflare-browser-provider` is an external browser provider that preserves the Codex native
`browser_observe` and `browser_step` contract while executing isolated browser sessions on
Cloudflare Browser Run.

The project is under active development. The first supported architecture uses a one-shot
JSON-over-stdio command adapter, an authenticated Cloudflare Worker, and a Durable Object per
browser identity. Credentials are supplied only at runtime and must never be committed.

See [SECURITY.md](SECURITY.md) for private vulnerability reporting.

## License

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE).
