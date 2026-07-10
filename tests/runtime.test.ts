import { describe, expect, it } from "vitest";

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
});
