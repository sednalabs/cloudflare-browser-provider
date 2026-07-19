import { describe, expect, it, vi } from "vitest";

import { BrowserAdmissionRuntime, type AdmissionOptions } from "../src/browser/admission.js";
import { MemoryStorage } from "./helpers/fakes.js";

class FakeAdmissionBrowserClient {
  readonly acquire = vi.fn(async () => {
    if (this.now() < this.nextAcquisitionAt) {
      throw new Error("acquisition attempted before allowance");
    }
    const sessionId = `session-${this.activeSessions.length + 1}`;
    this.activeSessions.push({ id: sessionId });
    this.acquisitionTimes.push(this.now());
    this.nextAcquisitionAt = this.now() + 1000;
    return sessionId;
  });
  readonly acquisitionTimes: number[] = [];
  readonly activeSessions: { id: string }[] = [];
  readonly limits = vi.fn(async () => ({
    activeSessions: [...this.activeSessions],
    allowedBrowserAcquisitions: this.now() >= this.nextAcquisitionAt ? 1 : 0,
    maxConcurrentSessions: 120,
    timeUntilNextAllowedBrowserAcquisition: Math.max(0, this.nextAcquisitionAt - this.now()),
  }));
  nextAcquisitionAt = 0;

  constructor(private readonly now: () => number) {}
}

function requestId(index: number): string {
  return index.toString(16).padStart(64, "0");
}

function runtimeOptions(
  now: () => number,
  sleep: (milliseconds: number) => Promise<void>,
  overrides: Partial<AdmissionOptions> = {},
): AdmissionOptions {
  return {
    maxActiveSessions: 16,
    now,
    queueLimit: 32,
    reservationTtlMs: 30_000,
    sleep,
    waitMs: 60_000,
    ...overrides,
  };
}

describe("BrowserAdmissionRuntime", () => {
  it("paces a sixteen-identity cold burst in FIFO order", async () => {
    let now = 0;
    const client = new FakeAdmissionBrowserClient(() => now);
    const runtime = new BrowserAdmissionRuntime(
      new MemoryStorage(),
      client,
      runtimeOptions(
        () => now,
        (milliseconds) => {
          now += milliseconds;
          return Promise.resolve();
        },
      ),
    );

    const sessions = await Promise.all(
      Array.from({ length: 16 }, (_, index) => runtime.acquire(requestId(index + 1), 120_000)),
    );

    expect(sessions).toEqual(Array.from({ length: 16 }, (_, index) => `session-${index + 1}`));
    expect(client.acquisitionTimes).toEqual(Array.from({ length: 16 }, (_, index) => index * 1000));
  });

  it("replays a completed acquisition without launching another browser", async () => {
    let now = 0;
    const client = new FakeAdmissionBrowserClient(() => now);
    const runtime = new BrowserAdmissionRuntime(
      new MemoryStorage(),
      client,
      runtimeOptions(
        () => now,
        (milliseconds) => {
          now += milliseconds;
          return Promise.resolve();
        },
      ),
    );

    const first = await runtime.acquire(requestId(1), 120_000);
    const replay = await runtime.acquire(requestId(1), 120_000);

    expect(replay).toBe(first);
    expect(client.acquire).toHaveBeenCalledOnce();
  });

  it("fails closed when the queue is full", async () => {
    let release: ((value: string) => void) | undefined;
    const client = new FakeAdmissionBrowserClient(() => 0);
    client.acquire.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );
    const runtime = new BrowserAdmissionRuntime(
      new MemoryStorage(),
      client,
      runtimeOptions(
        () => 0,
        () => Promise.resolve(),
        { queueLimit: 1 },
      ),
    );

    const first = runtime.acquire(requestId(1), 120_000);
    await vi.waitFor(() => expect(client.acquire).toHaveBeenCalledOnce());
    await expect(runtime.acquire(requestId(2), 120_000)).rejects.toMatchObject({
      code: "browser_capacity",
    });
    release?.("session-1");
    await expect(first).resolves.toBe("session-1");
  });

  it("waits only within the configured cap and deadline", async () => {
    let now = 0;
    const client = new FakeAdmissionBrowserClient(() => now);
    client.activeSessions.push(
      ...Array.from({ length: 16 }, (_, index) => ({ id: `active-${index + 1}` })),
    );
    const runtime = new BrowserAdmissionRuntime(
      new MemoryStorage(),
      client,
      runtimeOptions(
        () => now,
        (milliseconds) => {
          now += milliseconds;
          return Promise.resolve();
        },
        { waitMs: 2500 },
      ),
    );

    await expect(runtime.acquire(requestId(1), 120_000)).rejects.toMatchObject({
      code: "browser_capacity",
    });
    expect(now).toBe(2500);
    expect(client.acquire).not.toHaveBeenCalled();
  });

  it("tombstones an uncertain acquisition until its reservation expires", async () => {
    let now = 0;
    const storage = new MemoryStorage();
    const client = new FakeAdmissionBrowserClient(() => now);
    client.acquire.mockRejectedValueOnce(new Error("ambiguous upstream outcome"));
    const runtime = new BrowserAdmissionRuntime(
      storage,
      client,
      runtimeOptions(
        () => now,
        (milliseconds) => {
          now += milliseconds;
          return Promise.resolve();
        },
      ),
    );

    await expect(runtime.acquire(requestId(1), 120_000)).rejects.toMatchObject({
      code: "browser_capacity",
      uncertain: true,
    });
    await expect(runtime.acquire(requestId(1), 120_000)).rejects.toMatchObject({
      code: "browser_capacity",
    });
    expect(client.acquire).toHaveBeenCalledOnce();

    now = 30_001;
    await expect(runtime.acquire(requestId(1), 120_000)).resolves.toBe("session-1");
    expect(client.acquire).toHaveBeenCalledTimes(2);
  });

  it("reports only aggregate coordinator state and cleans expired records", async () => {
    let now = 0;
    const storage = new MemoryStorage();
    const client = new FakeAdmissionBrowserClient(() => now);
    const runtime = new BrowserAdmissionRuntime(
      storage,
      client,
      runtimeOptions(
        () => now,
        (milliseconds) => {
          now += milliseconds;
          return Promise.resolve();
        },
      ),
    );

    await runtime.acquire(requestId(1), 120_000);
    expect(await runtime.status()).toEqual({
      completedReplayCount: 1,
      configuredMaxActiveSessions: 16,
      queueDepth: 0,
      reservationCount: 0,
    });

    now = 30_001;
    await runtime.alarm();
    expect(await runtime.status()).toEqual({
      completedReplayCount: 0,
      configuredMaxActiveSessions: 16,
      queueDepth: 0,
      reservationCount: 0,
    });
    expect(storage.values.size).toBe(0);
  });
});
