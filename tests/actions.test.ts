import { describe, expect, it, vi } from "vitest";

import {
  canonicalActions,
  displayUrl,
  publicNavigationUrl,
  runAction,
} from "../src/browser/actions.js";
import { createFakeSurface } from "./helpers/fakes.js";

describe("browser action translation", () => {
  it("canonicalizes batched, legacy, and empty action payloads", () => {
    expect(canonicalActions({})).toEqual([]);
    expect(canonicalActions({ actions: [] })).toEqual([]);
    expect(canonicalActions({ action: "wait", ms: 1 })).toEqual([{ action: "wait", ms: 1 }]);
    expect(canonicalActions({ actions: [{ type: "wait" }, { type: "scroll" }] })).toEqual([
      { type: "wait" },
      { type: "scroll" },
    ]);
    expect(() => canonicalActions({ actions: [null] })).toThrow("browser action");
  });

  it("executes the supported action vocabulary without exposing typed values", async () => {
    const surface = createFakeSurface();
    const actions = [
      { type: "navigate", url: "https://example.com/path?secret=value" },
      { selector: { role: "button", name: "Save" }, type: "click" },
      { selector: "input", text: "do not echo", type: "type" },
      { selector: { label: "Name" }, type: "focus" },
      { method: "fill", selector: { placeholder: "Name" }, type: "clear" },
      { key: "Enter", type: "keypress" },
      { key: "Shift", type: "key_down" },
      { key: "Shift", type: "key_up" },
      { scroll_y: 400, type: "scroll" },
      { ms: 5, type: "wait" },
      { selector: { test_id: "choice" }, type: "select", value: "one" },
      { type: "drag", x1: 1, x2: 3, y1: 2, y2: 4 },
      { selector: { text: "Menu" }, type: "hover" },
      { type: "mouse_move", x: 5, y: 6 },
      { type: "mouse_down", x: 5, y: 6 },
      { type: "mouse_up", x: 5, y: 6 },
    ];

    const summaries = [];
    for (const action of actions) {
      summaries.push(await runAction(surface.page, action));
    }
    expect(summaries).toHaveLength(actions.length);
    expect(summaries.join(" ")).not.toContain("do not echo");
    expect(summaries[0]).toContain("?[redacted]");
  });

  it("rejects non-public and credential-bearing navigation URLs", () => {
    for (const url of [
      "file:///tmp/test",
      "http://127.0.0.1/",
      "http://127.1/",
      "http://169.254.169.254/",
      "http://2130706433/",
      "http://0x7f000001/",
      "http://0177.0.0.1/",
      "http://[::ffff:127.0.0.1]/",
      "http://[fe90::1]/",
      "http://localhost.localdomain/",
      "https://service.localhost/",
      "https://user:password@example.com/",
      "https://service.local/",
    ]) {
      expect(() => publicNavigationUrl(url)).toThrow();
    }
    expect(publicNavigationUrl("https://example.com/").hostname).toBe("example.com");
    expect(() => publicNavigationUrl("not a URL")).toThrow("invalid");
  });

  it("uses Playwright fill when clearing a located element", async () => {
    const surface = createFakeSurface();

    await runAction(surface.page, { selector: "input", type: "clear" });

    expect(surface.spies.fill).toHaveBeenCalledWith("", { timeout: 15_000 });
    expect(surface.spies.click).not.toHaveBeenCalled();
  });

  it("redacts URL credentials, query values, and fragments in observations", () => {
    expect(displayUrl("https://example.com/path?token=value#section")).toBe(
      "https://example.com/path?[redacted]",
    );
    expect(displayUrl("not a URL")).toBe("about:blank");
  });

  it("translates coordinate, fill, modifier, and alternate selector options", async () => {
    const surface = createFakeSurface();

    await runAction(surface.page, {
      button: "right",
      click_count: 2,
      delay_ms: 0,
      modifiers: ["Shift"],
      timeout_secs: 2,
      type: "click",
      x: 10,
      y: 20,
    });
    await runAction(surface.page, {
      method: "fill",
      selector: "input",
      text: "redacted",
      type: "type",
    });
    await runAction(surface.page, { replace: false, selector: "input", text: "x", type: "type" });
    await runAction(surface.page, { type: "focus", x: 1, y: 2 });
    await runAction(surface.page, { type: "clear" });
    await runAction(surface.page, { delay_ms: 0, keys: ["Control", "A"], type: "keypress" });
    await runAction(surface.page, { label: "Two", selector: "select", type: "select" });
    await runAction(surface.page, { steps: 3, type: "hover", x: 1, y: 2 });
    await runAction(surface.page, { delay_ms: 1, type: "mouse_down" });

    for (const selector of [
      { css: ".save", strict: true },
      { exact: true, title: "Save" },
      { alt_text: "Logo" },
      { altText: "Logo" },
      { testId: "save" },
    ]) {
      await runAction(surface.page, { selector, type: "hover" });
    }

    vi.mocked(surface.page.keyboard.up).mockRejectedValueOnce(new Error("key already released"));
    await expect(
      runAction(surface.page, {
        modifiers: ["Control"],
        type: "click",
        x: 1,
        y: 2,
      }),
    ).resolves.toContain("clicked");
  });

  it("rejects malformed actions before issuing browser input", async () => {
    const page = createFakeSurface().page;
    const invalidActions = [
      {},
      { type: "unsupported" },
      { type: "navigate", url: "" },
      { type: "focus" },
      { keys: ["Control", 1], type: "keypress" },
      { type: "select" },
      { button: "side", type: "click", x: 1, y: 2 },
      { modifiers: ["CapsLock"], type: "click", x: 1, y: 2 },
      { type: "click", x: Number.NaN, y: 2 },
      { selector: 3, type: "click" },
      { selector: { unknown: "value" }, type: "click" },
    ];

    for (const action of invalidActions) {
      await expect(runAction(page, action)).rejects.toThrow();
    }
  });
});
