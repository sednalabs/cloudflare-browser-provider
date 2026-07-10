import { describe, expect, it } from "vitest";

import {
  compactText,
  encodedJsonBytes,
  failureResponse,
  hasNativeImage,
  parseComputerUseCall,
  parseComputerUseResponse,
  successResponse,
} from "../src/contract/index.js";

const observeCall = {
  adapter: "browser",
  arguments: { backend: "browser", scope: "viewport_and_page" },
  callId: "call-1",
  environmentId: null,
  threadId: "thread-1",
  tool: "browser_observe",
  turnId: "turn-1",
};

describe("native provider contract", () => {
  it("accepts the current Codex browser call shape", () => {
    expect(parseComputerUseCall(observeCall)).toEqual(observeCall);
  });

  it("rejects unsupported adapters, tools, backends, and empty steps", () => {
    expect(() => parseComputerUseCall({ ...observeCall, adapter: "desktop" })).toThrow();
    expect(() => parseComputerUseCall({ ...observeCall, tool: "browser_other" })).toThrow();
    expect(() =>
      parseComputerUseCall({ ...observeCall, arguments: { backend: "chrome" } }),
    ).toThrow();
    expect(() =>
      parseComputerUseCall({ ...observeCall, arguments: {}, tool: "browser_step" }),
    ).toThrow();
  });

  it("requires native image content on successful visual responses", () => {
    expect(() =>
      parseComputerUseResponse({
        contentItems: [{ text: "text only", type: "inputText" }],
        success: true,
      }),
    ).toThrow("missing native image");
  });

  it("constructs bounded success and failure responses", () => {
    const success = successResponse("Browser observation", "data:image/jpeg;base64,ZmFrZQ==");
    expect(hasNativeImage(success)).toBe(true);
    expect(parseComputerUseResponse(success)).toEqual(success);

    const failure = failureResponse("invalid_input", "\u0000bad   request");
    expect(failure).toEqual({
      contentItems: [
        { text: "Browser provider error [invalid_input]: bad request", type: "inputText" },
      ],
      error: "invalid_input: bad request",
      success: false,
    });

    const imagedFailure = failureResponse(
      "INVALID CODE",
      "x".repeat(1400),
      "data:image/png;base64,ZmFrZQ==",
    );
    expect(hasNativeImage(imagedFailure)).toBe(true);
    expect(imagedFailure.error).toMatch(/^provider_error: /);
    expect(imagedFailure.error?.length).toBeLessThanOrEqual(816);
    expect(encodedJsonBytes(imagedFailure)).toBeGreaterThan(0);
    expect(compactText("alpha\u007fbeta", 6)).toBe("alpha…");
  });

  it("rejects malformed visual response content", () => {
    expect(() =>
      parseComputerUseResponse({
        contentItems: [
          { imageUrl: "https://example.com/image.jpg", type: "inputImage" },
        ],
        success: true,
      }),
    ).toThrow();
    expect(() =>
      parseComputerUseResponse({
        contentItems: [
          { imageUrl: "data:image/jpeg;base64,ZmFrZQ==", type: "inputImage" },
        ],
        error: "unexpected",
        success: "yes",
      }),
    ).toThrow();
  });
});
