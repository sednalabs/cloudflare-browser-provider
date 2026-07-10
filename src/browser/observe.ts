import { Buffer } from "node:buffer";

import type { Page } from "@cloudflare/playwright";

import {
  compactText,
  type ComputerUseResponse,
  failureResponse,
  successResponse,
} from "../contract/index.js";
import { displayUrl } from "./actions.js";

const MAX_IMAGE_BYTES = 768 * 1024;
const MAX_CONTROLS = 80;

export interface PageState {
  documentHeight: number;
  documentWidth: number;
  scrollX: number;
  scrollY: number;
  title: string;
  url: string;
  viewportHeight: number;
  viewportWidth: number;
}

export interface VisibleControl {
  bottom: number;
  label: string;
  left: number;
  role: string;
  right: number;
  top: number;
}

export async function observeSuccess(
  page: Page,
  actionSummaries: string[],
  lifecycleNotes: string[],
): Promise<ComputerUseResponse> {
  const { imageUrl, state, controls } = await capturePage(page);
  return successResponse(
    observationText(state, controls, actionSummaries, lifecycleNotes),
    imageUrl,
  );
}

export async function observeFailure(
  page: Page,
  code: string,
  message: string,
  actionSummaries: string[],
  lifecycleNotes: string[],
): Promise<ComputerUseResponse> {
  try {
    const { imageUrl, state, controls } = await capturePage(page);
    const context = observationText(state, controls, actionSummaries, lifecycleNotes);
    return failureResponse(code, `${message}\n\n${context}`, imageUrl);
  } catch {
    return failureResponse(code, message);
  }
}

export async function pageState(page: Page): Promise<PageState> {
  const viewport = page.viewportSize() ?? { width: 1280, height: 720 };
  const dimensions = await page
    .evaluate(readPageDimensions)
    .catch(() => ({
      documentHeight: viewport.height,
      documentWidth: viewport.width,
      scrollX: 0,
      scrollY: 0,
    }));
  return {
    ...dimensions,
    title: compactText(await page.title().catch(() => ""), 240),
    url: page.url(),
    viewportHeight: viewport.height,
    viewportWidth: viewport.width,
  };
}

async function capturePage(
  page: Page,
): Promise<{ controls: VisibleControl[]; imageUrl: string; state: PageState }> {
  const state = await pageState(page);
  const controls = await visibleControls(page);
  const imageUrl = await boundedScreenshot(page);
  return { controls, imageUrl, state };
}

async function boundedScreenshot(page: Page): Promise<string> {
  for (const quality of [72, 58, 42, 30]) {
    const screenshot = await page.screenshot({
      animations: "disabled",
      caret: "hide",
      fullPage: false,
      quality,
      scale: "css",
      type: "jpeg",
    });
    const bytes = Buffer.from(screenshot);
    if (bytes.byteLength <= MAX_IMAGE_BYTES) {
      return `data:image/jpeg;base64,${bytes.toString("base64")}`;
    }
  }
  throw new Error("browser screenshot exceeds the provider image limit");
}

async function visibleControls(page: Page): Promise<VisibleControl[]> {
  return page.evaluate(collectVisibleControls, MAX_CONTROLS).catch(() => []);
}

export function readPageDimensions(): Pick<
  PageState,
  "documentHeight" | "documentWidth" | "scrollX" | "scrollY"
> {
  return {
    documentHeight: Math.max(
      document.documentElement.scrollHeight,
      document.body?.scrollHeight ?? 0,
    ),
    documentWidth: Math.max(
      document.documentElement.scrollWidth,
      document.body?.scrollWidth ?? 0,
    ),
    scrollX: window.scrollX,
    scrollY: window.scrollY,
  };
}

export function collectVisibleControls(limit: number): VisibleControl[] {
  const nodes = Array.from(
    document.querySelectorAll<HTMLElement>(
      "a,button,input,select,textarea,[role],[contenteditable='true'],summary",
    ),
  );
  const results: VisibleControl[] = [];
  for (const element of nodes) {
    const box = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    if (
      box.width <= 0 ||
      box.height <= 0 ||
      box.bottom < 0 ||
      box.right < 0 ||
      box.top > window.innerHeight ||
      box.left > window.innerWidth ||
      style.display === "none" ||
      style.visibility === "hidden"
    ) {
      continue;
    }
    const tag = element.tagName.toLowerCase();
    const role = element.getAttribute("role") || (tag === "a" ? "link" : tag);
    const formName = tag === "input" || tag === "select" ? element.getAttribute("name") : null;
    const selectedLabel =
      tag === "select" && element instanceof HTMLSelectElement
        ? element.selectedOptions.item(0)?.textContent
        : null;
    const label =
      element.getAttribute("aria-label") ||
      element.getAttribute("placeholder") ||
      element.getAttribute("title") ||
      formName ||
      selectedLabel ||
      element.textContent ||
      "";
    results.push({
      bottom: Math.round(box.bottom),
      label: label.replace(/\s+/g, " ").trim().slice(0, 120),
      left: Math.round(box.left),
      right: Math.round(box.right),
      role: role.slice(0, 40),
      top: Math.round(box.top),
    });
    if (results.length >= limit) {
      break;
    }
  }
  return results;
}

function observationText(
  state: PageState,
  controls: VisibleControl[],
  actionSummaries: string[],
  lifecycleNotes: string[],
): string {
  const lines = [
    "Browser observation",
    `url: ${displayUrl(state.url)}`,
    `title: ${state.title}`,
    `viewport: ${state.viewportWidth}x${state.viewportHeight} scroll=${Math.round(state.scrollX)},${Math.round(state.scrollY)} document=${Math.round(state.documentWidth)}x${Math.round(state.documentHeight)}`,
  ];
  if (lifecycleNotes.length > 0) {
    lines.push("session:", ...lifecycleNotes.map((note) => `- ${compactText(note, 240)}`));
  }
  if (actionSummaries.length > 0) {
    lines.push("actions:", ...actionSummaries.map((summary) => `- ${compactText(summary, 240)}`));
  }
  if (controls.length > 0) {
    lines.push(
      "interaction_map:",
      ...controls.map(
        (control) =>
          `- ${control.role} "${compactText(control.label, 120)}" box=${control.left},${control.top},${control.right},${control.bottom}`,
      ),
    );
  }
  return lines.join("\n");
}
