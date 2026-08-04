#!/usr/bin/env node

import { PACKAGE_NAME, PACKAGE_VERSION } from "./paths.js";

const args = process.argv.slice(2);

const CLIENT_ALIASES = new Map<string, string>([
  ["all", "all"],
  ["codex", "codex"],
  ["open-code", "opencode"],
  ["opencode", "opencode"],
  ["claude", "claude"],
  ["claude-code", "claude"],
  ["cursor", "cursor"],
]);

function rejectSecretArguments(values: string[]): void {
  const secretFlag = values.find((value) => {
    const normalized = value.toLowerCase();
    return normalized === "--gemini-key" ||
      normalized.startsWith("--gemini-key=") ||
      normalized === "--openai-key" ||
      normalized.startsWith("--openai-key=");
  });
  if (secretFlag) {
    throw new Error("API keys cannot be passed as command arguments. Use the hidden setup prompt or an environment variable instead.");
  }
}

async function main(): Promise<void> {
  rejectSecretArguments(args);

  const requestedCommand = args[0];
  const command = requestedCommand?.toLowerCase();
  if (!command || command === "serve") {
    const { startMcpServer } = await import("./index.js");
    await startMcpServer();
    return;
  }

  if (command === "--version" || command === "-v" || command === "version") {
    console.log(PACKAGE_VERSION);
    return;
  }

  const directClient = CLIENT_ALIASES.get(command);
  const { runSetupCli } = await import("./setup.js");
  if (directClient) {
    const setupArgs = directClient === "all" ? ["--all", ...args.slice(1)] : ["--client", directClient, ...args.slice(1)];
    await runSetupCli("setup", PACKAGE_VERSION, setupArgs);
    return;
  }

  await runSetupCli(command, PACKAGE_VERSION, args.slice(1));
}

main().catch((error: unknown) => {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const message = rawMessage
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/(?:AIza|sk-)[A-Za-z0-9_-]{8,}/gi, "[redacted-key]")
    .replace(/[\r\n\t]+/g, " ");
  process.stderr.write(`[${PACKAGE_NAME}] ${message}\n`);
  process.exitCode = 1;
});
