import { describe, expect, it, vi } from "vitest";

import type { ComputerUseCall } from "../src/contract/index.js";
import { BrowserSessionRuntime } from "../src/browser/runtime.js";
import { createFakeSurface, FakeBrowserClient, MemoryStorage } from "./helpers/fakes.js";

function call(overrides: Partial<ComputerUseCall> = {}): ComputerUseCall {
  return {
    adapter: "browser",
    arguments: { backend: "browser", scope: "viewport_and_page" },
    callId: "call-1",
    environmentId: null,
    threadId: "thread-1",
    tool: "browser_observe",
    turnId: "turn-1",
    ...overrides,
  };
}

async function callRecordKey(callId: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(callId));
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `call:${hex}`;
}

describe("BrowserSessionRuntime", () => {
  it("acquires, observes, persists, and disconnects a session", async () => {
    const storage = new MemoryStorage();
    const surface = createFakeSurface();
    const client = new FakeBrowserClient(surface);
    const runtime = new BrowserSessionRuntime(storage, client, { keepAliveMs: 120_000 });

    const response = await runtime.handle(call());

    expect(response.success).toBe(true);
    expect(response.contentItems.some((item) => item.type === "inputImage")).toBe(true);
    expect(response.contentItems[0]).toMatchObject({
      text: expect.stringContaining("https://example.com/?[redacted]"),
      type: "inputText",
    });
    expect(client.acquire).toHaveBeenCalledOnce();
    expect(client.connect).toHaveBeenCalledWith("new-session");
    expect(surface.spies.browserClose).toHaveBeenCalledOnce();
    expect(storage.values.get("session:id")).toBe("new-session");
    expect(storage.listCount).toBe(0);
  });

  it("replays a completed mutating call instead of repeating the action", async () => {
    const storage = new MemoryStorage();
    const surface = createFakeSurface();
    const client = new FakeBrowserClient(surface);
    const runtime = new BrowserSessionRuntime(storage, client, { keepAliveMs: 120_000 });
    const step = call({
      arguments: { actions: [{ selector: "button", type: "click" }], backend: "browser" },
      tool: "browser_step",
    });

    const first = await runtime.handle(step);
    const second = await runtime.handle(step);

    expect(second).toEqual(first);
    expect(surface.spies.click).toHaveBeenCalledOnce();
    expect(client.acquire).toHaveBeenCalledOnce();
  });

  it("rejects inflight call IDs without repeating possibly mutating work", async () => {
    const storage = new MemoryStorage();
    await storage.put(await callRecordKey("mutating-inflight"), {
      mutating: true,
      startedAt: 1,
      status: "inflight",
    });
    await storage.put(await callRecordKey("observe-inflight"), {
      mutating: false,
      startedAt: 1,
      status: "inflight",
    });
    const runtime = new BrowserSessionRuntime(storage, new FakeBrowserClient(createFakeSurface()), {
      keepAliveMs: 120_000,
    });

    const mutating = await runtime.handle(
      call({ callId: "mutating-inflight", tool: "browser_step" }),
    );
    const observation = await runtime.handle(call({ callId: "observe-inflight" }));

    expect(JSON.stringify(mutating)).toContain("action will not be repeated");
    expect(JSON.stringify(observation)).toContain("no replayable response");
  });

  it("replaces an expired session and reports bounded recovery", async () => {
    const storage = new MemoryStorage();
    await storage.put("session:id", "expired-session");
    const surface = createFakeSurface({ url: "about:blank" });
    const client = new FakeBrowserClient(surface);
    client.failSession("expired-session");
    const runtime = new BrowserSessionRuntime(storage, client, { keepAliveMs: 120_000 });

    const response = await runtime.handle(call());

    expect(response.success).toBe(true);
    expect(client.connect).toHaveBeenNthCalledWith(1, "expired-session");
    expect(client.connect).toHaveBeenNthCalledWith(2, "new-session");
    expect(response.contentItems[0]).toMatchObject({
      text: expect.stringContaining("replaced an expired or evicted Browser Run session"),
    });
  });

  it("treats blank-page recovery as normal after session replacement", async () => {
    const storage = new MemoryStorage();
    await storage.put("session:id", "expired-session");
    await storage.put("session:page-state", {
      scrollX: 0,
      scrollY: 0,
      touchedAt: Date.now(),
      url: "about:blank",
    });
    const surface = createFakeSurface({ url: "about:blank" });
    const client = new FakeBrowserClient(surface);
    client.failSession("expired-session");
    const runtime = new BrowserSessionRuntime(storage, client, { keepAliveMs: 120_000 });

    const response = await runtime.handle(call({ callId: "blank-recovery" }));

    expect(response.contentItems[0]).toMatchObject({
      text: expect.stringContaining("previously recorded blank page"),
    });
    expect(JSON.stringify(response)).not.toContain("recovery failed");
    expect(surface.spies.goto).not.toHaveBeenCalled();
  });

  it("restores a safe persisted page and reports failed unsafe recovery", async () => {
    const restoredStorage = new MemoryStorage();
    await restoredStorage.put("session:id", "expired-session");
    await restoredStorage.put("session:page-state", {
      scrollX: 4,
      scrollY: 240,
      touchedAt: 1,
      url: "https://example.com/recovered",
    });
    const restoredSurface = createFakeSurface({ url: "about:blank" });
    const restoredClient = new FakeBrowserClient(restoredSurface);
    restoredClient.failSession("expired-session");
    const restoredRuntime = new BrowserSessionRuntime(restoredStorage, restoredClient, {
      keepAliveMs: 120_000,
    });

    const restored = await restoredRuntime.handle(call({ callId: "safe-recovery" }));
    expect(JSON.stringify(restored)).toContain("restored the last safe URL");
    expect(restoredSurface.spies.goto).toHaveBeenCalledWith(
      "https://example.com/recovered",
      expect.objectContaining({ waitUntil: "domcontentloaded" }),
    );
    expect(restoredSurface.state.scrollY).toBe(240);

    const failedStorage = new MemoryStorage();
    await failedStorage.put("session:id", "expired-session");
    await failedStorage.put("session:page-state", {
      scrollX: 0,
      scrollY: 0,
      touchedAt: 1,
      url: "http://127.0.0.1/private",
    });
    const failedSurface = createFakeSurface({ url: "about:blank" });
    const failedClient = new FakeBrowserClient(failedSurface);
    failedClient.failSession("expired-session");
    const failedRuntime = new BrowserSessionRuntime(failedStorage, failedClient, {
      keepAliveMs: 120_000,
    });

    const failed = await failedRuntime.handle(call({ callId: "unsafe-recovery" }));
    expect(JSON.stringify(failed)).toContain("recovery failed");
  });

  it("honors direct navigation, timeout, and requested scroll state", async () => {
    const storage = new MemoryStorage();
    const surface = createFakeSurface({ url: "about:blank" });
    const runtime = new BrowserSessionRuntime(storage, new FakeBrowserClient(surface), {
      keepAliveMs: 120_000,
    });

    await runtime.handle(
      call({
        arguments: {
          backend: "browser",
          timeout_secs: 1,
          url: "https://example.com/start?token=discarded",
          view: { scrollY: 321 },
        },
        callId: "direct-navigation",
      }),
    );

    expect(surface.spies.goto).toHaveBeenCalledWith("https://example.com/start?token=discarded", {
      timeout: 1000,
      waitUntil: "domcontentloaded",
    });
    expect(surface.state.scrollY).toBe(321);
    expect(storage.values.get("session:page-state")).toMatchObject({
      url: "https://example.com/start",
    });
  });

  it("compacts replay records only from the alarm path", async () => {
    const storage = new MemoryStorage();
    const surface = createFakeSurface();
    const runtime = new BrowserSessionRuntime(storage, new FakeBrowserClient(surface), {
      keepAliveMs: 120_000,
    });

    await runtime.handle(call({ callId: "alarm-compaction" }));
    expect(storage.listCount).toBe(0);

    await runtime.alarm();
    expect(storage.listCount).toBe(1);
  });

  it("tombstones replay bodies, removes expired records, and expires idle page state", async () => {
    const now = 8 * 24 * 60 * 60_000;
    const storage = new MemoryStorage();
    await storage.put("session:id", "idle-session");
    await storage.put("session:page-state", {
      scrollX: 0,
      scrollY: 0,
      touchedAt: 0,
      url: "https://example.com/",
    });
    await storage.put("call:tombstone", {
      completedAt: now - 11 * 60_000,
      mutating: true,
      response: {
        contentItems: [{ text: "completed", type: "inputText" }],
        success: false,
      },
      startedAt: now - 12 * 60_000,
      status: "completed",
    });
    await storage.put("call:expired", {
      mutating: false,
      startedAt: 0,
      status: "inflight",
    });
    const runtime = new BrowserSessionRuntime(storage, new FakeBrowserClient(createFakeSurface()), {
      keepAliveMs: 120_000,
      now: () => now,
    });

    await runtime.alarm();

    expect(storage.values.get("call:tombstone")).toMatchObject({
      mutating: true,
      status: "completed",
    });
    expect(storage.values.get("call:tombstone")).not.toHaveProperty("response");
    expect(storage.values.has("call:expired")).toBe(false);
    expect(storage.values.has("session:id")).toBe(false);
    expect(storage.values.has("session:page-state")).toBe(false);
  });

  it("returns a failure screenshot without leaking the upstream error", async () => {
    const storage = new MemoryStorage();
    const surface = createFakeSurface({ actionFailure: true });
    const runtime = new BrowserSessionRuntime(storage, new FakeBrowserClient(surface), {
      keepAliveMs: 120_000,
    });
    const response = await runtime.handle(
      call({
        arguments: { action: "click", selector: "button" },
        tool: "browser_step",
      }),
    );

    expect(response.success).toBe(false);
    expect(response.contentItems.some((item) => item.type === "inputImage")).toBe(true);
    expect(JSON.stringify(response)).not.toContain("sensitive upstream failure");
  });

  it("normalizes validation failures and pre-observation runtime failures", async () => {
    const actionSurface = createFakeSurface();
    const actionRuntime = new BrowserSessionRuntime(
      new MemoryStorage(),
      new FakeBrowserClient(actionSurface),
      { keepAliveMs: 120_000 },
    );
    const invalidAction = await actionRuntime.handle(
      call({
        arguments: { actions: [{ type: "unsupported" }], backend: "browser" },
        callId: "invalid-action",
        tool: "browser_step",
      }),
    );
    expect(JSON.stringify(invalidAction)).toContain("unsupported_action");

    const capacityClient = new FakeBrowserClient(createFakeSurface());
    capacityClient.acquire.mockRejectedValueOnce(new Error("capacity detail"));
    const capacity = await new BrowserSessionRuntime(new MemoryStorage(), capacityClient, {
      keepAliveMs: 120_000,
    }).handle(call({ callId: "capacity" }));
    expect(JSON.stringify(capacity)).toContain("browser_capacity");
    expect(JSON.stringify(capacity)).not.toContain("capacity detail");

    const connectClient = new FakeBrowserClient(createFakeSurface());
    connectClient.connect.mockRejectedValueOnce(new Error("connect detail"));
    const connect = await new BrowserSessionRuntime(new MemoryStorage(), connectClient, {
      keepAliveMs: 120_000,
    }).handle(call({ callId: "connect" }));
    expect(JSON.stringify(connect)).toContain("browser_connect_failed");

    const genericSurface = createFakeSurface();
    vi.mocked(genericSurface.browser.contexts).mockImplementation(() => {
      throw new Error("context detail");
    });
    const generic = await new BrowserSessionRuntime(
      new MemoryStorage(),
      new FakeBrowserClient(genericSurface),
      { keepAliveMs: 120_000 },
    ).handle(call({ callId: "generic" }));
    expect(JSON.stringify(generic)).toContain("provider_failure");
    expect(JSON.stringify(generic)).not.toContain("context detail");
  });

  it("creates a browser context and page when no reusable surface exists", async () => {
    const surface = createFakeSurface();
    vi.mocked(surface.browser.contexts).mockReturnValue([]);
    vi.mocked(surface.context.pages).mockReturnValue([]);
    const runtime = new BrowserSessionRuntime(new MemoryStorage(), new FakeBrowserClient(surface), {
      keepAliveMs: 120_000,
    });

    const response = await runtime.handle(call({ callId: "new-surface" }));

    expect(response.success).toBe(true);
    expect(surface.browser.newContext).toHaveBeenCalledWith({
      viewport: { height: 720, width: 1280 },
    });
    expect(surface.context.newPage).toHaveBeenCalledOnce();
  });

  it("terminates and forgets a session on purge", async () => {
    const storage = new MemoryStorage();
    await storage.put("session:id", "active-session");
    const surface = createFakeSurface();
    const client = new FakeBrowserClient(surface);
    const runtime = new BrowserSessionRuntime(storage, client, { keepAliveMs: 120_000 });

    await runtime.purge();

    expect(client.terminate).toHaveBeenCalledOnce();
    expect(storage.values.has("session:id")).toBe(false);
  });

  it("treats absent or already-evicted purge sessions as complete", async () => {
    const storage = new MemoryStorage();
    const client = new FakeBrowserClient(createFakeSurface());
    const runtime = new BrowserSessionRuntime(storage, client, { keepAliveMs: 120_000 });

    await runtime.purge();
    expect(client.connect).not.toHaveBeenCalled();

    await storage.put("session:id", "evicted-session");
    client.connect.mockRejectedValueOnce(new Error("already gone"));
    await runtime.purge();
    expect(storage.values.has("session:id")).toBe(false);
  });
});
