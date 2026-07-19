# Deployment and Installation

## Worker

1. Create a dedicated Cloudflare API token for deployment with only the account and Worker
   permissions required by Wrangler.
2. Review `wrangler.jsonc`, choose an isolation mode and inactivity timeout, and deploy from a
   trusted environment with `npm run deploy`.
3. Add `PROVIDER_AUTH_TOKEN` and `SESSION_KEY_SALT` with `wrangler secret put`. Do not place either
   value in `wrangler.jsonc`, shell history, logs, examples, or repository settings that are visible
   to untrusted workflows.
4. Put the Worker behind Cloudflare Access when the deployment policy requires service-token
   enforcement.

The Worker exposes an unauthenticated metadata-only `/health` endpoint and requires authentication
for calls, purges, and provider limits.

The initial admission-control settings are:

```text
BROWSER_MAX_ACTIVE_SESSIONS=16
BROWSER_ADMISSION_QUEUE_LIMIT=32
BROWSER_ADMISSION_WAIT_MS=60000
BROWSER_RESERVATION_TTL_MS=30000
BROWSER_KEEP_ALIVE_MS=120000
```

The maximum active-session setting is an operator cost and capacity guard, not Cloudflare's account
limit. Raise it only after reviewing current Browser Run limits, expected concurrency charges, and a
controlled burst test. Admission serializes browser creation only; live sessions continue to run in
parallel.

## Codex command provider

Install a release archive in an operator-controlled directory and set:

```text
CLOUDFLARE_BROWSER_PROVIDER_URL
CLOUDFLARE_BROWSER_PROVIDER_TOKEN
```

Optional Cloudflare Access headers use:

```text
CLOUDFLARE_ACCESS_CLIENT_ID
CLOUDFLARE_ACCESS_CLIENT_SECRET
```

Then configure the command provider for the hosted backends:

```json
{
  "providers": [
    {
      "id": "cloudflare-browser",
      "provider": "command",
      "backends": ["auto", "browser"],
      "command": ["cloudflare-browser-provider", "stdio"]
    },
    {
      "id": "local-chromium",
      "provider": "playwright",
      "backends": ["chrome", "chromium"]
    }
  ],
  "routing": {
    "fallback_order": ["cloudflare-browser", "local-chromium"]
  }
}
```

Keep an earlier provider configuration as the rollback file. Installing this package does not
require terminating active Codex processes; new sessions pick up the configuration normally.

`routing.fallback_order` controls provider selection. It does not replay a failed action through a
second provider. Use an explicit `chrome` or `chromium` backend, or restore the rollback file, when
the hosted provider is unavailable.
