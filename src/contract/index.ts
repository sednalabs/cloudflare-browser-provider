import { z } from "zod";

export const MAX_CALL_BYTES = 1024 * 1024;
export const MAX_RESPONSE_BYTES = 1700 * 1024;
export const SUPPORTED_BACKENDS = ["auto", "browser"] as const;
export const SUPPORTED_TOOLS = ["browser_observe", "browser_step"] as const;

const jsonObjectSchema = z.record(z.string(), z.unknown());

export const computerUseCallSchema = z
  .object({
    threadId: z.string().trim().min(1).max(512),
    turnId: z.string().trim().min(1).max(512),
    callId: z.string().trim().min(1).max(512),
    environmentId: z.string().trim().min(1).max(512).nullable().optional(),
    adapter: z.literal("browser"),
    tool: z.enum(SUPPORTED_TOOLS),
    arguments: jsonObjectSchema,
  })
  .strict()
  .superRefine((call, context) => {
    const backend = call.arguments.backend;
    if (
      backend !== undefined &&
      (typeof backend !== "string" || !SUPPORTED_BACKENDS.includes(backend as never))
    ) {
      context.addIssue({
        code: "custom",
        message: "backend must be auto or browser",
        path: ["arguments", "backend"],
      });
    }

    if (call.tool === "browser_step") {
      const actions = call.arguments.actions;
      const hasBatch = Array.isArray(actions) && actions.length > 0;
      const hasSingle =
        typeof call.arguments.action === "string" || typeof call.arguments.type === "string";
      if (!hasBatch && !hasSingle) {
        context.addIssue({
          code: "custom",
          message: "browser_step requires an action or non-empty actions array",
          path: ["arguments"],
        });
      }
    }
  });

const inputTextSchema = z
  .object({
    type: z.literal("inputText"),
    text: z.string().max(128 * 1024),
  })
  .strict();

const inputImageSchema = z
  .object({
    type: z.literal("inputImage"),
    imageUrl: z
      .string()
      .max(1400 * 1024)
      .refine((value) => /^data:image\/(?:jpeg|png);base64,[A-Za-z0-9+/=]+$/.test(value), {
        message: "imageUrl must be an inline JPEG or PNG data URL",
      }),
    detail: z.enum(["auto", "low", "high", "original"]).optional(),
  })
  .strict();

export const computerUseResponseSchema = z
  .object({
    contentItems: z.array(z.discriminatedUnion("type", [inputTextSchema, inputImageSchema])).max(8),
    success: z.boolean(),
    error: z.string().max(2048).optional(),
  })
  .strict();

export const providerEnvelopeSchema = z
  .object({
    protocolVersion: z.literal(1),
    call: computerUseCallSchema,
  })
  .strict();

export const purgeRequestSchema = z
  .object({
    threadId: z.string().trim().min(1).max(512),
    environmentId: z.string().trim().min(1).max(512).nullable().optional(),
  })
  .strict();

export type ComputerUseCall = z.infer<typeof computerUseCallSchema>;
export type ComputerUseResponse = z.infer<typeof computerUseResponseSchema>;
export type ComputerUseContentItem = ComputerUseResponse["contentItems"][number];
export type ProviderEnvelope = z.infer<typeof providerEnvelopeSchema>;
export type PurgeRequest = z.infer<typeof purgeRequestSchema>;

export function parseComputerUseCall(value: unknown): ComputerUseCall {
  return computerUseCallSchema.parse(value);
}

export function parseComputerUseResponse(value: unknown): ComputerUseResponse {
  const response = computerUseResponseSchema.parse(value);
  if (response.success && !hasNativeImage(response)) {
    throw new Error("successful provider response is missing native image content");
  }
  return response;
}

export function hasNativeImage(response: ComputerUseResponse): boolean {
  return response.contentItems.some((item) => item.type === "inputImage");
}

export function successResponse(text: string, imageUrl: string): ComputerUseResponse {
  return {
    contentItems: [
      { type: "inputText", text },
      { type: "inputImage", imageUrl, detail: "high" },
    ],
    success: true,
  };
}

export function failureResponse(
  code: string,
  message: string,
  imageUrl?: string,
): ComputerUseResponse {
  const text = `Browser provider error [${safeCode(code)}]: ${compactText(message, 1200)}`;
  const contentItems: ComputerUseContentItem[] = [{ type: "inputText", text }];
  if (imageUrl !== undefined) {
    contentItems.push({ type: "inputImage", imageUrl, detail: "high" });
  }
  return { contentItems, success: false, error: `${safeCode(code)}: ${compactText(message, 800)}` };
}

export function encodedJsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export function compactText(value: string, maxLength: number): string {
  const compact = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return compact.length <= maxLength ? compact : `${compact.slice(0, Math.max(0, maxLength - 1))}…`;
}

function safeCode(value: string): string {
  return /^[a-z][a-z0-9_]{1,63}$/.test(value) ? value : "provider_error";
}
