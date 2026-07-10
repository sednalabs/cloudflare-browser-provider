import {
  MAX_CALL_BYTES,
  failureResponse,
  parseComputerUseResponse,
  type ComputerUseCall,
  type ComputerUseResponse,
  type PurgeRequest,
} from "../contract/index.js";
import { PROVIDER_PROTOCOL_VERSION } from "../version.js";

export interface ProviderClientConfig {
  accessClientId?: string;
  accessClientSecret?: string;
  timeoutMs: number;
  token: string;
  url: URL;
}

export function providerClientConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ProviderClientConfig {
  const rawUrl = environment.CLOUDFLARE_BROWSER_PROVIDER_URL?.trim();
  const token = environment.CLOUDFLARE_BROWSER_PROVIDER_TOKEN?.trim() ?? "";
  if (rawUrl === undefined || rawUrl === "") {
    throw new Error("CLOUDFLARE_BROWSER_PROVIDER_URL is not configured");
  }
  if (token.length < 32) {
    throw new Error("CLOUDFLARE_BROWSER_PROVIDER_TOKEN is not configured");
  }
  const url = new URL(rawUrl);
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && localDevelopmentHost(url.hostname))
  ) {
    throw new Error("provider URL must use HTTPS except for loopback development");
  }
  const accessClientId = environment.CLOUDFLARE_ACCESS_CLIENT_ID?.trim();
  const accessClientSecret = environment.CLOUDFLARE_ACCESS_CLIENT_SECRET?.trim();
  if ((accessClientId === undefined) !== (accessClientSecret === undefined)) {
    throw new Error("both Cloudflare Access service-token values must be configured together");
  }
  const timeoutSeconds = Number(environment.CLOUDFLARE_BROWSER_PROVIDER_TIMEOUT_SECS ?? "120");
  const timeoutMs = Number.isFinite(timeoutSeconds)
    ? Math.min(180_000, Math.max(1000, Math.trunc(timeoutSeconds * 1000)))
    : 120_000;
  return {
    ...(accessClientId === undefined || accessClientSecret === undefined
      ? {}
      : { accessClientId, accessClientSecret }),
    timeoutMs,
    token,
    url,
  };
}

export async function invokeProvider(
  call: ComputerUseCall,
  config: ProviderClientConfig,
  fetchImplementation: typeof fetch = fetch,
): Promise<ComputerUseResponse> {
  const body = JSON.stringify({ protocolVersion: PROVIDER_PROTOCOL_VERSION, call });
  if (Buffer.byteLength(body, "utf8") > MAX_CALL_BYTES) {
    return failureResponse("input_too_large", "Provider input exceeds the protocol size limit.");
  }
  try {
    const response = await fetchImplementation(endpoint(config.url, "/v1/calls"), {
      body,
      headers: requestHeaders(config),
      method: "POST",
      signal: AbortSignal.timeout(config.timeoutMs),
    });
    if (!response.ok) {
      return failureResponse(
        "provider_http_error",
        `Hosted provider returned HTTP ${response.status}.`,
      );
    }
    return parseComputerUseResponse(await response.json());
  } catch {
    return failureResponse("provider_unavailable", "Hosted browser provider request failed.");
  }
}

export async function providerHealth(
  config: ProviderClientConfig,
  fetchImplementation: typeof fetch = fetch,
): Promise<unknown> {
  const response = await fetchImplementation(endpoint(config.url, "/health"), {
    method: "GET",
    signal: AbortSignal.timeout(Math.min(config.timeoutMs, 10_000)),
  });
  if (!response.ok) {
    throw new Error(`provider health returned HTTP ${response.status}`);
  }
  return response.json();
}

export async function providerLimits(
  config: ProviderClientConfig,
  fetchImplementation: typeof fetch = fetch,
): Promise<unknown> {
  return authenticatedJson(config, fetchImplementation, "/v1/limits", "GET");
}

export async function purgeProviderSession(
  identity: PurgeRequest,
  config: ProviderClientConfig,
  fetchImplementation: typeof fetch = fetch,
): Promise<unknown> {
  return authenticatedJson(config, fetchImplementation, "/v1/purge", "POST", identity);
}

async function authenticatedJson(
  config: ProviderClientConfig,
  fetchImplementation: typeof fetch,
  path: string,
  method: "GET" | "POST",
  body?: unknown,
): Promise<unknown> {
  const request: RequestInit = {
    headers: requestHeaders(config),
    method,
    signal: AbortSignal.timeout(config.timeoutMs),
  };
  if (body !== undefined) {
    request.body = JSON.stringify(body);
  }
  const response = await fetchImplementation(endpoint(config.url, path), request);
  if (!response.ok) {
    throw new Error(`provider returned HTTP ${response.status}`);
  }
  return response.json();
}

function requestHeaders(config: ProviderClientConfig): Headers {
  const headers = new Headers({
    authorization: `Bearer ${config.token}`,
    "content-type": "application/json",
  });
  if (config.accessClientId !== undefined && config.accessClientSecret !== undefined) {
    headers.set("CF-Access-Client-Id", config.accessClientId);
    headers.set("CF-Access-Client-Secret", config.accessClientSecret);
  }
  return headers;
}

function endpoint(base: URL, path: string): URL {
  const url = new URL(base.toString());
  url.pathname = `${url.pathname.replace(/\/$/, "")}${path}`;
  url.search = "";
  url.hash = "";
  return url;
}

function localDevelopmentHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}
