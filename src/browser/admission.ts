import type { BrowserClient } from "./client.js";

const RECORD_PREFIX = "admission:";

export interface AdmissionStorage {
  delete(keys: string | string[]): Promise<boolean | number>;
  get<T>(key: string): Promise<T | undefined>;
  list<T>(options?: { prefix?: string }): Promise<Map<string, T>>;
  put<T>(key: string, value: T): Promise<void>;
  setAlarm(scheduledTime: number | Date): Promise<void>;
}

export interface BrowserAcquirer {
  acquire(requestId: string, keepAliveMs: number): Promise<string>;
}

export interface AdmissionOptions {
  maxActiveSessions: number;
  queueLimit: number;
  reservationTtlMs: number;
  waitMs: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export interface AdmissionStatus {
  configuredMaxActiveSessions: number;
  completedReplayCount: number;
  queueDepth: number;
  reservationCount: number;
}

interface AdmissionRecord {
  createdAt: number;
  expiresAt: number;
  sessionId?: string;
  status: "completed" | "inflight" | "uncertain";
}

export class AdmissionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly uncertain = false,
  ) {
    super(message);
    this.name = "AdmissionError";
  }
}

export class BrowserAdmissionRuntime implements BrowserAcquirer {
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private pendingCount = 0;
  private nextAlarmAt: number | undefined;
  private serial: Promise<void> = Promise.resolve();

  constructor(
    private readonly storage: AdmissionStorage,
    private readonly client: Pick<BrowserClient, "acquire" | "limits">,
    private readonly options: AdmissionOptions,
  ) {
    this.now = options.now ?? Date.now;
    this.sleep =
      options.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  acquire(requestId: string, keepAliveMs: number): Promise<string> {
    if (this.pendingCount >= this.options.queueLimit) {
      return Promise.reject(
        new AdmissionError(
          "browser_capacity",
          "Browser acquisition queue is full. Retry later.",
        ),
      );
    }

    this.pendingCount += 1;
    const deadline = this.now() + this.options.waitMs;
    const result = this.serial.then(
      () => this.acquireExclusive(requestId, keepAliveMs, deadline),
      () => this.acquireExclusive(requestId, keepAliveMs, deadline),
    );
    this.serial = result.then(
      () => undefined,
      () => undefined,
    );
    return result.finally(() => {
      this.pendingCount -= 1;
    });
  }

  async status(): Promise<AdmissionStatus> {
    const now = this.now();
    const records = await this.storage.list<AdmissionRecord>({ prefix: RECORD_PREFIX });
    let completedReplayCount = 0;
    let reservationCount = 0;
    for (const record of records.values()) {
      if (record.expiresAt <= now) {
        continue;
      }
      if (record.status === "completed") {
        completedReplayCount += 1;
      } else {
        reservationCount += 1;
      }
    }
    return {
      configuredMaxActiveSessions: this.options.maxActiveSessions,
      completedReplayCount,
      queueDepth: this.pendingCount,
      reservationCount,
    };
  }

  async alarm(): Promise<void> {
    this.nextAlarmAt = undefined;
    const now = this.now();
    const records = await this.storage.list<AdmissionRecord>({ prefix: RECORD_PREFIX });
    const expired: string[] = [];
    let nextExpiry: number | undefined;
    for (const [key, record] of records) {
      if (record.expiresAt <= now) {
        expired.push(key);
      } else if (nextExpiry === undefined || record.expiresAt < nextExpiry) {
        nextExpiry = record.expiresAt;
      }
    }
    if (expired.length > 0) {
      await this.storage.delete(expired);
    }
    if (nextExpiry !== undefined) {
      await this.scheduleCleanup(nextExpiry);
    }
  }

  private async acquireExclusive(
    requestId: string,
    keepAliveMs: number,
    deadline: number,
  ): Promise<string> {
    const recordKey = `${RECORD_PREFIX}${requestId}`;
    const existing = await this.storage.get<AdmissionRecord>(recordKey);
    if (existing !== undefined && existing.expiresAt > this.now()) {
      if (existing.status === "completed" && existing.sessionId !== undefined) {
        return existing.sessionId;
      }
      throw new AdmissionError(
        "browser_capacity",
        existing.status === "uncertain"
          ? "An earlier browser acquisition outcome is uncertain. Retry after the reservation expires."
          : "This browser acquisition is already in progress. Retry later.",
      );
    }
    if (existing !== undefined) {
      await this.storage.delete(recordKey);
    }
    if (this.now() >= deadline) {
      throw new AdmissionError(
        "browser_capacity",
        "Browser acquisition wait limit was reached. Retry later.",
      );
    }

    const record: AdmissionRecord = {
      createdAt: this.now(),
      expiresAt: Math.max(
        this.now() + this.options.reservationTtlMs,
        deadline + 5000,
      ),
      status: "inflight",
    };
    await this.storage.put(recordKey, record);
    await this.scheduleCleanup(record.expiresAt);

    try {
      const sessionId = await this.acquireWhenAllowed(keepAliveMs, deadline);
      const completed: AdmissionRecord = {
        ...record,
        expiresAt: this.now() + this.options.reservationTtlMs,
        sessionId,
        status: "completed",
      };
      await this.storage.put(recordKey, completed);
      await this.scheduleCleanup(completed.expiresAt);
      return sessionId;
    } catch (error) {
      if (error instanceof AdmissionError && error.uncertain) {
        await this.storage.put<AdmissionRecord>(recordKey, {
          ...record,
          expiresAt: this.now() + this.options.reservationTtlMs,
          status: "uncertain",
        });
      } else {
        await this.storage.delete(recordKey);
      }
      throw error;
    }
  }

  private async acquireWhenAllowed(keepAliveMs: number, deadline: number): Promise<string> {
    while (this.now() < deadline) {
      let limits: Awaited<ReturnType<BrowserClient["limits"]>>;
      try {
        limits = await this.client.limits();
      } catch {
        throw new AdmissionError(
          "browser_limits_unavailable",
          "Browser Run limits are unavailable. Retry later.",
        );
      }

      const configuredLimit = Math.min(
        this.options.maxActiveSessions,
        Math.max(0, limits.maxConcurrentSessions),
      );
      if (
        limits.activeSessions.length < configuredLimit &&
        limits.allowedBrowserAcquisitions > 0
      ) {
        try {
          return await this.client.acquire(keepAliveMs);
        } catch {
          throw new AdmissionError(
            "browser_capacity",
            "Browser Run acquisition did not complete cleanly. Retry after the reservation expires.",
            true,
          );
        }
      }

      const remaining = deadline - this.now();
      if (remaining <= 0) {
        break;
      }
      const reportedDelay =
        limits.allowedBrowserAcquisitions > 0
          ? 1000
          : limits.timeUntilNextAllowedBrowserAcquisition;
      await this.sleep(Math.min(remaining, Math.max(50, reportedDelay || 1000)));
    }

    throw new AdmissionError(
      "browser_capacity",
      "Browser Run capacity did not become available within the configured wait.",
    );
  }

  private async scheduleCleanup(expiresAt: number): Promise<void> {
    if (this.nextAlarmAt !== undefined && this.nextAlarmAt <= expiresAt) {
      return;
    }
    this.nextAlarmAt = expiresAt;
    await this.storage.setAlarm(expiresAt);
  }
}
