import { describe, expect, it, vi } from "vitest";

import type { ComputerUseCall } from "../src/contract/index.js";
import {
  invokeProvider,
  providerClientConfig,
  type ProviderClientConfig,
} from "../src/cli/provider-client.js";

const call: ComputerUseCall = {
  adapter: "browser",
  arguments: { backend: "browser" },
  callId: "call-1",
  environmentId: null,
  threadId: "thread-1",
  tool: "browser_observe",
  turnId: "turn-1",
};

const config: ProviderClientConfig = {
  timeoutMs: 1000,
  token: "a".repeat(32),
  url: new URL("https://provider.example/"),
};

describe("command adapter HTTP client", () => {
  it("requires HTTPS, a long token, and paired Access headers", () => {
    expect(() => providerClientConfig({})).toThrow();
    expect(() =>
      providerClientConfig({
        CLOUDFLARE_BROWSER_PROVIDER_TOKEN: "short",
        CLOUDFLARE_BROWSER_PROVIDER_URL: "https://provider.example/",
      }),
    ).toThrow();
    expect(() =>
      providerClientConfig({
        CLOUDFLARE_ACCESS_CLIENT_ID: "id",
        CLOUDFLARE_BROWSER_PROVIDER_TOKEN: "a".repeat(32),
        CLOUDFLARE_BROWSER_PROVIDER_URL: "https://provider.example/",
      }),
    ).toThrow();
    expect(
      providerClientConfig({
        CLOUDFLARE_BROWSER_PROVIDER_TOKEN: "a".repeat(32),
        CLOUDFLARE_BROWSER_PROVIDER_URL: "http://127.0.0.1:8787/",
      }).url.hostname,
    ).toBe("127.0.0.1");
  });

  it("sends the versioned envelope and preserves a native image response", async () => {
    const fetchImplementation = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({ protocolVersion: 1, call });
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${config.token}`);
      return Response.json({
        contentItems: [
          { text: "Browser observation", type: "inputText" },
          { detail: "high", imageUrl: "data:image/jpeg;base64,ZmFrZQ==", type: "inputImage" },
        ],
        success: true,
      });
    });

    const response = await invokeProvider(call, config, fetchImplementation as typeof fetch);

    expect(response.success).toBe(true);
    expect(fetchImplementation).toHaveBeenCalledOnce();
  });

  it("fails closed on text-only success and redacts HTTP response bodies", async () => {
    const textOnly = vi.fn(async () =>
      Response.json({ contentItems: [{ text: "text only", type: "inputText" }], success: true }),
    );
    expect((await invokeProvider(call, config, textOnly as typeof fetch)).success).toBe(false);

    const httpFailure = vi.fn(async () => new Response("secret body", { status: 503 }));
    const response = await invokeProvider(call, config, httpFailure as typeof fetch);
    expect(JSON.stringify(response)).toContain("HTTP 503");
    expect(JSON.stringify(response)).not.toContain("secret body");
  });
});
