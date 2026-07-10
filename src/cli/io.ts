import { Buffer } from "node:buffer";

import { compactText, MAX_CALL_BYTES, type ComputerUseResponse } from "../contract/index.js";

export async function readStandardInput(): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    if (!Buffer.isBuffer(chunk)) {
      throw new Error("provider input stream returned a non-buffer chunk");
    }
    const bytes = Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > MAX_CALL_BYTES) {
      throw new Error("provider input exceeds the size limit");
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function writeMachineResponse(response: ComputerUseResponse): void {
  process.stdout.write(JSON.stringify(response));
}

export function writeOutputLine(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

export function writeDiagnostic(message: string): void {
  process.stderr.write(`${compactText(message, 800)}\n`);
}
