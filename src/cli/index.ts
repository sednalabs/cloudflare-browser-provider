#!/usr/bin/env node

import {
  failureResponse,
  parseComputerUseCall,
  purgeRequestSchema,
  type ComputerUseResponse,
} from "../contract/index.js";
import { PROVIDER_NAME, PROVIDER_PROTOCOL_VERSION, PROVIDER_VERSION } from "../version.js";
import { readStandardInput, writeDiagnostic, writeMachineResponse, writeOutputLine } from "./io.js";
import {
  invokeProvider,
  providerClientConfig,
  providerHealth,
  providerLimits,
  purgeProviderSession,
} from "./provider-client.js";

export async function run(argv: string[] = process.argv.slice(2)): Promise<number> {
  const command = argv[0] ?? "stdio";
  switch (command) {
    case "stdio":
      return runStdio();
    case "health":
      return runDiagnostic(async () => providerHealth(providerClientConfig()));
    case "limits":
      return runDiagnostic(async () => providerLimits(providerClientConfig()));
    case "purge":
      return runPurge(argv.slice(1));
    case "version":
    case "--version":
    case "-v":
      writeOutputLine({
        name: PROVIDER_NAME,
        protocolVersion: PROVIDER_PROTOCOL_VERSION,
        version: PROVIDER_VERSION,
      });
      return 0;
    default:
      writeDiagnostic("Usage: cloudflare-browser-provider [stdio|health|limits|purge|version]");
      return 64;
  }
}

async function runStdio(): Promise<number> {
  let response: ComputerUseResponse;
  try {
    const call = parseComputerUseCall(JSON.parse(await readStandardInput()));
    response = await invokeProvider(call, providerClientConfig());
  } catch {
    response = failureResponse("invalid_input", "The stdio provider request was invalid or misconfigured.");
  }
  writeMachineResponse(response);
  return 0;
}

async function runDiagnostic(operation: () => Promise<unknown>): Promise<number> {
  try {
    writeOutputLine(await operation());
    return 0;
  } catch (error) {
    writeDiagnostic(error instanceof Error ? error.message : "provider diagnostic failed");
    return 1;
  }
}

async function runPurge(argumentsValue: string[]): Promise<number> {
  const threadIndex = argumentsValue.indexOf("--thread-id");
  const environmentIndex = argumentsValue.indexOf("--environment-id");
  try {
    const identity = purgeRequestSchema.parse({
      environmentId: environmentIndex >= 0 ? argumentsValue[environmentIndex + 1] : undefined,
      threadId: threadIndex >= 0 ? argumentsValue[threadIndex + 1] : undefined,
    });
    writeOutputLine(await purgeProviderSession(identity, providerClientConfig()));
    return 0;
  } catch {
    writeDiagnostic("purge requires --thread-id and valid provider configuration");
    return 64;
  }
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  void run().then((code) => {
    process.exitCode = code;
  });
}
