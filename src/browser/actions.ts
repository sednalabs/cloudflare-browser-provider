import type { Locator, Page } from "@cloudflare/playwright";

type UnknownRecord = Record<string, unknown>;

const ACTION_TYPES = new Set([
  "navigate",
  "click",
  "type",
  "focus",
  "clear",
  "keypress",
  "key_down",
  "key_up",
  "scroll",
  "mouse_wheel",
  "wait",
  "select",
  "drag",
  "hover",
  "mouse_move",
  "mouse_down",
  "mouse_up",
]);

export function canonicalActions(argumentsValue: UnknownRecord): UnknownRecord[] {
  if (Array.isArray(argumentsValue.actions) && argumentsValue.actions.length > 0) {
    return argumentsValue.actions.map((action) => requireRecord(action, "browser action"));
  }
  if (typeof argumentsValue.action === "string" || typeof argumentsValue.type === "string") {
    return [argumentsValue];
  }
  return [];
}

export async function runAction(page: Page, action: UnknownRecord): Promise<string> {
  const type = stringField(action, "type") ?? stringField(action, "action");
  if (type === undefined || !ACTION_TYPES.has(type)) {
    throw new ProviderActionError("unsupported_action", "Unsupported browser action.");
  }

  switch (type) {
    case "navigate": {
      const url = publicNavigationUrl(requiredString(action, "url"));
      await page.goto(url.toString(), {
        timeout: timeoutMs(action),
        waitUntil: "domcontentloaded",
      });
      return `navigated to ${displayUrl(url.toString())}`;
    }
    case "click":
      await click(page, action);
      return selectorRecord(action) === undefined
        ? "clicked browser coordinates"
        : "clicked selector";
    case "type":
      await typeText(page, action);
      return selectorRecord(action) === undefined
        ? "typed into the focused browser element [value redacted]"
        : "typed into selector [value redacted]";
    case "focus":
      await focus(page, action);
      return "focused browser element";
    case "clear":
      await clear(page, action);
      return "cleared browser element";
    case "keypress":
      await keypress(page, action);
      return "sent browser keypress";
    case "key_down":
      await page.keyboard.down(requiredString(action, "key"));
      return "sent browser key down";
    case "key_up":
      await page.keyboard.up(requiredString(action, "key"));
      return "sent browser key up";
    case "scroll":
    case "mouse_wheel":
      await withModifiers(page, action, async () => {
        await page.mouse.wheel(
          numberField(action, "scroll_x", 0),
          numberField(action, "scroll_y", 720),
        );
      });
      return "scrolled browser viewport";
    case "wait": {
      const milliseconds = clampedInteger(numberField(action, "ms", 1000), 0, 30_000);
      await page.waitForTimeout(milliseconds);
      return `waited ${milliseconds} ms`;
    }
    case "select":
      await select(page, action);
      return "selected browser option";
    case "drag":
      await drag(page, action);
      return "dragged in browser viewport";
    case "hover":
      await hover(page, action);
      return "hovered browser element";
    case "mouse_move":
      await page.mouse.move(requiredNumber(action, "x"), requiredNumber(action, "y"), {
        ...stepsOption(action.steps),
      });
      return "moved browser pointer";
    case "mouse_down":
      await mouseButtonEvent(page, action, "down");
      return "sent browser mouse down";
    case "mouse_up":
      await mouseButtonEvent(page, action, "up");
      return "sent browser mouse up";
  }
  throw new ProviderActionError("unsupported_action", "Unsupported browser action.");
}

export function publicNavigationUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ProviderActionError("invalid_url", "Navigation URL is invalid.");
  }

  if (!new Set(["http:", "https:"]).has(url.protocol)) {
    throw new ProviderActionError(
      "invalid_url_scheme",
      "Navigation requires an HTTP or HTTPS URL.",
    );
  }
  if (url.username !== "" || url.password !== "") {
    throw new ProviderActionError(
      "url_credentials_rejected",
      "Credentials in navigation URLs are not allowed.",
    );
  }
  if (privateHostname(url.hostname)) {
    throw new ProviderActionError(
      "private_network_rejected",
      "Navigation to loopback, link-local, or private network hosts is disabled.",
    );
  }
  return url;
}

export function displayUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    if (url.search !== "") {
      url.search = "?[redacted]";
    }
    url.hash = "";
    return url.toString();
  } catch {
    return "about:blank";
  }
}

export class ProviderActionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ProviderActionError";
  }
}

async function click(page: Page, action: UnknownRecord): Promise<void> {
  const locator = locatorFromAction(page, action);
  await withModifiers(page, action, async () => {
    if (locator !== undefined) {
      await locator.click({
        button: mouseButton(action),
        ...clickCountOption(action.click_count),
        ...delayOption(action.delay_ms),
        timeout: timeoutMs(action),
      });
      return;
    }
    await page.mouse.click(requiredNumber(action, "x"), requiredNumber(action, "y"), {
      button: mouseButton(action),
      ...clickCountOption(action.click_count),
      ...delayOption(action.delay_ms),
    });
  });
}

async function typeText(page: Page, action: UnknownRecord): Promise<void> {
  const text = stringField(action, "text") ?? "";
  const locator = locatorFromAction(page, action);
  const method = stringField(action, "method");
  if (locator !== undefined && method === "fill") {
    await locator.fill(text, { timeout: timeoutMs(action) });
    return;
  }
  if (locator !== undefined) {
    await locator.click({ timeout: timeoutMs(action) });
    if (action.replace !== false) {
      await selectAllAndClear(page);
    }
  }
  await page.keyboard.type(text, delayOption(action.delay_ms));
}

async function focus(page: Page, action: UnknownRecord): Promise<void> {
  const locator = locatorFromAction(page, action);
  if (locator !== undefined) {
    await locator.focus({ timeout: timeoutMs(action) });
    return;
  }
  if (typeof action.x === "number" && typeof action.y === "number") {
    await page.mouse.move(action.x, action.y);
    return;
  }
  throw new ProviderActionError(
    "focus_target_required",
    "Focus requires a selector or coordinates.",
  );
}

async function clear(page: Page, action: UnknownRecord): Promise<void> {
  const locator = locatorFromAction(page, action);
  if (locator !== undefined) {
    await locator.fill("", { timeout: timeoutMs(action) });
    return;
  }
  await selectAllAndClear(page);
}

async function keypress(page: Page, action: UnknownRecord): Promise<void> {
  const keys = action.keys;
  const key =
    Array.isArray(keys) && keys.every((value) => typeof value === "string")
      ? keys.join("+")
      : stringField(action, "key");
  if (key === undefined || key === "") {
    throw new ProviderActionError("key_required", "Keypress requires key or keys.");
  }
  await page.keyboard.press(key, delayOption(action.delay_ms));
}

async function select(page: Page, action: UnknownRecord): Promise<void> {
  const locator = locatorFromAction(page, action);
  if (locator === undefined) {
    throw new ProviderActionError("selector_required", "Select requires a selector.");
  }
  const value =
    stringField(action, "value") ??
    stringField(action, "text") ??
    stringField(action, "label") ??
    "";
  await locator.selectOption(value, { timeout: timeoutMs(action) });
}

async function drag(page: Page, action: UnknownRecord): Promise<void> {
  await withModifiers(page, action, async () => {
    await page.mouse.move(requiredNumber(action, "x1"), requiredNumber(action, "y1"), {
      ...stepsOption(action.steps),
    });
    await page.mouse.down({ button: mouseButton(action) });
    try {
      await page.mouse.move(requiredNumber(action, "x2"), requiredNumber(action, "y2"), {
        ...stepsOption(action.steps),
      });
    } finally {
      await page.mouse.up({ button: mouseButton(action) });
    }
  });
}

async function hover(page: Page, action: UnknownRecord): Promise<void> {
  const locator = locatorFromAction(page, action);
  if (locator !== undefined) {
    await locator.hover({ timeout: timeoutMs(action) });
    return;
  }
  await page.mouse.move(requiredNumber(action, "x"), requiredNumber(action, "y"), {
    ...stepsOption(action.steps),
  });
}

async function mouseButtonEvent(
  page: Page,
  action: UnknownRecord,
  direction: "down" | "up",
): Promise<void> {
  await withModifiers(page, action, async () => {
    if (typeof action.x === "number" || typeof action.y === "number") {
      await page.mouse.move(requiredNumber(action, "x"), requiredNumber(action, "y"));
    }
    if (direction === "down") {
      await page.mouse.down({ button: mouseButton(action) });
    } else {
      await page.mouse.up({ button: mouseButton(action) });
    }
    const delay = nonNegativeInteger(action.delay_ms);
    if (delay !== undefined) {
      await page.waitForTimeout(delay);
    }
  });
}

function locatorFromAction(page: Page, action: UnknownRecord): Locator | undefined {
  const selector = selectorRecord(action);
  if (selector === undefined) {
    return undefined;
  }
  if (typeof selector === "string") {
    return page.locator(selector).first();
  }

  const exact = typeof selector.exact === "boolean" ? selector.exact : undefined;
  const exactOptions = exact === undefined ? {} : { exact };
  const strict = selector.strict === true;
  let locator: Locator | undefined;
  if (typeof selector.css === "string") {
    locator = page.locator(selector.css);
  } else if (typeof selector.text === "string") {
    locator = page.getByText(selector.text, exactOptions);
  } else if (typeof selector.label === "string") {
    locator = page.getByLabel(selector.label, exactOptions);
  } else if (typeof selector.placeholder === "string") {
    locator = page.getByPlaceholder(selector.placeholder, exactOptions);
  } else if (typeof selector.test_id === "string" || typeof selector.testId === "string") {
    locator = page.getByTestId(String(selector.test_id ?? selector.testId));
  } else if (typeof selector.title === "string") {
    locator = page.getByTitle(selector.title, exactOptions);
  } else if (typeof selector.alt_text === "string" || typeof selector.altText === "string") {
    locator = page.getByAltText(String(selector.alt_text ?? selector.altText), exactOptions);
  } else if (typeof selector.role === "string") {
    const role = selector.role as Parameters<Page["getByRole"]>[0];
    const name = typeof selector.name === "string" ? selector.name : undefined;
    locator = page.getByRole(role, {
      ...exactOptions,
      ...(name === undefined ? {} : { name }),
    });
  }
  if (locator === undefined) {
    throw new ProviderActionError(
      "invalid_selector",
      "Selector does not name a supported locator.",
    );
  }
  return strict ? locator : locator.first();
}

function selectorRecord(action: UnknownRecord): string | UnknownRecord | undefined {
  const selector = action.selector;
  if (selector === undefined) {
    return undefined;
  }
  if (typeof selector === "string") {
    return selector;
  }
  return requireRecord(selector, "selector");
}

async function selectAllAndClear(page: Page): Promise<void> {
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Backspace");
}

async function withModifiers<T>(
  page: Page,
  action: UnknownRecord,
  operation: () => Promise<T>,
): Promise<T> {
  const values = action.modifiers;
  const modifiers = Array.isArray(values) ? values.map(String) : [];
  if (!modifiers.every((modifier) => ["Alt", "Control", "Meta", "Shift"].includes(modifier))) {
    throw new ProviderActionError("invalid_modifier", "Unsupported keyboard modifier.");
  }
  for (const modifier of modifiers) {
    await page.keyboard.down(modifier);
  }
  try {
    return await operation();
  } finally {
    for (const modifier of modifiers.toReversed()) {
      await page.keyboard.up(modifier).catch(() => undefined);
    }
  }
}

function privateHostname(hostname: string): boolean {
  const normalized = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized === "localhost.localdomain"
  ) {
    return true;
  }

  // The URL parser canonicalizes legacy hexadecimal, octal, short, and integer
  // IPv4 forms before this check. Reject every IP literal, not only private
  // ranges, so alternate encodings and IPv4-mapped IPv6 cannot bypass the
  // provider's public-host default. DNS-level egress policy remains a separate
  // deployment control.
  return (
    normalized.includes(":") || /^[0-9.]+$/.test(normalized) || /^0x[0-9a-f]+$/.test(normalized)
  );
}

function mouseButton(action: UnknownRecord): "left" | "right" | "middle" {
  const button = stringField(action, "button") ?? "left";
  if (button !== "left" && button !== "right" && button !== "middle") {
    throw new ProviderActionError("invalid_button", "Mouse button must be left, right, or middle.");
  }
  return button;
}

function timeoutMs(action: UnknownRecord): number {
  const fromMilliseconds = typeof action.timeout_ms === "number" ? action.timeout_ms : undefined;
  const fromSeconds =
    typeof action.timeout_secs === "number" ? action.timeout_secs * 1000 : undefined;
  return clampedInteger(fromMilliseconds ?? fromSeconds ?? 15_000, 100, 30_000);
}

function requiredString(value: UnknownRecord, field: string): string {
  const result = stringField(value, field);
  if (result === undefined || result === "") {
    throw new ProviderActionError("invalid_action", `${field} is required.`);
  }
  return result;
}

function stringField(value: UnknownRecord, field: string): string | undefined {
  return typeof value[field] === "string" ? value[field] : undefined;
}

function requiredNumber(value: UnknownRecord, field: string): number {
  const result = value[field];
  if (typeof result !== "number" || !Number.isFinite(result)) {
    throw new ProviderActionError("invalid_action", `${field} must be a finite number.`);
  }
  return result;
}

function numberField(value: UnknownRecord, field: string, fallback: number): number {
  const result = value[field];
  return typeof result === "number" && Number.isFinite(result) ? result : fallback;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function clickCountOption(value: unknown): { clickCount?: number } {
  const clickCount = positiveInteger(value);
  return clickCount === undefined ? {} : { clickCount };
}

function delayOption(value: unknown): { delay?: number } {
  const delay = nonNegativeInteger(value);
  return delay === undefined ? {} : { delay };
}

function stepsOption(value: unknown): { steps?: number } {
  const steps = positiveInteger(value);
  return steps === undefined ? {} : { steps };
}

function clampedInteger(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}

function requireRecord(value: unknown, name: string): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProviderActionError("invalid_action", `${name} must be an object.`);
  }
  return value as UnknownRecord;
}
