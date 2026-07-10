import { Buffer } from "node:buffer";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  collectVisibleControls,
  observeFailure,
  observeSuccess,
  pageState,
  readPageDimensions,
} from "../src/browser/observe.js";
import { createFakeSurface } from "./helpers/fakes.js";

interface FakeElementOptions {
  attributes?: Record<string, string>;
  box?: Partial<DOMRect>;
  display?: string;
  tag?: string;
  text?: string | null;
  visibility?: string;
}

class FakeElement {
  readonly display: string;
  readonly tagName: string;
  readonly textContent: string | null;
  readonly visibility: string;
  private readonly attributes: Record<string, string>;
  private readonly box: DOMRect;

  constructor(options: FakeElementOptions = {}) {
    this.attributes = options.attributes ?? {};
    this.box = {
      bottom: 20,
      height: 20,
      left: 0,
      right: 40,
      top: 0,
      width: 40,
      x: 0,
      y: 0,
      toJSON: () => ({}),
      ...options.box,
    };
    this.display = options.display ?? "block";
    this.tagName = options.tag ?? "BUTTON";
    this.textContent = options.text ?? null;
    this.visibility = options.visibility ?? "visible";
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }

  getBoundingClientRect(): DOMRect {
    return this.box;
  }
}

class FakeSelectElement extends FakeElement {
  readonly selectedOptions = {
    item: () => ({ textContent: "Selected option" }),
  };

  constructor(options: FakeElementOptions = {}) {
    super({ tag: "SELECT", ...options });
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("browser observations", () => {
  it("extracts bounded, visible, labelled controls in the browser realm", () => {
    const elements = [
      new FakeElement({ box: { width: 0 } }),
      new FakeElement({ box: { height: 0 } }),
      new FakeElement({ box: { bottom: -1 } }),
      new FakeElement({ box: { right: -1 } }),
      new FakeElement({ box: { top: 101 } }),
      new FakeElement({ box: { left: 101 } }),
      new FakeElement({ display: "none" }),
      new FakeElement({ visibility: "hidden" }),
      new FakeElement({ attributes: { "aria-label": "Primary   link" }, tag: "A" }),
      new FakeElement({ attributes: { placeholder: "Search" } }),
      new FakeElement({ attributes: { name: "email" }, tag: "INPUT" }),
      new FakeSelectElement(),
      new FakeElement({ attributes: { role: "menuitem", title: "Open" }, tag: "DIV" }),
      new FakeElement({ tag: "TEXTAREA", text: "Long   label" }),
      new FakeElement({ tag: "SUMMARY" }),
    ];
    vi.stubGlobal("HTMLSelectElement", FakeSelectElement);
    vi.stubGlobal("document", { querySelectorAll: () => elements });
    vi.stubGlobal("window", {
      getComputedStyle: (element: FakeElement) => ({
        display: element.display,
        visibility: element.visibility,
      }),
      innerHeight: 100,
      innerWidth: 100,
    });

    const controls = collectVisibleControls(80);

    expect(controls.map((control) => [control.role, control.label])).toEqual([
      ["link", "Primary link"],
      ["button", "Search"],
      ["input", "email"],
      ["select", "Selected option"],
      ["menuitem", "Open"],
      ["textarea", "Long label"],
      ["summary", ""],
    ]);
    expect(collectVisibleControls(1)).toHaveLength(1);
  });

  it("reads document dimensions with and without a body", () => {
    const documentValue = {
      body: { scrollHeight: 900, scrollWidth: 700 },
      documentElement: { scrollHeight: 800, scrollWidth: 600 },
    };
    vi.stubGlobal("document", documentValue);
    vi.stubGlobal("window", { scrollX: 11, scrollY: 22 });

    expect(readPageDimensions()).toEqual({
      documentHeight: 900,
      documentWidth: 700,
      scrollX: 11,
      scrollY: 22,
    });

    vi.stubGlobal("document", {
      body: undefined,
      documentElement: documentValue.documentElement,
    });
    expect(readPageDimensions().documentHeight).toBe(800);
  });

  it("includes lifecycle, action, and interaction-map context", async () => {
    const surface = createFakeSurface({
      controls: [{ bottom: 40, label: "Save", left: 10, right: 60, role: "button", top: 20 }],
    });

    const response = await observeSuccess(surface.page, ["clicked selector"], ["reconnected"]);

    expect(response.contentItems[0]).toMatchObject({
      text: expect.stringContaining('button "Save" box=10,20,60,40'),
    });
    expect(JSON.stringify(response)).toContain("clicked selector");
    expect(JSON.stringify(response)).toContain("reconnected");
  });

  it("falls back when page metadata and interaction maps are unavailable", async () => {
    const surface = createFakeSurface({ controlsFailure: true, dimensionsFailure: true });
    vi.mocked(surface.page.viewportSize).mockReturnValue(null);
    vi.mocked(surface.page.title).mockRejectedValueOnce(new Error("title unavailable"));

    const state = await pageState(surface.page);
    const response = await observeSuccess(surface.page, [], []);

    expect(state).toMatchObject({
      documentHeight: 720,
      documentWidth: 1280,
      title: "",
      viewportHeight: 720,
      viewportWidth: 1280,
    });
    expect(JSON.stringify(response)).not.toContain("interaction_map");
  });

  it("retries oversized screenshots and strips an uncapturable failure image", async () => {
    const retrySurface = createFakeSurface();
    retrySurface.spies.screenshot
      .mockResolvedValueOnce(Buffer.alloc(769 * 1024))
      .mockResolvedValueOnce(Buffer.from("small-jpeg"));

    const success = await observeSuccess(retrySurface.page, [], []);
    expect(success.success).toBe(true);
    expect(retrySurface.spies.screenshot).toHaveBeenCalledTimes(2);

    const failureSurface = createFakeSurface();
    failureSurface.spies.screenshot.mockResolvedValue(Buffer.alloc(769 * 1024));
    const failure = await observeFailure(
      failureSurface.page,
      "capture_failed",
      "capture unavailable",
      [],
      [],
    );
    expect(failure.contentItems).toEqual([
      {
        text: "Browser provider error [capture_failed]: capture unavailable",
        type: "inputText",
      },
    ]);
    expect(failureSurface.spies.screenshot).toHaveBeenCalledTimes(4);
  });
});
