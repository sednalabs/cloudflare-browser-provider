import { describe, expect, it } from "vitest";

import { displayUrl, publicNavigationUrl, runAction } from "../src/browser/actions.js";
import { createFakeSurface } from "./helpers/fakes.js";

describe("browser action translation", () => {
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
      "http://169.254.169.254/",
      "https://user:password@example.com/",
      "https://service.local/",
    ]) {
      expect(() => publicNavigationUrl(url)).toThrow();
    }
    expect(publicNavigationUrl("https://example.com/").hostname).toBe("example.com");
  });

  it("redacts URL credentials, query values, and fragments in observations", () => {
    expect(displayUrl("https://example.com/path?token=value#section")).toBe(
      "https://example.com/path?[redacted]",
    );
  });
});
