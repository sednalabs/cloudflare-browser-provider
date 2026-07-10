import { Buffer } from "node:buffer";

import type { Browser, BrowserContext, CDPSession, Locator, Page } from "@cloudflare/playwright";
import { vi, type Mock } from "vitest";

import type { BrowserClient } from "../../src/browser/client.js";
import type { RuntimeStorage } from "../../src/browser/runtime.js";

export interface FakeSurface {
  browser: Browser;
  context: BrowserContext;
  locator: Locator;
  page: Page;
  spies: {
    acquire: Mock;
    browserClose: Mock;
    click: Mock;
    connect: Mock;
    fill: Mock;
    goto: Mock;
    screenshot: Mock;
    terminate: Mock;
    type: Mock;
  };
  state: {
    scrollX: number;
    scrollY: number;
    url: string;
  };
}

export function createFakeSurface(
  options: { actionFailure?: boolean; url?: string } = {},
): FakeSurface {
  const state = { scrollX: 0, scrollY: 0, url: options.url ?? "https://example.com/?token=hidden" };
  const click = options.actionFailure
    ? vi.fn().mockRejectedValue(new Error("sensitive upstream failure"))
    : vi.fn().mockResolvedValue(undefined);
  const fill = vi.fn().mockResolvedValue(undefined);
  const locator = {
    click,
    fill,
    first: vi.fn(function first() {
      return locator;
    }),
    focus: vi.fn().mockResolvedValue(undefined),
    hover: vi.fn().mockResolvedValue(undefined),
    selectOption: vi.fn().mockResolvedValue([]),
  } as unknown as Locator;
  const goto = vi.fn(async (url: string) => {
    state.url = url;
    return null;
  });
  const screenshot = vi.fn().mockResolvedValue(Buffer.from("fake-jpeg"));
  const keyboardType = vi.fn().mockResolvedValue(undefined);
  const page = {
    evaluate: vi.fn(
      async (operation: (...argumentsValue: unknown[]) => unknown, value?: unknown) => {
        const source = operation.toString();
        if (source.includes("querySelectorAll")) {
          return [];
        }
        if (source.includes("scrollTo")) {
          if (typeof value === "number") {
            state.scrollY = value;
          } else if (typeof value === "object" && value !== null) {
            const coordinates = value as { x?: number; y?: number };
            state.scrollX = coordinates.x ?? state.scrollX;
            state.scrollY = coordinates.y ?? state.scrollY;
          }
          return undefined;
        }
        return {
          documentHeight: 1800,
          documentWidth: 1280,
          scrollX: state.scrollX,
          scrollY: state.scrollY,
        };
      },
    ),
    getByAltText: vi.fn(() => locator),
    getByLabel: vi.fn(() => locator),
    getByPlaceholder: vi.fn(() => locator),
    getByRole: vi.fn(() => locator),
    getByTestId: vi.fn(() => locator),
    getByText: vi.fn(() => locator),
    getByTitle: vi.fn(() => locator),
    goto,
    isClosed: vi.fn(() => false),
    keyboard: {
      down: vi.fn().mockResolvedValue(undefined),
      press: vi.fn().mockResolvedValue(undefined),
      type: keyboardType,
      up: vi.fn().mockResolvedValue(undefined),
    },
    locator: vi.fn(() => locator),
    mouse: {
      click: vi.fn().mockResolvedValue(undefined),
      down: vi.fn().mockResolvedValue(undefined),
      move: vi.fn().mockResolvedValue(undefined),
      up: vi.fn().mockResolvedValue(undefined),
      wheel: vi.fn().mockResolvedValue(undefined),
    },
    screenshot,
    title: vi.fn().mockResolvedValue("Example Domain"),
    url: vi.fn(() => state.url),
    viewportSize: vi.fn(() => ({ height: 720, width: 1280 })),
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
  } as unknown as Page;
  const context = {
    newPage: vi.fn().mockResolvedValue(page),
    pages: vi.fn(() => [page]),
  } as unknown as BrowserContext;
  const browserClose = vi.fn().mockResolvedValue(undefined);
  const cdpSession = {
    detach: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue({}),
  } as unknown as CDPSession;
  const browser = {
    close: browserClose,
    contexts: vi.fn(() => [context]),
    newBrowserCDPSession: vi.fn().mockResolvedValue(cdpSession),
    newContext: vi.fn().mockResolvedValue(context),
  } as unknown as Browser;
  const acquire = vi.fn().mockResolvedValue("new-session");
  const connect = vi.fn().mockResolvedValue(browser);
  const terminate = vi.fn().mockResolvedValue(undefined);
  return {
    browser,
    context,
    locator,
    page,
    spies: {
      acquire,
      browserClose,
      click,
      connect,
      fill,
      goto,
      screenshot,
      terminate,
      type: keyboardType,
    },
    state,
  };
}

export class FakeBrowserClient implements BrowserClient {
  readonly acquire: Mock;
  readonly connect: Mock;
  readonly terminate: Mock;
  private readonly failedSessionIds = new Set<string>();

  constructor(private readonly surface: FakeSurface) {
    this.acquire = surface.spies.acquire;
    this.connect = vi.fn(async (sessionId: string) => {
      if (this.failedSessionIds.has(sessionId)) {
        this.failedSessionIds.delete(sessionId);
        throw new Error("expired session");
      }
      return surface.browser;
    });
    this.terminate = surface.spies.terminate;
  }

  failSession(sessionId: string): void {
    this.failedSessionIds.add(sessionId);
  }

  limits(): Promise<{
    activeSessions: { id: string }[];
    allowedBrowserAcquisitions: number;
    maxConcurrentSessions: number;
    timeUntilNextAllowedBrowserAcquisition: number;
  }> {
    return Promise.resolve({
      activeSessions: [],
      allowedBrowserAcquisitions: 1,
      maxConcurrentSessions: 10,
      timeUntilNextAllowedBrowserAcquisition: 0,
    });
  }
}

export class MemoryStorage implements RuntimeStorage {
  readonly values = new Map<string, unknown>();
  alarmTime: number | Date | undefined;
  listCount = 0;

  delete(keys: string | string[]): Promise<boolean | number> {
    if (typeof keys === "string") {
      return Promise.resolve(this.values.delete(keys));
    }
    let deleted = 0;
    for (const key of keys) {
      if (this.values.delete(key)) {
        deleted += 1;
      }
    }
    return Promise.resolve(deleted);
  }

  get<T>(key: string): Promise<T | undefined> {
    return Promise.resolve(this.values.get(key) as T | undefined);
  }

  list<T>(options?: { prefix?: string }): Promise<Map<string, T>> {
    this.listCount += 1;
    const entries = [...this.values.entries()].filter(([key]) =>
      options?.prefix === undefined ? true : key.startsWith(options.prefix),
    );
    return Promise.resolve(new Map(entries) as Map<string, T>);
  }

  put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, structuredClone(value));
    return Promise.resolve();
  }

  setAlarm(scheduledTime: number | Date): Promise<void> {
    this.alarmTime = scheduledTime;
    return Promise.resolve();
  }
}
