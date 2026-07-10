# Native Browser Provider Protocol

## Standard input

The default `stdio` command reads one UTF-8 JSON object with camel-case fields:

```json
{
  "threadId": "thread-id",
  "turnId": "turn-id",
  "callId": "call-id",
  "environmentId": null,
  "adapter": "browser",
  "tool": "browser_observe",
  "arguments": {
    "backend": "browser",
    "scope": "viewport_and_page"
  }
}
```

Input is rejected before network access when it is malformed, exceeds the size limit, names a
different adapter or tool, or contains an unsupported backend.

## Standard output

The adapter writes one JSON object and no other standard-output text:

```json
{
  "contentItems": [
    {
      "type": "inputText",
      "text": "Browser observation\nurl: https://example.com/"
    },
    {
      "type": "inputImage",
      "imageUrl": "data:image/jpeg;base64,...",
      "detail": "high"
    }
  ],
  "success": true
}
```

Successful visual calls require an inline image. Artifact paths and text-only summaries are invalid.
Provider errors remain parseable responses with `success: false`, a compact public-safe diagnostic,
and an optional failure screenshot when capture was still possible.

## HTTP envelope

The CLI sends the validated call to `POST /v1/calls` in this envelope:

```json
{
  "protocolVersion": 1,
  "call": {}
}
```

The Worker requires bearer authentication. A deployment may additionally use a Cloudflare Access
service token; the CLI reads those header values from environment variables and never includes them
in diagnostics.
