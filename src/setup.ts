import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { platform } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { parse as parseDotenv } from "dotenv";
import {
  applyEdits,
  modify,
  parse as parseJsonc,
  printParseErrorCode,
  type FormattingOptions,
  type JSONPath,
  type ParseError,
} from "jsonc-parser";
import {
  getManagedRuntimeDirectory,
  getOmniDataDirectory,
  getOmniEnvironmentFile,
  getSetupHome,
  PACKAGE_NAME,
} from "./paths.js";

export type ClientName = "codex" | "opencode" | "claude" | "cursor";
type ScopeName = "user" | "project";
type ProviderName = "ocr" | "gemini" | "openai" | "both";

interface CliOptions {
  clients: ClientName[];
  scope: ScopeName;
  yes: boolean;
  provider: ProviderName;
  providerExplicit: boolean;
}

interface CommandResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
}

interface CommandInvocation {
  command: string;
  args: string[];
}

interface JsonDocument {
  path: string;
  value: Record<string, unknown>;
  raw: string;
  originalRaw: string;
  originalContentRaw: string;
  existed: boolean;
  bom: boolean;
  formatting: FormattingOptions;
}

interface RuntimeCommand {
  command: string;
  args: string[];
  entry: string;
}

interface RuntimeInspection {
  valid: boolean;
  detail: string;
  runtime: RuntimeCommand;
}

interface ProviderEnvironmentResult {
  provider: ProviderName;
  path: string | null;
  changed: boolean;
}

interface EntryInspection {
  exists: boolean;
  owned: boolean;
  detail: string;
}

const SERVER_NAME = PACKAGE_NAME;
const CLIENTS: ClientName[] = ["codex", "opencode", "claude", "cursor"];
const JSON_FORMAT_DEFAULTS: FormattingOptions = {
  insertSpaces: true,
  tabSize: 2,
  eol: "\n",
  insertFinalNewline: true,
};

function commandEnvironment(command: string): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  if (!process.env.OMNI_SETUP_HOME?.trim()) return environment;

  // OMNI_SETUP_HOME is a hard isolation boundary for installer tests and
  // managed deployments. Keep CLIs away from the real user's configuration.
  const executable = basename(command).toLowerCase().replace(/\.(?:cmd|exe|ps1)$/u, "");
  if (executable === "codex" && !environment.CODEX_HOME?.trim()) {
    environment.CODEX_HOME = join(getSetupHome(), ".codex");
  }
  if (executable === "claude" && !environment.CLAUDE_CONFIG_DIR?.trim()) {
    environment.CLAUDE_CONFIG_DIR = getSetupHome();
  }
  return environment;
}

function resolveExecutableOnPath(name: string): string | null {
  const lookup = spawnSync(platform() === "win32" ? "where.exe" : "which", [name], {
    env: process.env,
    encoding: "utf8",
    windowsHide: true,
  });
  if (lookup.status !== 0) return null;
  const candidates = lookup.stdout.split(/\r?\n/u).map((item) => item.trim()).filter(Boolean);
  if (platform() !== "win32") return candidates[0] ?? null;
  // `where` commonly returns extensionless POSIX shims first. Prefer native
  // executables or Windows command shims that can actually run on Windows.
  return candidates.find((item) => /\.(?:exe|com|cmd|bat|ps1)$/iu.test(item)) ?? candidates[0] ?? null;
}

function executableInvocation(command: string, args: string[]): CommandInvocation {
  if (platform() !== "win32") return { command, args };
  const resolved = resolveExecutableOnPath(command);
  if (!resolved || !/\.(?:cmd|bat|ps1)$/iu.test(resolved)) return { command, args };

  // Node cannot spawn Windows command shims directly with shell:false. A
  // fixed PowerShell wrapper preserves argument boundaries without composing
  // user-controlled strings into a shell command.
  const powershell = resolveExecutableOnPath("powershell.exe") ?? "powershell.exe";
  const script = "& { param([string]$Executable, [string]$ArgumentsBase64) $ArgumentsJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($ArgumentsBase64)); $ForwardedArgs = @(ConvertFrom-Json -InputObject $ArgumentsJson); & $Executable @ForwardedArgs; exit $LASTEXITCODE }";
  const encodedArgs = Buffer.from(JSON.stringify(args), "utf8").toString("base64");
  return {
    command: powershell,
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script, resolved, encodedArgs],
  };
}

function executableExists(name: string): boolean {
  return resolveExecutableOnPath(name) !== null;
}

function packageReference(version: string): string {
  return `${SERVER_NAME}@${version}`;
}

function npmInvocation(): { command: string; leadingArgs: string[] } {
  if (platform() !== "win32") return { command: "npm", leadingArgs: [] };
  // Recent Node releases do not spawn .cmd shims with shell:false. Invoke
  // npm's JavaScript entry directly, preserving shell-free argument handling.
  const npmCli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  return existsSync(npmCli)
    ? { command: process.execPath, leadingArgs: [npmCli] }
    : { command: "npm", leadingArgs: [] };
}

function runCommand(command: string, args: string[], timeoutMs = 120_000): Promise<CommandResult> {
  return new Promise((resolvePromise) => {
    const invocation = executableInvocation(command, args);
    const child = spawn(invocation.command, invocation.args, {
      env: commandEnvironment(command),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const finish = (result: CommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(result);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", (error) => {
      finish({ ok: false, code: null, stdout: stdout.trim(), stderr: `${stderr}${error.message}`.trim() });
    });
    child.once("exit", (code) => {
      if (timedOut) stderr += `${stderr ? "\n" : ""}Command timed out after ${timeoutMs}ms.`;
      finish({ ok: code === 0 && !timedOut, code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

function sanitizeCommandError(result: CommandResult): string {
  const message = result.stderr || result.stdout || `exit code ${result.code ?? "unknown"}`;
  return message
    .replace(/[\r\n\t]+/gu, " ")
    .replace(/(?:AIza|sk-)[A-Za-z0-9_-]{8,}/gu, "[redacted-key]")
    .slice(0, 300);
}

function normalizeClientAlias(value: string): ClientName | "all" | null {
  const normalized = value.trim().toLowerCase().replace(/[ _]+/gu, "-");
  const aliases: Record<string, ClientName | "all"> = {
    all: "all",
    codex: "codex",
    opencode: "opencode",
    "open-code": "opencode",
    claude: "claude",
    "claude-code": "claude",
    cursor: "cursor",
  };
  return aliases[normalized] ?? null;
}

function parseClients(value: string): ClientName[] {
  if (!value.trim()) throw new Error("A client name is required.");
  const requested = value.split(",").map((item) => item.trim()).filter(Boolean);
  const parsed = requested.map((item) => {
    const client = normalizeClientAlias(item);
    if (!client) throw new Error(`Unknown client '${item}'. Use: ${CLIENTS.join(", ")}, claude-code, or all.`);
    return client;
  });
  if (parsed.includes("all")) {
    if (parsed.length > 1) throw new Error("Use 'all' by itself, not together with individual clients.");
    return [...CLIENTS];
  }
  return parsed as ClientName[];
}

function parseProvider(value: string): ProviderName {
  const provider = value.trim().toLowerCase();
  if (provider === "ocr" || provider === "tesseract" || provider === "local") return "ocr";
  if (provider === "gemini" || provider === "openai" || provider === "both") return provider;
  throw new Error("Provider must be ocr, gemini, openai, or both.");
}

function nextOptionValue(args: string[], index: number, option: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("-")) throw new Error(`${option} needs a value.`);
  return value;
}

function parseOptions(args: string[]): CliOptions {
  const options: CliOptions = {
    clients: [],
    scope: "user",
    yes: false,
    provider: "ocr",
    providerExplicit: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--yes" || arg === "-y") options.yes = true;
    else if (arg === "--project") options.scope = "project";
    else if (arg === "--user" || arg === "--global") options.scope = "user";
    else if (arg === "--client" || arg === "--clients") {
      options.clients.push(...parseClients(nextOptionValue(args, index, arg)));
      index += 1;
    } else if (arg.startsWith("--client=")) options.clients.push(...parseClients(arg.slice("--client=".length)));
    else if (arg.startsWith("--clients=")) options.clients.push(...parseClients(arg.slice("--clients=".length)));
    else if (arg === "--provider") {
      options.provider = parseProvider(nextOptionValue(args, index, arg));
      options.providerExplicit = true;
      index += 1;
    } else if (arg.startsWith("--provider=")) {
      options.provider = parseProvider(arg.slice("--provider=".length));
      options.providerExplicit = true;
    } else if (arg === "--all") options.clients = [...CLIENTS];
    else if (arg === "--gemini-key" || arg === "--openai-key" || arg.startsWith("--gemini-key=") || arg.startsWith("--openai-key=")) {
      throw new Error("API keys are not accepted as command arguments because shell history can expose them. Use an environment variable or the hidden setup prompt.");
    } else if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
    else options.clients.push(...parseClients(arg));
  }

  options.clients = [...new Set(options.clients)];
  return options;
}

function inferJsonFormatting(raw: string): FormattingOptions {
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const indentation = raw.match(/^[\t ]+(?=\S)/mu)?.[0];
  if (!indentation) return { ...JSON_FORMAT_DEFAULTS, eol };
  return indentation.includes("\t")
    ? { insertSpaces: false, tabSize: 1, eol, insertFinalNewline: true }
    : { insertSpaces: true, tabSize: indentation.length, eol, insertFinalNewline: true };
}

function parseJsonObject(raw: string, path: string): Record<string, unknown> {
  const errors: ParseError[] = [];
  const parsed = parseJsonc(raw, errors, {
    allowEmptyContent: true,
    allowTrailingComma: true,
    disallowComments: false,
  }) as unknown;
  if (errors.length > 0) {
    const first = errors[0];
    const reason = first ? `${printParseErrorCode(first.error)} at character ${first.offset}` : "unknown parse error";
    throw new Error(`Cannot safely update ${path}: invalid JSON/JSONC (${reason}).`);
  }
  if (parsed === undefined && !raw.trim()) return {};
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Cannot safely update ${path}: the root must be an object.`);
  }
  return parsed as Record<string, unknown>;
}

async function readJsonDocument(path: string): Promise<JsonDocument> {
  const existed = existsSync(path);
  const originalRaw = existed ? await readFile(path, "utf8") : "";
  const bom = originalRaw.startsWith("\uFEFF");
  const originalContentRaw = bom ? originalRaw.slice(1) : originalRaw;
  const raw = originalContentRaw.trim() ? originalContentRaw : `{}${inferJsonFormatting(originalContentRaw).eol}`;
  return {
    path,
    value: parseJsonObject(raw, path),
    raw,
    originalRaw,
    originalContentRaw,
    existed,
    bom,
    formatting: inferJsonFormatting(originalContentRaw || raw),
  };
}

function updateJsonValue(document: JsonDocument, path: JSONPath, value: unknown): void {
  const edits = modify(document.raw, path, value, { formattingOptions: document.formatting });
  document.raw = applyEdits(document.raw, edits);
  document.value = parseJsonObject(document.raw, document.path);
}

async function writeJsonDocument(document: JsonDocument): Promise<string | null> {
  if (document.raw === document.originalContentRaw) return null;
  await mkdir(dirname(document.path), { recursive: true });
  let backup: string | null = null;
  if (document.existed) {
    backup = `${document.path}.backup-${new Date().toISOString().replace(/[:.]/gu, "-")}-${process.pid}`;
    await writeFile(backup, document.originalRaw, { encoding: "utf8", mode: 0o600 });
  }

  const temporary = `${document.path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, `${document.bom ? "\uFEFF" : ""}${document.raw}`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, document.path);
    if (platform() !== "win32") await chmod(document.path, 0o600);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
  return backup;
}

function objectAt(parent: Record<string, unknown>, key: string, path: string): Record<string, unknown> | null {
  const current = parent[key];
  if (current === undefined) return null;
  if (!current || typeof current !== "object" || Array.isArray(current)) {
    throw new Error(`Cannot safely update ${path}: '${key}' must be an object.`);
  }
  return current as Record<string, unknown>;
}

function normalizedPath(path: string): string {
  const normalized = resolve(path).replace(/[\\/]+$/u, "");
  return platform() === "win32" ? normalized.toLowerCase() : normalized;
}

function samePath(left: string, right: string): boolean {
  return normalizedPath(left) === normalizedPath(right);
}

function isPathWithin(path: string, parent: string): boolean {
  const childPath = normalizedPath(path);
  const parentPath = normalizedPath(parent);
  const difference = relative(parentPath, childPath);
  return difference === "" || (!difference.startsWith("..") && !isAbsolute(difference));
}

function isManagedRuntimeEntry(entry: string): boolean {
  if (!isPathWithin(entry, join(getOmniDataDirectory(), "runtimes"))) return false;
  const segments = relative(join(getOmniDataDirectory(), "runtimes"), resolve(entry)).split(/[\\/]/u);
  if (segments.length !== 5) return false;
  const comparable = platform() === "win32" ? segments.map((segment) => segment.toLowerCase()) : segments;
  return comparable[1] === "node_modules"
    && comparable[2] === SERVER_NAME
    && comparable[3] === "dist"
    && comparable[4] === "cli.js";
}

function executableStem(command: string): string {
  return basename(command).toLowerCase().replace(/\.(?:cmd|exe|ps1)$/u, "");
}

function isOwnedInvocation(command: unknown, args: unknown, runtime?: RuntimeCommand): boolean {
  if (typeof command !== "string" || !Array.isArray(args) || !args.every((arg) => typeof arg === "string")) return false;
  const stringArgs = args as string[];

  if (runtime && samePath(command, runtime.command) && stringArgs.length === runtime.args.length
    && stringArgs.every((arg, index) => index === 0 ? samePath(arg, runtime.args[index] ?? "") : arg === runtime.args[index])) {
    return true;
  }

  const stem = executableStem(command);
  if (stem === "node" && stringArgs.length === 2 && stringArgs[1] === "serve" && isManagedRuntimeEntry(stringArgs[0] ?? "")) return true;
  if (stem === SERVER_NAME && (stringArgs.length === 0 || (stringArgs.length === 1 && stringArgs[0] === "serve"))) return true;
  if (stem === "npx") {
    const meaningful = stringArgs.filter((arg) => arg !== "-y" && arg !== "--yes");
    const packageToken = meaningful[0] ?? "";
    const versionedPackage = packageToken.startsWith(`${SERVER_NAME}@`)
      && packageToken.length > SERVER_NAME.length + 1
      && !/[\\/\s]/u.test(packageToken.slice(SERVER_NAME.length + 1));
    const isPackageToken = packageToken === SERVER_NAME || versionedPackage;
    return isPackageToken && meaningful.slice(1).every((arg) => arg === "serve");
  }
  return false;
}

function jsonEntryIsOwned(client: "opencode" | "cursor" | "claude", entry: unknown, runtime?: RuntimeCommand): boolean {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  const record = entry as Record<string, unknown>;
  if (client === "opencode") {
    const command = record.command;
    return Array.isArray(command) && command.length > 0
      && isOwnedInvocation(command[0], command.slice(1), runtime);
  }
  return isOwnedInvocation(record.command, record.args ?? [], runtime);
}

function collisionError(client: ClientName, path?: string): Error {
  return new Error(`${formatClients([client])} already has a '${SERVER_NAME}' entry that is not managed by this installer${path ? ` in ${path}` : ""}. It was left unchanged; rename or remove that entry manually, then run setup again.`);
}

function openCodeConfigPath(scope: ScopeName): string {
  if (scope === "project") {
    const jsonc = resolve(process.cwd(), "opencode.jsonc");
    return existsSync(jsonc) ? jsonc : resolve(process.cwd(), "opencode.json");
  }
  const isolated = process.env.OMNI_SETUP_HOME?.trim();
  const configHome = !isolated && process.env.XDG_CONFIG_HOME?.trim()
    ? resolve(process.env.XDG_CONFIG_HOME)
    : join(getSetupHome(), ".config");
  return join(configHome, "opencode", "opencode.json");
}

function cursorConfigPath(scope: ScopeName): string {
  return scope === "project"
    ? resolve(process.cwd(), ".cursor", "mcp.json")
    : join(getSetupHome(), ".cursor", "mcp.json");
}

async function inspectJsonEntry(
  client: "opencode" | "cursor" | "claude",
  path: string,
  containerKey: "mcp" | "mcpServers",
  runtime?: RuntimeCommand,
): Promise<EntryInspection> {
  if (!existsSync(path)) return { exists: false, owned: false, detail: `config not found: ${path}` };
  const document = await readJsonDocument(path);
  const container = objectAt(document.value, containerKey, path);
  if (!container || !(SERVER_NAME in container)) return { exists: false, owned: false, detail: `entry missing in ${path}` };
  const owned = jsonEntryIsOwned(client, container[SERVER_NAME], runtime);
  return { exists: true, owned, detail: owned ? path : `foreign same-name entry in ${path}` };
}

async function mergeOpenCode(runtime: RuntimeCommand, scope: ScopeName): Promise<string> {
  const document = await readJsonDocument(openCodeConfigPath(scope));
  const mcp = objectAt(document.value, "mcp", document.path);
  if (mcp && SERVER_NAME in mcp && !jsonEntryIsOwned("opencode", mcp[SERVER_NAME], runtime)) {
    throw collisionError("opencode", document.path);
  }
  if (!("$schema" in document.value)) updateJsonValue(document, ["$schema"], "https://opencode.ai/config.json");
  updateJsonValue(document, ["mcp", SERVER_NAME], {
    type: "local",
    command: [runtime.command, ...runtime.args],
    enabled: true,
    timeout: 600000,
  });
  const backup = await writeJsonDocument(document);
  return `${document.path}${backup ? ` (backup: ${basename(backup)})` : document.existed ? " (already current)" : ""}`;
}

async function mergeCursor(runtime: RuntimeCommand, scope: ScopeName): Promise<string> {
  const document = await readJsonDocument(cursorConfigPath(scope));
  const servers = objectAt(document.value, "mcpServers", document.path);
  if (servers && SERVER_NAME in servers && !jsonEntryIsOwned("cursor", servers[SERVER_NAME], runtime)) {
    throw collisionError("cursor", document.path);
  }
  updateJsonValue(document, ["mcpServers", SERVER_NAME], {
    type: "stdio",
    command: runtime.command,
    args: runtime.args,
  });
  const backup = await writeJsonDocument(document);
  return `${document.path}${backup ? ` (backup: ${basename(backup)})` : document.existed ? " (already current)" : ""}`;
}

async function removeJsonEntry(
  client: "opencode" | "cursor" | "claude",
  path: string,
  containerKey: "mcp" | "mcpServers",
): Promise<boolean> {
  if (!existsSync(path)) return false;
  const document = await readJsonDocument(path);
  const container = objectAt(document.value, containerKey, path);
  if (!container || !(SERVER_NAME in container)) return false;
  if (!jsonEntryIsOwned(client, container[SERVER_NAME])) throw collisionError(client, path);
  updateJsonValue(document, [containerKey, SERVER_NAME], undefined);
  await writeJsonDocument(document);
  return true;
}

function parseCodexInvocation(raw: string): { command: unknown; args: unknown } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Codex returned an unreadable MCP configuration; no changes were made.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Codex returned an unexpected MCP configuration; no changes were made.");
  }
  const record = parsed as Record<string, unknown>;
  const transport = record.transport && typeof record.transport === "object" && !Array.isArray(record.transport)
    ? record.transport as Record<string, unknown>
    : record;
  return { command: transport.command, args: transport.args ?? [] };
}

async function inspectCodexEntry(runtime?: RuntimeCommand): Promise<EntryInspection> {
  if (!executableExists("codex")) return { exists: false, owned: false, detail: "CLI not installed" };
  const result = await runCommand("codex", ["mcp", "get", SERVER_NAME, "--json"], 30_000);
  if (!result.ok) {
    const message = `${result.stdout} ${result.stderr}`;
    if (/no mcp server|not found|does not exist|not configured/iu.test(message)) {
      return { exists: false, owned: false, detail: "entry not configured" };
    }
    throw new Error(`Could not inspect the existing Codex entry safely: ${sanitizeCommandError(result)}`);
  }
  const invocation = parseCodexInvocation(result.stdout);
  const owned = isOwnedInvocation(invocation.command, invocation.args, runtime);
  return { exists: true, owned, detail: owned ? "configured" : "foreign same-name entry" };
}

function claudeConfigPath(scope: ScopeName): string {
  if (scope === "project") return resolve(process.cwd(), ".mcp.json");
  const configuredDirectory = process.env.CLAUDE_CONFIG_DIR?.trim();
  return join(configuredDirectory ? resolve(configuredDirectory) : getSetupHome(), ".claude.json");
}

async function inspectClaudeConfigFile(scope: ScopeName, runtime?: RuntimeCommand): Promise<EntryInspection> {
  const path = claudeConfigPath(scope);
  return inspectJsonEntry("claude", path, "mcpServers", runtime);
}

async function configureCodex(runtime: RuntimeCommand): Promise<string> {
  if (!executableExists("codex")) throw new Error("Codex CLI was not found.");
  const existing = await inspectCodexEntry(runtime);
  if (existing.exists && !existing.owned) throw collisionError("codex");
  if (existing.exists) {
    const removed = await runCommand("codex", ["mcp", "remove", SERVER_NAME], 30_000);
    if (!removed.ok) throw new Error(`Could not replace the existing managed Codex entry: ${sanitizeCommandError(removed)}`);
  }
  const result = await runCommand("codex", ["mcp", "add", SERVER_NAME, "--", runtime.command, ...runtime.args]);
  if (!result.ok) throw new Error(sanitizeCommandError(result));
  return "user-wide Codex configuration";
}

async function configureClaude(runtime: RuntimeCommand, scope: ScopeName): Promise<string> {
  if (!executableExists("claude")) throw new Error("Claude Code CLI was not found.");
  const existing = await inspectClaudeConfigFile(scope, runtime);
  if (existing.exists && !existing.owned) throw collisionError("claude");
  const claudeScope = scope === "user" ? "user" : "project";
  if (existing.exists) {
    const removed = await runCommand("claude", ["mcp", "remove", "--scope", claudeScope, SERVER_NAME], 30_000);
    if (!removed.ok) throw new Error(`Could not replace the existing managed Claude Code entry: ${sanitizeCommandError(removed)}`);
  }
  const result = await runCommand("claude", [
    "mcp", "add", "--scope", claudeScope, "--transport", "stdio", SERVER_NAME,
    "--", runtime.command, ...runtime.args,
  ]);
  if (!result.ok) throw new Error(sanitizeCommandError(result));
  return `${claudeScope}-scoped Claude Code configuration`;
}

async function configureClient(client: ClientName, runtime: RuntimeCommand, scope: ScopeName): Promise<string> {
  if (client === "codex") {
    if (scope === "project") throw new Error("Codex project setup is manual; use user setup or the README's project configuration.");
    return configureCodex(runtime);
  }
  if (client === "claude") return configureClaude(runtime, scope);
  if (client === "opencode") return mergeOpenCode(runtime, scope);
  return mergeCursor(runtime, scope);
}

async function removeClient(client: ClientName, scope: ScopeName): Promise<boolean> {
  if (client === "codex") {
    if (!executableExists("codex")) return false;
    const existing = await inspectCodexEntry();
    if (!existing.exists) return false;
    if (!existing.owned) throw collisionError("codex");
    const removed = await runCommand("codex", ["mcp", "remove", SERVER_NAME], 30_000);
    if (!removed.ok) throw new Error(sanitizeCommandError(removed));
    return true;
  }
  if (client === "claude") {
    if (!executableExists("claude")) return false;
    const existing = await inspectClaudeConfigFile(scope);
    if (!existing.exists) return false;
    if (!existing.owned) throw collisionError("claude", existing.detail);
    const removed = await runCommand("claude", ["mcp", "remove", "--scope", scope === "user" ? "user" : "project", SERVER_NAME], 30_000);
    if (!removed.ok) throw new Error(sanitizeCommandError(removed));
    return true;
  }
  if (client === "opencode") return removeJsonEntry("opencode", openCodeConfigPath(scope), "mcp");
  return removeJsonEntry("cursor", cursorConfigPath(scope), "mcpServers");
}

function detectClients(): ClientName[] {
  const detected: ClientName[] = [];
  if (executableExists("codex") || existsSync(join(getSetupHome(), ".codex"))) detected.push("codex");
  if (executableExists("opencode") || existsSync(dirname(openCodeConfigPath("user")))) detected.push("opencode");
  if (executableExists("claude") || existsSync(join(getSetupHome(), ".claude.json"))) detected.push("claude");
  if (executableExists("cursor") || existsSync(join(getSetupHome(), ".cursor"))) detected.push("cursor");
  return detected;
}

function runtimeForDirectory(directory: string): RuntimeCommand {
  const entry = join(directory, "node_modules", SERVER_NAME, "dist", "cli.js");
  return { command: process.execPath, args: [entry, "serve"], entry };
}

async function inspectRuntimeDirectory(directory: string, version: string): Promise<RuntimeInspection> {
  const runtime = runtimeForDirectory(directory);
  const packageJsonPath = join(directory, "node_modules", SERVER_NAME, "package.json");
  if (!existsSync(runtime.entry) || !existsSync(packageJsonPath)) {
    return { valid: false, detail: "private runtime is not installed", runtime };
  }
  try {
    const installed = JSON.parse(await readFile(packageJsonPath, "utf8")) as { name?: string; version?: string };
    if (installed.name !== SERVER_NAME) return { valid: false, detail: "private runtime contains the wrong package", runtime };
    if (installed.version !== version) {
      return { valid: false, detail: `private runtime version is ${installed.version ?? "unknown"}, expected ${version}`, runtime };
    }
    return { valid: true, detail: runtime.entry, runtime };
  } catch (error) {
    return {
      valid: false,
      detail: `private runtime metadata is unreadable (${error instanceof Error ? error.message : String(error)})`,
      runtime,
    };
  }
}

async function inspectManagedRuntime(version: string): Promise<RuntimeInspection> {
  return inspectRuntimeDirectory(getManagedRuntimeDirectory(version), version);
}

async function ensureManagedRuntime(version: string): Promise<RuntimeCommand> {
  const runtimeDirectory = getManagedRuntimeDirectory(version);
  const existing = await inspectRuntimeDirectory(runtimeDirectory, version);
  if (existing.valid) return existing.runtime;

  const parent = dirname(runtimeDirectory);
  await mkdir(parent, { recursive: true });
  const stagingDirectory = join(parent, `.${basename(runtimeDirectory)}.staging-${process.pid}-${randomUUID()}`);
  const displacedDirectory = join(parent, `.${basename(runtimeDirectory)}.replaced-${process.pid}-${randomUUID()}`);
  const packageSpec = process.env.OMNI_RUNTIME_PACKAGE_SPEC?.trim() || packageReference(version);
  let displaced = false;
  let promoted = false;

  try {
    await mkdir(stagingDirectory, { recursive: false });
    const npm = npmInvocation();
    const result = await runCommand(npm.command, [...npm.leadingArgs,
      "install", "--prefix", stagingDirectory, "--omit=dev", "--no-audit", "--no-fund",
      "--save-exact", packageSpec,
    ], 300_000);
    if (!result.ok) throw new Error(`Could not install the private runtime: ${sanitizeCommandError(result)}`);

    const staged = await inspectRuntimeDirectory(stagingDirectory, version);
    if (!staged.valid) throw new Error(`The staged private runtime is invalid: ${staged.detail}.`);

    // Another setup process may have completed while npm was running.
    const concurrent = await inspectRuntimeDirectory(runtimeDirectory, version);
    if (concurrent.valid) return concurrent.runtime;

    if (existsSync(runtimeDirectory)) {
      try {
        await rename(runtimeDirectory, displacedDirectory);
      } catch (error) {
        const wonRace = await inspectRuntimeDirectory(runtimeDirectory, version);
        if (wonRace.valid) return wonRace.runtime;
        throw error;
      }
      displaced = true;
    }
    try {
      await rename(stagingDirectory, runtimeDirectory);
      promoted = true;
    } catch (error) {
      if (displaced && !existsSync(runtimeDirectory) && existsSync(displacedDirectory)) {
        await rename(displacedDirectory, runtimeDirectory).catch(() => undefined);
        displaced = false;
      }
      throw error;
    }

    const installed = await inspectRuntimeDirectory(runtimeDirectory, version);
    if (!installed.valid) {
      await rm(runtimeDirectory, { recursive: true, force: true }).catch(() => undefined);
      promoted = false;
      if (displaced && existsSync(displacedDirectory)) {
        await rename(displacedDirectory, runtimeDirectory).catch(() => undefined);
        displaced = false;
      }
      throw new Error(`The promoted private runtime is invalid: ${installed.detail}.`);
    }
    return installed.runtime;
  } finally {
    if (!promoted) await rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
    if (displaced && promoted) await rm(displacedDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

function formatClients(clients: ClientName[]): string {
  const labels: Record<ClientName, string> = {
    codex: "Codex",
    opencode: "OpenCode",
    claude: "Claude Code",
    cursor: "Cursor",
  };
  return clients.map((client) => labels[client]).join(", ");
}

async function chooseClients(options: CliOptions): Promise<ClientName[]> {
  if (options.clients.length > 0) return options.clients;
  const detected = detectClients();
  if (options.yes || !input.isTTY || !output.isTTY) return detected;
  const rl = createInterface({ input, output });
  try {
    const defaultValue = detected.length > 0 ? detected.join(",") : "all";
    const answer = await rl.question(`Clients to set up [${defaultValue}]: `);
    return parseClients(answer.trim() || defaultValue);
  } finally {
    rl.close();
  }
}

async function readMasked(question: string): Promise<string> {
  if (!input.isTTY || !output.isTTY) return "";
  return new Promise((resolvePromise) => {
    output.write(question);
    input.resume();
    input.setRawMode?.(true);
    let value = "";
    let completed = false;
    const finish = (): void => {
      if (completed) return;
      completed = true;
      input.off("data", onData);
      input.setRawMode?.(false);
      input.pause();
      output.write("\n");
      resolvePromise(value.trim());
    };
    const onData = (chunk: Buffer): void => {
      for (const char of chunk.toString()) {
        if (char === "\r" || char === "\n") { finish(); return; }
        if (char === "\u0003") { process.exitCode = 130; finish(); return; }
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else value += char;
      }
    };
    input.on("data", onData);
  });
}

async function chooseProvider(options: CliOptions): Promise<ProviderName> {
  if (options.providerExplicit || options.yes || !input.isTTY || !output.isTTY) return options.provider;
  const rl = createInterface({ input, output });
  try {
    const answer = (await rl.question("Vision mode: [1] Free OCR, [2] Gemini, [3] OpenAI, [4] Both (default 1): ")).trim();
    return ({ "2": "gemini", "3": "openai", "4": "both" } as const)[answer] ?? "ocr";
  } finally {
    rl.close();
  }
}

function escapeEnvValue(value: string): string {
  return JSON.stringify(value).replace(/\\u2028|\\u2029/gu, "");
}

function setEnvValue(raw: string, key: "GEMINI_API_KEY" | "OPENAI_API_KEY" | "OMNI_VISION_PROVIDER", value: string): string {
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const replacement = `${key}=${escapeEnvValue(value)}`;
  const lines = raw ? raw.split(/\r?\n/u) : [];
  const expression = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`, "u");
  let replaced = false;
  const updated = lines.filter((line) => {
    if (!expression.test(line)) return true;
    if (!replaced) {
      replaced = true;
      return true;
    }
    return false;
  }).map((line) => {
    if (!expression.test(line)) return line;
    return replacement;
  });
  if (!replaced) {
    while (updated.length > 0 && updated[updated.length - 1] === "") updated.pop();
    updated.push(replacement, "");
  }
  return updated.join(eol);
}

async function writeProviderEnvironment(options: CliOptions): Promise<ProviderEnvironmentResult> {
  const provider = await chooseProvider(options);
  const path = getOmniEnvironmentFile();

  const existed = existsSync(path);
  const original = existed ? await readFile(path, "utf8") : "";
  let raw = existed ? original : [
    "# Private settings for omni-vision-pro. Created by the setup command.",
    "# Existing process/client environment variables still take priority.",
    "",
  ].join("\n");
  let values: Record<string, string> = {};
  try {
    values = parseDotenv(raw);
  } catch {
    throw new Error(`Cannot safely update the private provider settings at ${path}.`);
  }

  raw = setEnvValue(raw, "OMNI_VISION_PROVIDER", provider);

  let geminiKey = process.env.GEMINI_API_KEY?.trim() || values.GEMINI_API_KEY?.trim() || "";
  let openaiKey = process.env.OPENAI_API_KEY?.trim() || values.OPENAI_API_KEY?.trim() || "";
  if ((provider === "gemini" || provider === "both") && !geminiKey) geminiKey = await readMasked("Paste Gemini API key (hidden): ");
  if ((provider === "openai" || provider === "both") && !openaiKey) openaiKey = await readMasked("Paste OpenAI API key (hidden): ");
  if ((provider === "gemini" || provider === "both") && !geminiKey) {
    throw new Error("Gemini mode needs GEMINI_API_KEY in your environment or the hidden interactive prompt.");
  }
  if ((provider === "openai" || provider === "both") && !openaiKey) {
    throw new Error("OpenAI mode needs OPENAI_API_KEY in your environment or the hidden interactive prompt.");
  }

  if ((provider === "gemini" || provider === "both") && !values.GEMINI_API_KEY) {
    raw = setEnvValue(raw, "GEMINI_API_KEY", geminiKey);
  }
  if ((provider === "openai" || provider === "both") && !values.OPENAI_API_KEY) {
    raw = setEnvValue(raw, "OPENAI_API_KEY", openaiKey);
  }

  const changed = !existed || raw !== original;
  if (changed) {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
    try {
      await writeFile(temporary, raw, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, path);
      if (platform() !== "win32") await chmod(path, 0o600);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
  return { provider, path, changed };
}

function handshakeError(prefix: string, stderr: string): Error {
  const detail = stderr.replace(/[\r\n\t]+/gu, " ").trim().slice(0, 240);
  return new Error(`${prefix}${detail ? ` ${detail}` : ""}`);
}

function mcpHandshake(runtime: RuntimeCommand, version: string): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(runtime.command, runtime.args, {
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let buffer = "";
    let stderr = "";
    let settled = false;
    let initialized = false;
    const timer = setTimeout(() => {
      finish(handshakeError("MCP health check timed out.", stderr));
    }, 90_000);
    timer.unref?.();

    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      if (error) rejectPromise(error);
      else resolvePromise();
    };
    const send = (message: Record<string, unknown>): void => {
      if (!settled && child.stdin.writable) child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    const request = (id: number, method: string, params: Record<string, unknown> = {}): void => {
      send({ jsonrpc: "2.0", id, method, params });
    };
    const processLine = (line: string): void => {
      if (!line.trim() || settled) return;
      let message: { id?: number; error?: unknown; result?: { tools?: unknown[] } };
      try {
        message = JSON.parse(line) as typeof message;
      } catch {
        finish(handshakeError("MCP server wrote invalid protocol output.", stderr));
        return;
      }
      if (message.id === 1) {
        if (message.error) { finish(new Error("MCP initialize failed.")); return; }
        initialized = true;
        send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
        request(2, "tools/list");
      } else if (message.id === 2) {
        if (!initialized || !message.result?.tools || message.result.tools.length < 3) {
          finish(new Error("MCP tool discovery failed."));
          return;
        }
        finish();
      }
    };

    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/u);
      buffer = lines.pop() ?? "";
      for (const line of lines) processLine(line);
    });
    child.stdin.on("error", (error) => {
      finish(handshakeError(`MCP input failed (${error.message}).`, stderr));
    });
    child.once("error", (error) => {
      finish(handshakeError(`MCP server could not start (${error.message}).`, stderr));
    });
    child.once("exit", (code, signal) => {
      if (!settled) finish(handshakeError(`MCP server exited before the health check completed (${signal ?? `code ${code ?? "unknown"}`}).`, stderr));
    });

    request(1, "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "omni-setup", version },
    });
  });
}

async function checkClient(client: ClientName, scope: ScopeName, runtime?: RuntimeCommand): Promise<{ configured: boolean; detail: string }> {
  if (client === "codex") {
    if (!executableExists("codex")) return { configured: false, detail: "CLI not installed" };
    const status = await inspectCodexEntry(runtime);
    return {
      configured: status.exists && status.owned,
      detail: status.exists ? status.detail : "not configured",
    };
  }
  if (client === "claude") {
    const status = await inspectClaudeConfigFile(scope, runtime);
    return {
      configured: status.exists && status.owned,
      detail: status.exists ? status.detail : "not configured",
    };
  }
  const path = client === "opencode"
    ? openCodeConfigPath(scope)
    : cursorConfigPath(scope);
  const key = client === "opencode" ? "mcp" : "mcpServers";
  const inspection = await inspectJsonEntry(client, path, key, runtime);
  return {
    configured: inspection.exists && inspection.owned,
    detail: inspection.detail,
  };
}

function providerLabel(provider: ProviderName): string {
  if (provider === "ocr") return "Free local OCR";
  if (provider === "gemini") return "Gemini vision with automatic OCR fallback";
  if (provider === "openai") return "OpenAI vision with automatic OCR fallback";
  return "Gemini first, OpenAI backup, then local OCR fallback";
}

async function setupCommand(version: string, args: string[]): Promise<void> {
  const options = parseOptions(args);
  const clients = await chooseClients(options);
  if (clients.length === 0) throw new Error("No supported client was detected. Install a client or specify one, for example: setup cursor.");
  const providerEnvironment = await writeProviderEnvironment(options);
  console.log("Installing a private, version-pinned runtime...");
  const runtime = await ensureManagedRuntime(version);
  console.log(`\nOmni Vision Pro ${version}`);
  console.log(`Mode: ${providerLabel(providerEnvironment.provider)}`);
  console.log(`Clients: ${formatClients(clients)}`);
  console.log(`Scope: ${options.scope === "user" ? "user-wide" : "current project"}\n`);

  let failures = 0;
  for (const client of clients) {
    try {
      const location = await configureClient(client, runtime, options.scope);
      console.log(`[OK] ${formatClients([client])}: installed in ${location}`);
    } catch (error) {
      failures += 1;
      console.log(`[FAIL] ${formatClients([client])}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  console.log("\nChecking the MCP server...");
  await mcpHandshake(runtime, version);
  console.log("[OK] Server starts and exposes all tools.");
  if (providerEnvironment.path) {
    console.log(`Private provider settings: ${providerEnvironment.path}${providerEnvironment.changed ? "" : " (unchanged)"}`);
  } else {
    console.log("Private provider settings: not needed for OCR mode");
  }
  console.log("\nRestart/open your clients, then ask: \"Use omni-vision-pro to analyze this image.\"");
  if (failures > 0) process.exitCode = 1;
}

async function doctorCommand(version: string, args: string[]): Promise<void> {
  const options = parseOptions(args);
  const explicitlyRequested = options.clients.length > 0;
  const clients = explicitlyRequested ? options.clients : detectClients();
  console.log(`Omni Vision Pro doctor (${version})\n`);
  let unhealthy = 0;
  let runtime: RuntimeCommand | undefined;
  const inspection = await inspectManagedRuntime(version);
  if (!inspection.valid) {
    unhealthy += 1;
    console.log(`[FAIL] MCP server: ${inspection.detail}. Run '${SERVER_NAME} setup' to install it.`);
  } else {
    runtime = inspection.runtime;
    try {
      await mcpHandshake(runtime, version);
      console.log(`[OK] MCP server: starts and exposes tools (${runtime.entry})`);
    } catch (error) {
      unhealthy += 1;
      console.log(`[FAIL] MCP server: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const envPath = getOmniEnvironmentFile();
  console.log(`${existsSync(envPath) ? "[OK]" : "[INFO]"} Provider settings: ${existsSync(envPath) ? envPath : "not created (OCR-only mode is valid)"}`);
  if (clients.length === 0) console.log("[INFO] Clients: no supported installed client detected; skipped");
  for (const client of clients) {
    try {
      const status = await checkClient(client, options.scope, runtime);
      if (!status.configured) unhealthy += 1;
      console.log(`${status.configured ? "[OK]" : "[INFO]"} ${formatClients([client])}: ${status.detail}`);
    } catch (error) {
      unhealthy += 1;
      console.log(`[FAIL] ${formatClients([client])}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (unhealthy > 0) process.exitCode = 1;
}

async function uninstallCommand(args: string[]): Promise<void> {
  const options = parseOptions(args);
  const clients = options.clients.length > 0 ? options.clients : detectClients();
  if (clients.length === 0) console.log("[INFO] No supported installed client was detected; nothing to remove.");
  for (const client of clients) {
    try {
      const removed = await removeClient(client, options.scope);
      console.log(`${removed ? "[OK]" : "[INFO]"} ${formatClients([client])}: ${removed ? "removed" : "no matching managed entry found"}`);
    } catch (error) {
      console.log(`[FAIL] ${formatClients([client])}: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  }
  console.log(`Provider settings were kept at ${getOmniEnvironmentFile()} so reinstalling does not lose keys.`);
}

function printHelp(version: string): void {
  console.log(`omni-vision-pro ${version}\n\n` +
    "One-command setup:\n" +
    "  npx --yes omni-vision-pro@latest setup --yes\n\n" +
    "Set up one client:\n" +
    "  npx --yes omni-vision-pro@latest setup cursor\n" +
    "  npx --yes omni-vision-pro@latest setup claude-code\n\n" +
    "Commands:\n" +
    "  setup       Auto-detect and configure Codex, OpenCode, Claude Code, and Cursor\n" +
    "  doctor      Inspect the installed runtime and client configurations\n" +
    "  uninstall   Remove only installer-owned omni-vision-pro client entries\n" +
    "  serve       Start the MCP stdio server (used by clients)\n\n" +
    "Useful options:\n" +
    "  [codex|opencode|claude-code|cursor|all]\n" +
    "  --client codex,opencode,claude,cursor | --all\n" +
    "  --user (default) | --project\n" +
    "  --provider ocr|gemini|openai|both\n" +
    "  --yes\n\n" +
    "For cloud vision, set GEMINI_API_KEY or OPENAI_API_KEY in your environment,\n" +
    "or run interactive setup and paste it into the hidden prompt.\n");
}

export async function runSetupCli(command: string, version: string, args: string[]): Promise<void> {
  if (command === "setup") return setupCommand(version, args);
  if (command === "doctor") return doctorCommand(version, args);
  if (command === "uninstall" || command === "remove") return uninstallCommand(args);
  if (command === "help" || command === "--help" || command === "-h") return printHelp(version);
  throw new Error(`Unknown command: ${command}. Run ${SERVER_NAME} --help.`);
}
