import {
  acquire,
  connect,
  limits,
  type Browser,
  type BrowserWorker,
  type LimitsResponse,
} from "@cloudflare/playwright";

export interface BrowserClient {
  acquire(keepAliveMs: number): Promise<string>;
  connect(sessionId: string): Promise<Browser>;
  limits(): Promise<LimitsResponse>;
  terminate(browser: Browser): Promise<void>;
}

export class CloudflareBrowserClient implements BrowserClient {
  constructor(private readonly binding: BrowserWorker) {}

  async acquire(keepAliveMs: number): Promise<string> {
    const result = await acquire(this.binding, { keep_alive: keepAliveMs });
    return result.sessionId;
  }

  connect(sessionId: string): Promise<Browser> {
    return connect(this.binding, sessionId);
  }

  limits(): Promise<LimitsResponse> {
    return limits(this.binding);
  }

  async terminate(browser: Browser): Promise<void> {
    const session = await browser.newBrowserCDPSession();
    try {
      await session.send("Browser.close");
    } finally {
      await session.detach().catch(() => undefined);
    }
  }
}
