import type { Browser, BrowserContext, Page } from "@cloudflare/playwright";

import {
  MAX_RESPONSE_BYTES,
  compactText,
  type ComputerUseCall,
  type ComputerUseResponse,
  encodedJsonBytes,
  failureResponse,
} from "../contract/index.js";
import { canonicalActions, displayUrl, ProviderActionError, publicNavigationUrl, runAction } from "./actions.js";
import type { BrowserClient } from "./client.js";
import { observeFailure, observeSuccess, pageState } from "./observe.js";

const SESSION_KEY = "session:id";
const PAGE_STATE_KEY = "session:page-state";
const CALL_PREFIX = "call:";
const MAX_CALL_RECORDS = 512;
const REPLAY_WINDOW_MS = 10 * 60_000;
const TOMBSTONE_WINDOW_MS = 7 * 24 * 60 * 60_000;

export interface RuntimeStorage {
  delete(keys: string | string[]): Promise<boolean | number>;
  get<T>(key: string): Promise<T | undefined>;
  list<T>(options?: { prefix?: string }): Promise<Map<string, T>>;
  put<T>(key: string, value: T): Promise<void>;
  setAlarm(scheduledTime: number | Date): Promise<void>;
}

interface PersistedPageState {
  scrollX: number;
  scrollY: number;
  touchedAt: number;
  url: string;
}

interface CallRecord {
  completedAt?: number;
  mutating: boolean;
  response?: ComputerUseResponse;
  startedAt: number;
  status: "inflight" | "completed";
}

interface BrowserConnection {
  browser: Browser;
  lifecycleNotes: string[];
  replacement: boolean;
}

export interface RuntimeOptions {
  keepAliveMs: number;
  now?: () => number;
}

export class BrowserSessionRuntime {
  private readonly now: () => number;

  constructor(
    private readonly storage: RuntimeStorage,
    private readonly client: BrowserClient,
    private readonly options: RuntimeOptions,
  ) {
    this.now = options.now ?? Date.now;
  }

  async handle(call: ComputerUseCall): Promise<ComputerUseResponse> {
    const recordKey = `${CALL_PREFIX}${await sha256Hex(call.callId)}`;
    const existing = await this.storage.get<CallRecord>(recordKey);
    if (existing !== undefined) {
      return replayOrReject(existing);
    }

    const mutating = call.tool === "browser_step";
    const record: CallRecord = { mutating, startedAt: this.now(), status: "inflight" };
    await this.storage.put(recordKey, record);

    let response: ComputerUseResponse;
    try {
      response = await this.execute(call);
    } catch (error) {
      response = providerFailure(error);
    }

    if (encodedJsonBytes(response) > MAX_RESPONSE_BYTES) {
      response = failureResponse("response_too_large", "Provider response exceeded the protocol limit.");
    }

    await this.storage.put<CallRecord>(recordKey, {
      ...record,
      completedAt: this.now(),
      response,
      status: "completed",
    });
    await this.scheduleCleanup();
    await this.compactRecords();
    return response;
  }

  async purge(): Promise<void> {
    const sessionId = await this.storage.get<string>(SESSION_KEY);
    if (sessionId !== undefined) {
      try {
        const browser = await this.client.connect(sessionId);
        try {
          await this.client.terminate(browser);
        } finally {
          await browser.close().catch(() => undefined);
        }
      } catch {
        // An expired or evicted session is already effectively purged.
      }
    }
    await this.storage.delete([SESSION_KEY, PAGE_STATE_KEY]);
  }

  async alarm(): Promise<void> {
    await this.compactRecords(true);
    const page = await this.storage.get<PersistedPageState>(PAGE_STATE_KEY);
    if (page !== undefined && this.now() - page.touchedAt > this.options.keepAliveMs * 2) {
      await this.storage.delete([SESSION_KEY, PAGE_STATE_KEY]);
    }
  }

  private async execute(call: ComputerUseCall): Promise<ComputerUseResponse> {
    const connection = await this.openBrowser();
    const { browser, lifecycleNotes, replacement } = connection;
    try {
      const context = await activeContext(browser);
      const page = await activePage(context);
      await this.restoreOrNavigate(page, call, replacement, lifecycleNotes);

      const actionSummaries: string[] = [];
      if (call.tool === "browser_step") {
        for (const action of canonicalActions(call.arguments)) {
          try {
            actionSummaries.push(await runAction(page, action));
          } catch (error) {
            await settle(page);
            await this.persistPageState(page);
            const providerError = normalizeActionError(error);
            return observeFailure(
              page,
              providerError.code,
              providerError.message,
              actionSummaries,
              lifecycleNotes,
            );
          }
        }
      }

      await settle(page);
      await this.persistPageState(page);
      return observeSuccess(page, actionSummaries, lifecycleNotes);
    } finally {
      await browser.close().catch(() => undefined);
    }
  }

  private async openBrowser(): Promise<BrowserConnection> {
    const existingSession = await this.storage.get<string>(SESSION_KEY);
    if (existingSession !== undefined) {
      try {
        return {
          browser: await this.client.connect(existingSession),
          lifecycleNotes: ["reconnected to the existing isolated Browser Run session"],
          replacement: false,
        };
      } catch {
        await this.storage.delete(SESSION_KEY);
      }
    }

    let sessionId: string;
    try {
      sessionId = await this.client.acquire(this.options.keepAliveMs);
    } catch {
      throw new RuntimeError("browser_capacity", "Browser Run could not acquire a session. Retry later.");
    }
    await this.storage.put(SESSION_KEY, sessionId);
    try {
      return {
        browser: await this.client.connect(sessionId),
        lifecycleNotes: [
          existingSession === undefined
            ? "acquired a new isolated Browser Run session"
            : "replaced an expired or evicted Browser Run session",
        ],
        replacement: existingSession !== undefined,
      };
    } catch {
      await this.storage.delete(SESSION_KEY);
      throw new RuntimeError("browser_connect_failed", "Browser Run session connection failed.");
    }
  }

  private async restoreOrNavigate(
    page: Page,
    call: ComputerUseCall,
    replacement: boolean,
    lifecycleNotes: string[],
  ): Promise<void> {
    if (typeof call.arguments.url === "string") {
      const url = publicNavigationUrl(call.arguments.url);
      await page.goto(url.toString(), { timeout: requestTimeoutMs(call), waitUntil: "domcontentloaded" });
      await restoreRequestedScroll(page, call.arguments);
      return;
    }

    const persisted = await this.storage.get<PersistedPageState>(PAGE_STATE_KEY);
    if (replacement && persisted !== undefined && page.url() === "about:blank") {
      try {
        const url = publicNavigationUrl(persisted.url);
        await page.goto(url.toString(), { timeout: requestTimeoutMs(call), waitUntil: "domcontentloaded" });
        await page.evaluate(
          ({ x, y }) => window.scrollTo(x, y),
          { x: persisted.scrollX, y: persisted.scrollY },
        );
        lifecycleNotes.push("restored the last safe URL and scroll position; volatile session state was lost");
      } catch {
        lifecycleNotes.push("the replacement session started on a blank page because recovery failed");
      }
    }
    await restoreRequestedScroll(page, call.arguments);
  }

  private async persistPageState(page: Page): Promise<void> {
    const state = await pageState(page);
    let recoveryUrl = "about:blank";
    try {
      const parsed = publicNavigationUrl(state.url);
      parsed.search = "";
      parsed.hash = "";
      recoveryUrl = parsed.toString();
    } catch {
      // Persist only safe HTTP(S) recovery URLs.
    }
    await this.storage.put<PersistedPageState>(PAGE_STATE_KEY, {
      scrollX: state.scrollX,
      scrollY: state.scrollY,
      touchedAt: this.now(),
      url: recoveryUrl,
    });
  }

  private async scheduleCleanup(): Promise<void> {
    await this.storage.setAlarm(this.now() + Math.max(this.options.keepAliveMs * 2, REPLAY_WINDOW_MS));
  }

  private async compactRecords(force = false): Promise<void> {
    const records = await this.storage.list<CallRecord>({ prefix: CALL_PREFIX });
    const now = this.now();
    const ordered = [...records.entries()].sort((left, right) => left[1].startedAt - right[1].startedAt);
    const updates: Array<Promise<void>> = [];
    const removals: string[] = [];

    for (const [key, record] of ordered) {
      const age = now - (record.completedAt ?? record.startedAt);
      if (record.status === "completed" && record.response !== undefined && age > REPLAY_WINDOW_MS) {
        updates.push(this.storage.put<CallRecord>(key, { ...record, response: undefined }));
      }
      if (age > TOMBSTONE_WINDOW_MS) {
        removals.push(key);
      }
    }

    const excess = Math.max(0, ordered.length - MAX_CALL_RECORDS);
    removals.push(...ordered.slice(0, excess).map(([key]) => key));
    if (force || updates.length > 0) {
      await Promise.all(updates);
    }
    if (removals.length > 0) {
      await this.storage.delete([...new Set(removals)]);
    }
  }
}

class RuntimeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RuntimeError";
  }
}

function replayOrReject(record: CallRecord): ComputerUseResponse {
  if (record.status === "completed" && record.response !== undefined) {
    return record.response;
  }
  const message = record.mutating
    ? "This mutating call ID has already started. The action will not be repeated."
    : "This call ID has already started and no replayable response is available.";
  return failureResponse("duplicate_call", message);
}

function providerFailure(error: unknown): ComputerUseResponse {
  if (error instanceof RuntimeError || error instanceof ProviderActionError) {
    return failureResponse(error.code, error.message);
  }
  return failureResponse("provider_failure", "The browser provider failed before an observation was available.");
}

function normalizeActionError(error: unknown): { code: string; message: string } {
  if (error instanceof ProviderActionError) {
    return { code: error.code, message: error.message };
  }
  return {
    code: "action_failed",
    message: "The browser action failed. Current page state is attached when capture succeeded.",
  };
}

async function activeContext(browser: Browser): Promise<BrowserContext> {
  return browser.contexts()[0] ?? browser.newContext({ viewport: { height: 720, width: 1280 } });
}

async function activePage(context: BrowserContext): Promise<Page> {
  return context.pages().find((page) => !page.isClosed()) ?? context.newPage();
}

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => undefined);
  await page.waitForTimeout(100);
}

async function restoreRequestedScroll(page: Page, argumentsValue: Record<string, unknown>): Promise<void> {
  const view = recordField(argumentsValue.view);
  const scrollY = numberOrUndefined(view?.scrollY ?? argumentsValue.scrollY);
  if (scrollY !== undefined) {
    await page.evaluate((value) => window.scrollTo(window.scrollX, value), scrollY);
  }
}

function requestTimeoutMs(call: ComputerUseCall): number {
  const seconds = numberOrUndefined(call.arguments.timeout_secs);
  return Math.min(30_000, Math.max(100, Math.trunc((seconds ?? 15) * 1000)));
}

function recordField(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
