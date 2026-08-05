import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { platform } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
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
import { detectRuntimeEditor, runtimeEditorLabel, type RuntimeEditor } from "./editor-detection.js";
import {
  getManagedRuntimeDirectory,
  getOmniDataDirectory,
  getOmniEnvironmentFile,
  getSetupHome,
  PACKAGE_NAME,
} from "./paths.js";

export type ClientName = "codex" | "opencode" | "claude" | "claude-desktop" | "cursor" | "vscode";
type ScopeName = "user" | "project";
type ProviderName = "auto" | "ocr" | "gemini" | "openai" | "both";
type CloudProviderName = "gemini" | "openai";

interface ProviderKeys {
  gemini?: string;
  openai?: string;
}

interface ClientDetection {
  client: ClientName;
  detected: boolean;
  configurable: boolean;
  detail: string;
}

interface CliOptions {
  clients: ClientName[];
  scope: ScopeName;
  yes: boolean;
  provider: ProviderName;
  providerExplicit: boolean;
  fromClipboard: boolean;
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
  path: string;
  changed: boolean;
}

interface ProviderEnvironmentState {
  path: string;
  existed: boolean;
  raw: string;
  values: Record<string, string>;
  provider: ProviderName;
}

interface EffectiveProviderKeyState {
  available: boolean;
  source: string;
}

interface EffectiveProviderEnvironment {
  provider: ProviderName;
  providerSource: string;
  keys: Record<CloudProviderName, EffectiveProviderKeyState>;
}

interface EntryInspection {
  exists: boolean;
  owned: boolean;
  detail: string;
}

const SERVER_NAME = PACKAGE_NAME;
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLIENTS: ClientName[] = ["codex", "opencode", "claude", "claude-desktop", "cursor", "vscode"];
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
    "claude-desktop": "claude-desktop",
    cursor: "cursor",
    code: "vscode",
    "vs-code": "vscode",
    vscode: "vscode",
    "visual-studio-code": "vscode",
  };
  return aliases[normalized] ?? null;
}

function parseClients(value: string): ClientName[] {
  if (!value.trim()) throw new Error("A client name is required.");
  const requested = value.split(",").map((item) => item.trim()).filter(Boolean);
  const parsed = requested.map((item) => {
    const client = normalizeClientAlias(item);
    if (!client) throw new Error(`Unknown client '${item}'. Use: ${CLIENTS.join(", ")}, claude-code, vscode, or all.`);
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
  if (provider === "auto" || provider === "automatic") return "auto";
  if (provider === "ocr" || provider === "tesseract" || provider === "local") return "ocr";
  if (provider === "gemini" || provider === "openai" || provider === "both") return provider;
  throw new Error("Provider must be auto, ocr, gemini, openai, or both.");
}

function providerFromClipboardKey(value: string): CloudProviderName | null {
  const key = value.trim();
  if (/^AIza[0-9A-Za-z_-]{20,}$/u.test(key)) return "gemini";
  if (/^sk-[0-9A-Za-z_-]{16,}$/u.test(key)) return "openai";
  return null;
}

function readClipboardText(): string {
  const clipboardCommand = platform() === "win32"
    ? {
        command: resolveExecutableOnPath("powershell.exe") ?? "powershell.exe",
        args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "Get-Clipboard -Raw"],
      }
    : platform() === "darwin"
      ? { command: "pbpaste", args: [] }
      : executableExists("wl-paste")
        ? { command: "wl-paste", args: ["--no-newline"] }
        : executableExists("xclip")
          ? { command: "xclip", args: ["-selection", "clipboard", "-o"] }
          : null;
  if (!clipboardCommand) {
    throw new Error("Clipboard setup needs pbpaste on macOS, or wl-paste/xclip on Linux. You can still run the normal guided setup.");
  }
  const result = spawnSync(clipboardCommand.command, clipboardCommand.args, {
    env: process.env,
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000,
    maxBuffer: 16 * 1024,
  });
  if (result.status !== 0 || result.error) throw new Error("The API key could not be read from the clipboard. Copy the key and run the command again.");
  const value = result.stdout.trim();
  if (!value) throw new Error("The clipboard is empty. Copy a Gemini or OpenAI API key and run the command again.");
  if (value.length > 4096 || /[\r\n]/u.test(value)) {
    throw new Error("The clipboard does not contain a single API key. Copy only the key and run the command again.");
  }
  return value;
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
    provider: "auto",
    providerExplicit: false,
    fromClipboard: false,
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
    } else if (arg === "--from-clipboard" || arg === "--clipboard") {
      options.fromClipboard = true;
    } else if (arg === "--target") {
      options.clients.push(...parseClients(nextOptionValue(args, index, arg)));
      index += 1;
    } else if (arg.startsWith("--target=")) options.clients.push(...parseClients(arg.slice("--target=".length)));
    else if (arg === "--all") options.clients = [...CLIENTS];
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

function jsonEntryIsOwned(client: Exclude<ClientName, "codex">, entry: unknown, runtime?: RuntimeCommand): boolean {
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

function vscodeConfigPath(scope: ScopeName): string {
  if (scope === "project") return resolve(process.cwd(), ".vscode", "mcp.json");
  if (process.env.OMNI_SETUP_HOME?.trim()) return join(getSetupHome(), ".vscode-user", "mcp.json");
  if (platform() === "win32") {
    const appData = process.env.APPDATA?.trim();
    return join(appData ? resolve(appData) : getSetupHome(), "Code", "User", "mcp.json");
  }
  if (platform() === "darwin") return join(getSetupHome(), "Library", "Application Support", "Code", "User", "mcp.json");
  const configHome = process.env.XDG_CONFIG_HOME?.trim() ? resolve(process.env.XDG_CONFIG_HOME) : join(getSetupHome(), ".config");
  return join(configHome, "Code", "User", "mcp.json");
}

function claudeDesktopConfigPath(): string {
  if (process.env.OMNI_SETUP_HOME?.trim()) return join(getSetupHome(), ".claude-desktop", "claude_desktop_config.json");
  if (platform() === "win32") {
    const appData = process.env.APPDATA?.trim();
    return join(appData ? resolve(appData) : getSetupHome(), "Claude", "claude_desktop_config.json");
  }
  if (platform() === "darwin") return join(getSetupHome(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
  const configHome = process.env.XDG_CONFIG_HOME?.trim() ? resolve(process.env.XDG_CONFIG_HOME) : join(getSetupHome(), ".config");
  return join(configHome, "Claude", "claude_desktop_config.json");
}

async function inspectJsonEntry(
  client: Exclude<ClientName, "codex">,
  path: string,
  containerKey: "mcp" | "mcpServers" | "servers",
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

async function mergeVscode(runtime: RuntimeCommand, scope: ScopeName): Promise<string> {
  const document = await readJsonDocument(vscodeConfigPath(scope));
  const servers = objectAt(document.value, "servers", document.path);
  if (servers && SERVER_NAME in servers && !jsonEntryIsOwned("vscode", servers[SERVER_NAME], runtime)) {
    throw collisionError("vscode", document.path);
  }
  updateJsonValue(document, ["servers", SERVER_NAME], {
    type: "stdio",
    command: runtime.command,
    args: runtime.args,
  });
  const backup = await writeJsonDocument(document);
  return `${document.path}${backup ? ` (backup: ${basename(backup)})` : document.existed ? " (already current)" : ""}`;
}

async function mergeClaudeDesktop(runtime: RuntimeCommand, scope: ScopeName): Promise<string> {
  if (scope === "project") throw new Error("Claude Desktop supports user-wide MCP configuration only.");
  const document = await readJsonDocument(claudeDesktopConfigPath());
  const servers = objectAt(document.value, "mcpServers", document.path);
  if (servers && SERVER_NAME in servers && !jsonEntryIsOwned("claude-desktop", servers[SERVER_NAME], runtime)) {
    throw collisionError("claude-desktop", document.path);
  }
  updateJsonValue(document, ["mcpServers", SERVER_NAME], {
    command: runtime.command,
    args: runtime.args,
  });
  const backup = await writeJsonDocument(document);
  return `${document.path}${backup ? ` (backup: ${basename(backup)})` : document.existed ? " (already current)" : ""}`;
}

async function removeJsonEntry(
  client: Exclude<ClientName, "codex">,
  path: string,
  containerKey: "mcp" | "mcpServers" | "servers",
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
  if (client === "claude-desktop") return mergeClaudeDesktop(runtime, scope);
  if (client === "opencode") return mergeOpenCode(runtime, scope);
  if (client === "cursor") return mergeCursor(runtime, scope);
  return mergeVscode(runtime, scope);
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
  if (client === "cursor") return removeJsonEntry("cursor", cursorConfigPath(scope), "mcpServers");
  if (client === "vscode") return removeJsonEntry("vscode", vscodeConfigPath(scope), "servers");
  if (scope === "project") return false;
  return removeJsonEntry("claude-desktop", claudeDesktopConfigPath(), "mcpServers");
}

function getClientDetections(): ClientDetection[] {
  const codexCli = executableExists("codex");
  const codexHome = process.env.CODEX_HOME?.trim()
    ? resolve(process.env.CODEX_HOME)
    : join(getSetupHome(), ".codex");
  const codexDetected = codexCli || existsSync(codexHome);

  const openCodeCli = executableExists("opencode");
  const openCodeDetected = openCodeCli || existsSync(dirname(openCodeConfigPath("user")));

  const claudeCli = executableExists("claude");
  const claudeDetected = claudeCli || existsSync(claudeConfigPath("user"));

  const cursorCli = executableExists("cursor");
  const cursorDetected = cursorCli || existsSync(join(getSetupHome(), ".cursor"));

  const vscodeCli = executableExists("code") || executableExists("code-insiders");
  const vscodeDetected = vscodeCli || existsSync(dirname(vscodeConfigPath("user")));

  const claudeDesktopDetected = existsSync(dirname(claudeDesktopConfigPath()));

  return [
    {
      client: "codex",
      detected: codexDetected,
      configurable: codexCli,
      detail: codexCli ? "Codex CLI found" : codexDetected ? "Codex settings found; Codex CLI is required for automatic setup" : "Not detected",
    },
    {
      client: "opencode",
      detected: openCodeDetected,
      configurable: true,
      detail: openCodeDetected ? "OpenCode found" : "Not detected; a config can still be prepared",
    },
    {
      client: "claude",
      detected: claudeDetected,
      configurable: claudeCli,
      detail: claudeCli ? "Claude Code CLI found" : claudeDetected ? "Claude settings found; Claude Code CLI is required for automatic setup" : "Not detected",
    },
    {
      client: "cursor",
      detected: cursorDetected,
      configurable: true,
      detail: cursorDetected ? "Cursor found" : "Not detected; a config can still be prepared",
    },
    {
      client: "vscode",
      detected: vscodeDetected,
      configurable: true,
      detail: vscodeDetected ? "Visual Studio Code found" : "Not detected; a config can still be prepared",
    },
    {
      client: "claude-desktop",
      detected: claudeDesktopDetected,
      configurable: true,
      detail: claudeDesktopDetected ? "Claude Desktop settings found" : "Not detected; a config can still be prepared",
    },
  ];
}

function detectClients(): ClientName[] {
  return getClientDetections()
    .filter((item) => item.detected && item.configurable)
    .map((item) => item.client);
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
    "claude-desktop": "Claude Desktop",
    cursor: "Cursor",
    vscode: "Visual Studio Code",
  };
  return clients.map((client) => labels[client]).join(", ");
}

async function chooseClients(options: CliOptions): Promise<ClientName[]> {
  if (options.clients.length > 0) return options.clients;
  const active = detectRuntimeEditor();
  if (active.editor) {
    const activeDetection = getClientDetections().find((item) => item.client === active.editor);
    if (activeDetection?.configurable) {
      console.log(`Active client detected: ${runtimeEditorLabel(active.editor)} (${active.evidence})`);
      return [active.editor];
    }
  }
  const detected = detectClients();
  if (detected.length === 1) return detected;
  if (options.yes || !input.isTTY || !output.isTTY) {
    throw new Error("The active editor could not be identified safely. Run setup again with --target codex, opencode, claude, claude-desktop, cursor, vscode, or all.");
  }
  const rl = createInterface({ input, output });
  try {
    const defaultValue = detected.length === 1 ? detected[0] ?? "" : "";
    const suffix = defaultValue ? ` [${defaultValue}]` : "";
    const answer = await rl.question(`Choose one target client${suffix}: `);
    const selected = answer.trim() || defaultValue;
    if (!selected) throw new Error("Choose one client, or enter 'all' to configure every supported client.");
    return parseClients(selected);
  } finally {
    rl.close();
  }
}

async function readMasked(question: string): Promise<string> {
  if (!input.isTTY || !output.isTTY) return "";
  return new Promise((resolvePromise, rejectPromise) => {
    output.write(question);
    input.resume();
    input.setRawMode?.(true);
    let value = "";
    let completed = false;
    const finish = (error?: Error): void => {
      if (completed) return;
      completed = true;
      input.off("data", onData);
      input.off("error", onError);
      input.setRawMode?.(false);
      input.pause();
      output.write("\n");
      if (error) rejectPromise(error);
      else resolvePromise(value.trim());
    };
    const onError = (): void => finish(new Error("API key entry was interrupted."));
    const onData = (chunk: Buffer): void => {
      for (const char of chunk.toString()) {
        if (char === "\r" || char === "\n") { finish(); return; }
        if (char === "\u0003") { finish(new Error("API key entry cancelled.")); return; }
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else value += char;
      }
    };
    input.on("data", onData);
    input.on("error", onError);
  });
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

function removeEnvValue(raw: string, key: "GEMINI_API_KEY" | "OPENAI_API_KEY"): string {
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const expression = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`, "u");
  const lines = raw.split(/\r?\n/u).filter((line) => !expression.test(line));
  while (lines.length > 1 && lines[lines.length - 1] === "" && lines[lines.length - 2] === "") lines.pop();
  return lines.join(eol);
}

async function readProviderEnvironmentState(): Promise<ProviderEnvironmentState> {
  const path = getOmniEnvironmentFile();
  const existed = existsSync(path);
  const raw = existed ? await readFile(path, "utf8") : [
    "# Private settings for omni-vision-pro.",
    "# Keys stay here and are never copied into MCP client configuration files.",
    "",
  ].join("\n");
  let values: Record<string, string>;
  try {
    values = parseDotenv(raw);
  } catch {
    throw new Error(`Cannot safely update the private provider settings at ${path}.`);
  }
  let provider: ProviderName = "auto";
  if (values.OMNI_VISION_PROVIDER?.trim()) {
    try {
      provider = parseProvider(values.OMNI_VISION_PROVIDER);
    } catch {
      throw new Error(`OMNI_VISION_PROVIDER in ${path} is invalid. Use auto, ocr, gemini, openai, or both.`);
    }
  }
  return { path, existed, raw, values, provider };
}

function readOptionalProviderEnvironment(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  try {
    return parseDotenv(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

function resolveEffectiveProviderEnvironment(state: ProviderEnvironmentState): EffectiveProviderEnvironment {
  type ProviderEnvironmentName = "OMNI_VISION_PROVIDER" | "GEMINI_API_KEY" | "OPENAI_API_KEY";
  interface CandidateEnvironment { values: Record<string, string | undefined>; source: string }
  const firstValue = (name: ProviderEnvironmentName, candidates: CandidateEnvironment[]): { value?: string; source: string } => {
    for (const candidate of candidates) {
      if (candidate.values[name] !== undefined) return { value: candidate.values[name], source: candidate.source };
    }
    return { source: "not set" };
  };

  const fileCandidates = [
    { path: resolve(process.cwd(), ".env"), source: "project .env" },
    { path: resolve(PACKAGE_ROOT, ".env"), source: "package .env" },
  ] as const;
  const seen = new Set([resolve(state.path)]);
  const loadedFiles: CandidateEnvironment[] = [];
  for (const candidate of fileCandidates) {
    const path = resolve(candidate.path);
    if (seen.has(path)) continue;
    seen.add(path);
    loadedFiles.push({ values: readOptionalProviderEnvironment(path), source: candidate.source });
  }

  const processCandidate: CandidateEnvironment = { values: process.env, source: "process environment" };
  const privateCandidate: CandidateEnvironment = { values: state.values, source: "private settings" };
  const projectCandidate = loadedFiles.find((candidate) => candidate.source === "project .env");
  const packageCandidate = loadedFiles.find((candidate) => candidate.source === "package .env");
  const providerSetting = firstValue("OMNI_VISION_PROVIDER", [
    privateCandidate,
    processCandidate,
    ...(projectCandidate ? [projectCandidate] : []),
    ...(packageCandidate ? [packageCandidate] : []),
  ]);
  const keyCandidates = [
    processCandidate,
    ...(projectCandidate ? [projectCandidate] : []),
    privateCandidate,
    ...(packageCandidate ? [packageCandidate] : []),
  ];
  const geminiKey = firstValue("GEMINI_API_KEY", keyCandidates);
  const openaiKey = firstValue("OPENAI_API_KEY", keyCandidates);

  let provider: ProviderName = "auto";
  const configuredProvider = providerSetting.value?.trim();
  if (configuredProvider) {
    try {
      provider = parseProvider(configuredProvider);
    } catch {
      // The MCP server intentionally treats unknown provider values as auto.
    }
  }
  const keyState = (key: { value?: string; source: string }): EffectiveProviderKeyState => ({
    available: Boolean(key.value?.trim()),
    source: key.source,
  });
  return {
    provider,
    providerSource: providerSetting.source === "not set" ? "default" : providerSetting.source,
    keys: {
      gemini: keyState(geminiKey),
      openai: keyState(openaiKey),
    },
  };
}

async function writeProviderRaw(state: ProviderEnvironmentState, raw: string): Promise<boolean> {
  if (state.existed && raw === state.raw) return false;
  await mkdir(dirname(state.path), { recursive: true });
  const temporary = `${state.path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, raw, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, state.path);
    if (platform() !== "win32") await chmod(state.path, 0o600);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
  return true;
}

async function ensureDefaultProviderEnvironment(): Promise<ProviderEnvironmentResult> {
  const state = await readProviderEnvironmentState();
  if (Object.prototype.hasOwnProperty.call(state.values, "OMNI_VISION_PROVIDER")) {
    return { provider: state.provider, path: state.path, changed: false };
  }
  const raw = setEnvValue(state.raw, "OMNI_VISION_PROVIDER", "auto");
  return { provider: "auto", path: state.path, changed: await writeProviderRaw(state, raw) };
}

async function writeProviderEnvironment(options: CliOptions, providerKeys?: ProviderKeys, providerOverride?: ProviderName): Promise<ProviderEnvironmentResult> {
  const provider = providerOverride ?? options.provider;
  const state = await readProviderEnvironmentState();
  let raw = state.raw;
  const values = state.values;

  raw = setEnvValue(raw, "OMNI_VISION_PROVIDER", provider);

  const submittedGeminiKey = providerKeys?.gemini?.trim() || "";
  const submittedOpenAiKey = providerKeys?.openai?.trim() || "";
  let geminiKey = submittedGeminiKey || process.env.GEMINI_API_KEY?.trim() || values.GEMINI_API_KEY?.trim() || "";
  let openaiKey = submittedOpenAiKey || process.env.OPENAI_API_KEY?.trim() || values.OPENAI_API_KEY?.trim() || "";
  if ((provider === "gemini" || provider === "both") && !geminiKey) geminiKey = await readMasked("Paste Gemini API key (hidden): ");
  if ((provider === "openai" || provider === "both") && !openaiKey) openaiKey = await readMasked("Paste OpenAI API key (hidden): ");
  if ((provider === "gemini" || provider === "both") && !geminiKey) {
    throw new Error("Gemini mode needs GEMINI_API_KEY in your environment or the hidden interactive prompt.");
  }
  if ((provider === "openai" || provider === "both") && !openaiKey) {
    throw new Error("OpenAI mode needs OPENAI_API_KEY in your environment or the hidden interactive prompt.");
  }
  if (geminiKey && (provider === "gemini" || provider === "both" || submittedGeminiKey)) {
    geminiKey = validateProviderKey("gemini", geminiKey);
  }
  if (openaiKey && (provider === "openai" || provider === "both" || submittedOpenAiKey)) {
    openaiKey = validateProviderKey("openai", openaiKey);
  }

  if ((provider === "gemini" || provider === "both") && (submittedGeminiKey || !values.GEMINI_API_KEY)) {
    raw = setEnvValue(raw, "GEMINI_API_KEY", geminiKey);
  }
  if ((provider === "openai" || provider === "both") && (submittedOpenAiKey || !values.OPENAI_API_KEY)) {
    raw = setEnvValue(raw, "OPENAI_API_KEY", openaiKey);
  }

  const changed = await writeProviderRaw(state, raw);
  return { provider, path: state.path, changed };
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
  if (client === "claude-desktop" && scope === "project") {
    return { configured: false, detail: "Claude Desktop has no project-scoped MCP configuration" };
  }
  const path = client === "opencode"
    ? openCodeConfigPath(scope)
    : client === "cursor"
      ? cursorConfigPath(scope)
      : client === "vscode"
        ? vscodeConfigPath(scope)
        : claudeDesktopConfigPath();
  const key = client === "opencode" ? "mcp" : client === "vscode" ? "servers" : "mcpServers";
  const inspection = await inspectJsonEntry(client, path, key, runtime);
  return {
    configured: inspection.exists && inspection.owned,
    detail: inspection.detail,
  };
}

function providerLabel(provider: ProviderName): string {
  if (provider === "auto") return "Automatic: use a saved AI key, otherwise free local OCR";
  if (provider === "ocr") return "Free local OCR";
  if (provider === "gemini") return "Gemini vision with automatic OCR fallback";
  if (provider === "openai") return "OpenAI vision with automatic OCR fallback";
  return "Gemini first, OpenAI backup, then local OCR fallback";
}

function cloudProviderLabel(provider: CloudProviderName): string {
  return provider === "gemini" ? "Gemini" : "OpenAI";
}

function providerKeyName(provider: CloudProviderName): "GEMINI_API_KEY" | "OPENAI_API_KEY" {
  return provider === "gemini" ? "GEMINI_API_KEY" : "OPENAI_API_KEY";
}

function providerHasKey(state: EffectiveProviderEnvironment, provider: CloudProviderName): boolean {
  return state.keys[provider].available;
}

function validateProviderKey(provider: CloudProviderName, value: string): string {
  const key = value.trim();
  if (!key || key.length > 4096 || /[\r\n\s]/u.test(key)) {
    throw new Error("The API key must be one non-empty line without spaces.");
  }
  if (provider === "gemini" && !/^AIza[0-9A-Za-z_-]{20,}$/u.test(key)) {
    throw new Error("That does not look like a Gemini API key. Copy only the key that starts with AIza.");
  }
  if (provider === "openai" && !/^sk-[0-9A-Za-z_-]{16,}$/u.test(key)) {
    throw new Error("That does not look like an OpenAI API key. Copy only the key that starts with sk-.");
  }
  return key;
}

async function ask(question: string): Promise<string> {
  if (!input.isTTY || !output.isTTY) return "";
  const rl = createInterface({ input, output });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

async function chooseCloudProvider(question = "Choose provider: [1] Gemini, [2] OpenAI: "): Promise<CloudProviderName> {
  const answer = await ask(question);
  if (answer === "1" || answer.toLowerCase() === "gemini") return "gemini";
  if (answer === "2" || answer.toLowerCase() === "openai") return "openai";
  throw new Error("Choose 1 for Gemini or 2 for OpenAI.");
}

async function setProviderKey(provider: CloudProviderName | undefined, fromClipboard: boolean): Promise<void> {
  let selected = provider;
  let key = "";
  if (fromClipboard) {
    key = readClipboardText();
    const detected = providerFromClipboardKey(key);
    if (!detected) throw new Error("The clipboard does not contain a recognizable Gemini or OpenAI API key.");
    if (selected && selected !== detected) {
      throw new Error(`The copied key looks like ${cloudProviderLabel(detected)}, not ${cloudProviderLabel(selected)}.`);
    }
    selected = detected;
  } else {
    selected ??= await chooseCloudProvider();
    key = await readMasked(`Paste ${cloudProviderLabel(selected)} API key (hidden): `);
  }
  if (!selected) throw new Error("Choose Gemini or OpenAI before saving a key.");
  key = validateProviderKey(selected, key);

  const state = await readProviderEnvironmentState();
  let raw = setEnvValue(state.raw, providerKeyName(selected), key);
  raw = setEnvValue(raw, "OMNI_VISION_PROVIDER", selected);
  await writeProviderRaw(state, raw);
  console.log(`[OK] ${cloudProviderLabel(selected)} key saved privately and selected.`);
  console.log("Restart your AI client once. Cloud vision will then run automatically, with local OCR as fallback.");
}

async function useProvider(provider: ProviderName): Promise<void> {
  const state = await readProviderEnvironmentState();
  const effective = resolveEffectiveProviderEnvironment(state);
  if (provider === "gemini" && !providerHasKey(effective, "gemini")) {
    throw new Error(`No Gemini key is available. Run '${SERVER_NAME} provider set gemini' first.`);
  }
  if (provider === "openai" && !providerHasKey(effective, "openai")) {
    throw new Error(`No OpenAI key is available. Run '${SERVER_NAME} provider set openai' first.`);
  }
  if (provider === "both" && (!providerHasKey(effective, "gemini") || !providerHasKey(effective, "openai"))) {
    throw new Error("Both mode needs both Gemini and OpenAI keys. Add the missing key first, or use auto mode.");
  }
  if (provider === "auto" && !providerHasKey(effective, "gemini") && !providerHasKey(effective, "openai")) {
    console.log("[INFO] No AI key is saved yet. Auto mode will use free local OCR until a key is added.");
  }
  const raw = setEnvValue(state.raw, "OMNI_VISION_PROVIDER", provider);
  await writeProviderRaw(state, raw);
  console.log(`[OK] Vision mode: ${providerLabel(provider)}.`);
  if (provider === "ocr") console.log("Saved API keys were kept. In OCR-only mode, no cloud provider is called.");
  console.log("Restart your AI client once for this change to take effect.");
}

async function removeProviderKey(target: CloudProviderName | "all"): Promise<void> {
  const state = await readProviderEnvironmentState();
  let raw = state.raw;
  const hadPrivateKey = target === "all"
    ? Boolean(state.values.GEMINI_API_KEY?.trim() || state.values.OPENAI_API_KEY?.trim())
    : Boolean(state.values[providerKeyName(target)]?.trim());
  if (target === "all" || target === "gemini") raw = removeEnvValue(raw, "GEMINI_API_KEY");
  if (target === "all" || target === "openai") raw = removeEnvValue(raw, "OPENAI_API_KEY");

  let nextProvider = state.provider;
  if (nextProvider !== "ocr" && (target === "all" || nextProvider === target || nextProvider === "both")) {
    nextProvider = "auto";
    raw = setEnvValue(raw, "OMNI_VISION_PROVIDER", nextProvider);
  }
  await writeProviderRaw(state, raw);
  const label = target === "all" ? "Gemini and OpenAI keys" : `${cloudProviderLabel(target)} key`;
  console.log(`${hadPrivateKey ? "[OK]" : "[INFO]"} ${label}: ${hadPrivateKey ? "removed from private settings" : "not saved in private settings"}.`);
  const updatedValues = parseDotenv(raw);
  const effective = resolveEffectiveProviderEnvironment({ ...state, raw, values: updatedValues, provider: nextProvider });
  const remainingSources = (["gemini", "openai"] as const)
    .filter((provider) => (target === "all" || target === provider) && effective.keys[provider].available)
    .map((provider) => `${cloudProviderLabel(provider)} (${effective.keys[provider].source})`);
  if (remainingSources.length > 0) {
    console.log(`[INFO] Credentials remain available outside private settings: ${remainingSources.join(", ")}. Remove them from those sources separately if needed.`);
  }
  console.log("Restart your AI client once for this change to take effect.");
}

async function printProviderStatus(): Promise<void> {
  const state = await readProviderEnvironmentState();
  const effective = resolveEffectiveProviderEnvironment(state);
  const effectiveMode = effective.provider;
  const keyStatus = (provider: CloudProviderName): string => {
    const key = effective.keys[provider];
    return key.available ? `available from ${key.source}` : "not set";
  };
  const hasGemini = providerHasKey(effective, "gemini");
  const hasOpenAi = providerHasKey(effective, "openai");
  const selectedKeyAvailable = effectiveMode === "auto" || effectiveMode === "both"
    ? hasGemini || hasOpenAi
    : effectiveMode === "gemini" ? hasGemini : effectiveMode === "openai" ? hasOpenAi : false;
  const aiStatus = effectiveMode === "ocr"
    ? "OFF (local OCR only)"
    : selectedKeyAvailable ? "ON" : "OFF (no usable API key; local OCR active)";
  console.log("Omni Vision Pro provider status\n");
  console.log(`AI: ${aiStatus}`);
  console.log(`Mode: ${providerLabel(effectiveMode)} (from ${effective.providerSource})`);
  console.log(`Gemini key: ${keyStatus("gemini")}`);
  console.log(`OpenAI key: ${keyStatus("openai")}`);
  console.log(`Private settings: ${state.path}${state.existed ? "" : " (will be created when settings change)"}`);
  console.log("API key values are intentionally never displayed.");
}

async function interactiveProviderCommand(): Promise<void> {
  if (!input.isTTY || !output.isTTY) return printProviderStatus();
  await printProviderStatus();
  console.log("\nWhat do you want to do?");
  console.log("  [1] Add or replace a Gemini key");
  console.log("  [2] Add or replace an OpenAI key");
  console.log("  [3] Change the active AI provider");
  console.log("  [4] Turn AI off (use local OCR)");
  console.log("  [5] Turn AI on (automatic)");
  console.log("  [6] Remove a saved API key");
  console.log("  [0] Exit");
  const answer = await ask("Select: ");
  if (answer === "0" || !answer) return;
  if (answer === "1") return setProviderKey("gemini", false);
  if (answer === "2") return setProviderKey("openai", false);
  if (answer === "4") return useProvider("ocr");
  if (answer === "5") return useProvider("auto");
  if (answer === "3") {
    const mode = await ask("Use: [1] Auto, [2] Gemini, [3] OpenAI, [4] Gemini + OpenAI: ");
    const provider = ({ "1": "auto", "2": "gemini", "3": "openai", "4": "both" } as const)[mode];
    if (!provider) throw new Error("Choose 1, 2, 3, or 4.");
    return useProvider(provider);
  }
  if (answer === "6") {
    const target = await ask("Remove: [1] Gemini, [2] OpenAI, [3] All saved keys: ");
    const provider = ({ "1": "gemini", "2": "openai", "3": "all" } as const)[target];
    if (!provider) throw new Error("Choose 1, 2, or 3.");
    return removeProviderKey(provider);
  }
  throw new Error("Choose one of the displayed menu numbers.");
}

async function providerCommand(args: string[]): Promise<void> {
  if (args.length === 0) return interactiveProviderCommand();
  const fromClipboard = args.includes("--from-clipboard") || args.includes("--clipboard");
  const positional = args.filter((arg) => !["--from-clipboard", "--clipboard", "--yes", "-y"].includes(arg));
  const unknownOption = positional.find((arg) => arg.startsWith("-"));
  if (unknownOption) throw new Error(`Unknown provider option: ${unknownOption}`);
  if (positional.length > 2) throw new Error(`Unexpected provider argument: ${positional[2]}`);
  const action = positional[0]?.toLowerCase();
  const target = positional[1]?.toLowerCase();
  if (!action && fromClipboard) return setProviderKey(undefined, true);
  if (!action) return interactiveProviderCommand();
  if (fromClipboard && action !== "set" && action !== "add" && action !== "replace") {
    throw new Error("--from-clipboard can only be used with provider set, add, or replace.");
  }
  if (action === "menu") {
    if (target) throw new Error("Provider menu does not accept another argument.");
    return interactiveProviderCommand();
  }
  if (action === "status" || action === "show") {
    if (target) throw new Error("Provider status does not accept another argument.");
    return printProviderStatus();
  }
  if (action === "set" || action === "add" || action === "replace") {
    const provider = target ? parseProvider(target) : undefined;
    if (provider && provider !== "gemini" && provider !== "openai") throw new Error("A key can only be set for Gemini or OpenAI.");
    return setProviderKey(provider, fromClipboard);
  }
  if (action === "use" || action === "switch") {
    if (!target) throw new Error("Choose auto, gemini, openai, both, or ocr.");
    return useProvider(parseProvider(target));
  }
  if (action === "off" || action === "disable") {
    if (target) throw new Error("Provider off does not accept another argument.");
    return useProvider("ocr");
  }
  if (action === "on" || action === "enable") {
    const provider = target ? parseProvider(target) : "auto";
    if (provider === "ocr") throw new Error("Use 'provider off' for OCR-only mode.");
    return useProvider(provider);
  }
  if (action === "remove" || action === "delete") {
    if (!target) throw new Error("Choose gemini, openai, or all.");
    if (target === "all") return removeProviderKey("all");
    const provider = parseProvider(target);
    if (provider !== "gemini" && provider !== "openai") throw new Error("Choose gemini, openai, or all.");
    return removeProviderKey(provider);
  }
  throw new Error(`Unknown provider action: ${action}. Use status, set, use, on, off, or remove.`);
}

async function setupCommand(version: string, args: string[]): Promise<void> {
  const options = parseOptions(args);
  const clients = await chooseClients(options);
  if (clients.length === 0) throw new Error("No supported active client was detected. Specify one with --target cursor, --target vscode, or another supported client.");
  let provider: ProviderName | undefined;
  let providerKeys: ProviderKeys | undefined;
  if (options.fromClipboard) {
    const key = readClipboardText();
    const detectedProvider = providerFromClipboardKey(key);
    if (!detectedProvider) {
      throw new Error("The clipboard does not look like a Gemini or OpenAI API key. Copy only the key and run the command again.");
    }
    if (options.providerExplicit && options.provider !== detectedProvider) {
      throw new Error(`The copied key looks like ${detectedProvider === "gemini" ? "a Gemini" : "an OpenAI"} key, but --provider ${options.provider} was requested.`);
    }
    provider = detectedProvider;
    providerKeys = detectedProvider === "gemini" ? { gemini: key } : { openai: key };
  }
  console.log("Saving provider settings securely...");
  const providerEnvironment = provider || options.providerExplicit
    ? await writeProviderEnvironment(options, providerKeys, provider)
    : await ensureDefaultProviderEnvironment();
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
  }
  console.log("\nRestart/open your clients, then ask: \"Use omni-vision-pro to analyze this image.\"");
  console.log("To add or change AI later, run: omni-vision-pro provider");
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
  const clients = await chooseClients(options);
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
    "Add a cloud key from an AI chat (copy the API key first):\n" +
    "  npx --yes omni-vision-pro@latest provider set --from-clipboard\n\n" +
    "Set up one client explicitly:\n" +
    "  npx --yes omni-vision-pro@latest setup --target cursor\n" +
    "  npx --yes omni-vision-pro@latest setup --target claude-code\n\n" +
    "Commands:\n" +
    "  setup       Detect the active editor and configure that client only\n" +
    "  provider    Add/remove keys, switch Gemini/OpenAI, or turn AI off (OCR-only)\n" +
    "  doctor      Inspect the installed runtime and client configurations\n" +
    "  uninstall   Remove only installer-owned omni-vision-pro client entries\n" +
    "  serve       Start the MCP stdio server (used by clients)\n\n" +
    "Useful options:\n" +
    "  [codex|opencode|claude-code|claude-desktop|cursor|vscode|all]\n" +
    "  --target codex|opencode|claude|claude-desktop|cursor|vscode|all\n" +
    "  --client <name> (backward-compatible alias) | --all\n" +
    "  --user (default) | --project\n" +
    "  --provider auto|ocr|gemini|openai|both (setup default: auto)\n" +
    "  --from-clipboard (read a copied Gemini/OpenAI key without putting it in chat)\n" +
    "  --yes\n\n" +
    "Provider shortcuts:\n" +
    "  omni-vision-pro provider                 guided terminal menu\n" +
    "  omni-vision-pro provider set gemini      paste a key privately\n" +
    "  omni-vision-pro provider set openai      paste a key privately\n" +
    "  omni-vision-pro provider use gemini|openai|auto|both\n" +
    "  omni-vision-pro provider on [gemini|openai|auto|both]\n" +
    "  omni-vision-pro provider off             OCR-only mode\n" +
    "  omni-vision-pro provider remove gemini|openai|all\n" +
    "  omni-vision-pro provider status\n");
}

export async function runSetupCli(command: string, version: string, args: string[]): Promise<void> {
  if (command === "setup") return setupCommand(version, args);
  if (command === "provider" || command === "providers" || command === "ai") return providerCommand(args);
  if (command === "doctor") return doctorCommand(version, args);
  if (command === "uninstall" || command === "remove") return uninstallCommand(args);
  if (command === "help" || command === "--help" || command === "-h") return printHelp(version);
  throw new Error(`Unknown command: ${command}. Run ${SERVER_NAME} --help.`);
}
