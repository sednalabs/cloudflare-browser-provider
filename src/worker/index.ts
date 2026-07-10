import type { BrowserWorker } from "@cloudflare/playwright";

import { BrowserSessionRuntime } from "../browser/runtime.js";
import { CloudflareBrowserClient } from "../browser/client.js";
import {
  MAX_CALL_BYTES,
  failureResponse,
  parseComputerUseCall,
  providerEnvelopeSchema,
  purgeRequestSchema,
  type ComputerUseCall,
} from "../contract/index.js";
import { PROVIDER_NAME, PROVIDER_PROTOCOL_VERSION, PROVIDER_VERSION } from "../version.js";

type IsolationMode = "call" | "environment" | "shared" | "thread";

interface Env {
  BROWSER: BrowserWorker;
  BROWSER_ISOLATION?: string;
  BROWSER_KEEP_ALIVE_MS?: string;
  BROWSER_SESSIONS: DurableObjectNamespace;
  PROVIDER_AUTH_TOKEN?: string;
  PROVIDER_PROTOCOL_VERSION?: string;
  SESSION_KEY_SALT?: string;
}

const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return jsonResponse({
        name: PROVIDER_NAME,
        protocolVersion: PROVIDER_PROTOCOL_VERSION,
        status: "ok",
        version: PROVIDER_VERSION,
      });
    }

    const auth = await authorizeRequest(request, env);
    if (auth !== undefined) {
      return auth;
    }

    if (request.method === "POST" && url.pathname === "/v1/calls") {
      try {
        const envelope = providerEnvelopeSchema.parse(await readJson(request));
        const objectName = await sessionObjectName(envelope.call, env);
        return forwardToSession(env, objectName, "/call", envelope.call);
      } catch {
        return jsonResponse(
          failureResponse("invalid_request", "Provider request validation failed."),
          400,
        );
      }
    }

    if (request.method === "POST" && url.pathname === "/v1/purge") {
      try {
        const identity = purgeRequestSchema.parse(await readJson(request));
        const objectName = await sessionObjectName(identityCall(identity), env);
        return forwardToSession(env, objectName, "/purge", {});
      } catch {
        return jsonResponse({ error: "invalid purge request" }, 400);
      }
    }

    if (request.method === "GET" && url.pathname === "/v1/limits") {
      try {
        const current = await new CloudflareBrowserClient(env.BROWSER).limits();
        return jsonResponse({
          activeSessionCount: current.activeSessions.length,
          allowedBrowserAcquisitions: current.allowedBrowserAcquisitions,
          maxConcurrentSessions: current.maxConcurrentSessions,
          timeUntilNextAllowedBrowserAcquisition: current.timeUntilNextAllowedBrowserAcquisition,
        });
      } catch {
        return jsonResponse({ error: "provider limits unavailable" }, 503);
      }
    }

    return jsonResponse({ error: "not found" }, 404);
  },
};

export default worker;

export class BrowserSession {
  private queue: Promise<void> = Promise.resolve();
  private readonly runtime: BrowserSessionRuntime;

  constructor(
    private readonly state: DurableObjectState,
    env: Env,
  ) {
    this.runtime = new BrowserSessionRuntime(
      state.storage,
      new CloudflareBrowserClient(env.BROWSER),
      { keepAliveMs: keepAliveMs(env) },
    );
  }

  fetch(request: Request): Promise<Response> {
    return this.exclusive(async () => {
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/call") {
        try {
          const call = parseComputerUseCall(await readJson(request));
          return jsonResponse(await this.runtime.handle(call));
        } catch {
          return jsonResponse(
            failureResponse("invalid_request", "Provider request validation failed."),
            400,
          );
        }
      }
      if (request.method === "POST" && url.pathname === "/purge") {
        await this.runtime.purge();
        return jsonResponse({ purged: true });
      }
      return jsonResponse({ error: "not found" }, 404);
    });
  }

  alarm(): Promise<void> {
    return this.exclusive(async () => this.runtime.alarm());
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export async function sessionObjectName(call: ComputerUseCall, env: Env): Promise<string> {
  const salt = env.SESSION_KEY_SALT?.trim();
  if (salt === undefined || salt.length < 32) {
    throw new Error("session key salt is not configured");
  }
  const isolation = isolationMode(env.BROWSER_ISOLATION);
  const identity = identityFor(call, isolation);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(salt),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${isolation}:${identity}`),
  );
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function bearerMatches(header: string | null, expected: string): Promise<boolean> {
  const supplied = header?.startsWith("Bearer ") === true ? header.slice("Bearer ".length) : "";
  const [left, right] = await Promise.all([digest(supplied), digest(expected)]);
  let difference = supplied.length === expected.length ? 0 : 1;
  for (let index = 0; index < left.length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return expected.length > 0 && difference === 0;
}

async function authorizeRequest(request: Request, env: Env): Promise<Response | undefined> {
  const expected = env.PROVIDER_AUTH_TOKEN?.trim() ?? "";
  if (expected.length < 32) {
    return jsonResponse({ error: "provider authentication is not configured" }, 503);
  }
  if (!(await bearerMatches(request.headers.get("authorization"), expected))) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }
  return undefined;
}

async function readJson(request: Request): Promise<unknown> {
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_CALL_BYTES) {
    throw new Error("request body too large");
  }
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_CALL_BYTES) {
    throw new Error("request body too large");
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
}

async function forwardToSession(
  env: Env,
  objectName: string,
  path: string,
  body: unknown,
): Promise<Response> {
  const objectId = env.BROWSER_SESSIONS.idFromName(objectName);
  const stub = env.BROWSER_SESSIONS.get(objectId);
  return stub.fetch(`https://browser-session.invalid${path}`, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
}

function identityFor(call: ComputerUseCall, isolation: IsolationMode): string {
  switch (isolation) {
    case "call":
      return call.callId;
    case "environment":
      return call.environmentId ?? call.threadId;
    case "shared":
      return "shared";
    case "thread":
      return call.threadId;
  }
}

function isolationMode(value: string | undefined): IsolationMode {
  switch (value?.trim().toLowerCase()) {
    case "call":
      return "call";
    case "environment":
    case "env":
      return "environment";
    case "shared":
      return "shared";
    default:
      return "thread";
  }
}

function identityCall(identity: {
  environmentId?: string | null | undefined;
  threadId: string;
}): ComputerUseCall {
  return {
    adapter: "browser",
    arguments: {},
    callId: "purge",
    ...(identity.environmentId === undefined ? {} : { environmentId: identity.environmentId }),
    threadId: identity.threadId,
    tool: "browser_observe",
    turnId: "purge",
  };
}

function keepAliveMs(env: Env): number {
  const parsed = Number(env.BROWSER_KEEP_ALIVE_MS ?? "120000");
  return Number.isFinite(parsed)
    ? Math.min(600_000, Math.max(10_000, Math.trunc(parsed)))
    : 120_000;
}

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, {
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
    status,
  });
}

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}
