import { describe, expect, it, vi } from "vitest";

import { MAX_CALL_BYTES, type ComputerUseCall } from "../src/contract/index.js";
import {
  invokeProvider,
  providerHealth,
  providerLimits,
  providerClientConfig,
  purgeProviderSession,
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
    expect(() =>
      providerClientConfig({
        CLOUDFLARE_BROWSER_PROVIDER_TOKEN: "a".repeat(32),
        CLOUDFLARE_BROWSER_PROVIDER_URL: "ftp://provider.example/",
      }),
    ).toThrow("HTTPS");
    expect(() =>
      providerClientConfig({
        CLOUDFLARE_BROWSER_PROVIDER_TOKEN: "a".repeat(32),
        CLOUDFLARE_BROWSER_PROVIDER_URL: "http://provider.example/",
      }),
    ).toThrow("HTTPS");

    const access = providerClientConfig({
      CLOUDFLARE_ACCESS_CLIENT_ID: "client-id",
      CLOUDFLARE_ACCESS_CLIENT_SECRET: "client-secret",
      CLOUDFLARE_BROWSER_PROVIDER_TIMEOUT_SECS: "999",
      CLOUDFLARE_BROWSER_PROVIDER_TOKEN: "a".repeat(32),
      CLOUDFLARE_BROWSER_PROVIDER_URL: "https://provider.example/",
    });
    expect(access).toMatchObject({
      accessClientId: "client-id",
      accessClientSecret: "client-secret",
      timeoutMs: 180_000,
    });
    expect(
      providerClientConfig({
        CLOUDFLARE_BROWSER_PROVIDER_TIMEOUT_SECS: "not-a-number",
        CLOUDFLARE_BROWSER_PROVIDER_TOKEN: "a".repeat(32),
        CLOUDFLARE_BROWSER_PROVIDER_URL: "https://provider.example/",
      }).timeoutMs,
    ).toBe(120_000);
  });

  it("sends the versioned envelope and preserves a native image response", async () => {
    const fetchImplementation = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      if (typeof init?.body !== "string") {
        throw new Error("expected a serialized provider request body");
      }
      expect(JSON.parse(init.body)).toEqual({ protocolVersion: 1, call });
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${config.token}`);
      return Response.json({
        contentItems: [
          { text: "Browser observation", type: "inputText" },
          { detail: "high", imageUrl: "data:image/jpeg;base64,ZmFrZQ==", type: "inputImage" },
        ],
        success: true,
      });
    });

    const response = await invokeProvider(call, config, fetchImplementation);

    expect(response.success).toBe(true);
    expect(fetchImplementation).toHaveBeenCalledOnce();
  });

  it("fails closed on text-only success and redacts HTTP response bodies", async () => {
    const textOnly = vi.fn(async () =>
      Response.json({ contentItems: [{ text: "text only", type: "inputText" }], success: true }),
    );
    expect((await invokeProvider(call, config, textOnly)).success).toBe(false);

    const httpFailure = vi.fn(async () => new Response("secret body", { status: 503 }));
    const response = await invokeProvider(call, config, httpFailure);
    expect(JSON.stringify(response)).toContain("HTTP 503");
    expect(JSON.stringify(response)).not.toContain("secret body");

    const unavailable = vi.fn(async () => {
      throw new Error("network secret");
    });
    const networkResponse = await invokeProvider(call, config, unavailable);
    expect(JSON.stringify(networkResponse)).toContain("provider_unavailable");
    expect(JSON.stringify(networkResponse)).not.toContain("network secret");
  });

  it("rejects oversized calls before invoking the network", async () => {
    const fetchImplementation = vi.fn(async () => Response.json({ success: true }));
    const hugeCall: ComputerUseCall = {
      ...call,
      arguments: { backend: "browser", padding: "x".repeat(MAX_CALL_BYTES) },
      callId: "huge-call",
    };

    const response = await invokeProvider(hugeCall, config, fetchImplementation);

    expect(response.success).toBe(false);
    expect(JSON.stringify(response)).toContain("input_too_large");
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it("covers health, limits, purge, Access headers, and HTTP failures", async () => {
    const requests: Array<{ init?: RequestInit; url: string }> = [];
    const accessConfig: ProviderClientConfig = {
      accessClientId: "client-id",
      accessClientSecret: "client-secret",
      timeoutMs: 1000,
      token: "b".repeat(32),
      url: new URL("https://provider.example/root/?discard=yes#fragment"),
    };
    const fetchImplementation = vi.fn(
      async (url: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
        const requestUrl =
          url instanceof URL ? url.toString() : typeof url === "string" ? url : url.url;
        requests.push({ ...(init === undefined ? {} : { init }), url: requestUrl });
        return Response.json({ ok: true });
      },
    );

    await expect(providerHealth(accessConfig, fetchImplementation)).resolves.toEqual({ ok: true });
    await expect(providerLimits(accessConfig, fetchImplementation)).resolves.toEqual({ ok: true });
    await expect(
      purgeProviderSession(
        { environmentId: "env-1", threadId: "thread-1" },
        accessConfig,
        fetchImplementation,
      ),
    ).resolves.toEqual({ ok: true });

    expect(requests.map((request) => [request.url, request.init?.method])).toEqual([
      ["https://provider.example/root/health", "GET"],
      ["https://provider.example/root/v1/limits", "GET"],
      ["https://provider.example/root/v1/purge", "POST"],
    ]);
    expect(new Headers(requests[1]?.init?.headers).get("CF-Access-Client-Id")).toBe("client-id");
    expect(requests[1]?.init?.body).toBeUndefined();
    const purgeBody = requests[2]?.init?.body;
    if (typeof purgeBody !== "string") {
      throw new Error("expected a serialized purge body");
    }
    expect(JSON.parse(purgeBody)).toEqual({
      environmentId: "env-1",
      threadId: "thread-1",
    });

    const failure = vi.fn(async () => new Response(null, { status: 503 }));
    await expect(providerHealth(accessConfig, failure)).rejects.toThrow("health returned HTTP 503");
    await expect(providerLimits(accessConfig, failure)).rejects.toThrow("provider returned HTTP 503");
  });
});
