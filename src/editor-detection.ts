import { spawnSync } from "node:child_process";
import { platform } from "node:os";

export type RuntimeEditor = "codex" | "opencode" | "claude" | "claude-desktop" | "cursor" | "vscode";

export interface ProcessDescriptor {
  pid: number;
  parentPid: number;
  name: string;
  commandLine: string;
}

export interface EditorDetection {
  editor: RuntimeEditor | null;
  confidence: "high" | "medium" | "none";
  evidence: string;
  processChain: ProcessDescriptor[];
}

const MAX_PARENT_DEPTH = 12;

function hasEnvironmentSignal(value: string | undefined): boolean {
  if (!value) return false;
  return !/^(?:0|false|no|off)$/iu.test(value.trim());
}

function environmentEditors(environment: NodeJS.ProcessEnv): Array<{ editor: RuntimeEditor; evidence: string }> {
  const matches: Array<{ editor: RuntimeEditor; evidence: string }> = [];
  if (hasEnvironmentSignal(environment.OPENCODE)) matches.push({ editor: "opencode", evidence: "OPENCODE environment signal" });
  if (hasEnvironmentSignal(environment.CLAUDE_CODE)) matches.push({ editor: "claude", evidence: "CLAUDE_CODE environment signal" });
  if (hasEnvironmentSignal(environment.CURSOR_BUILD)) matches.push({ editor: "cursor", evidence: "CURSOR_BUILD environment signal" });

  const terminal = environment.TERM_PROGRAM?.trim().toLowerCase() ?? "";
  if (terminal.includes("cursor")) matches.push({ editor: "cursor", evidence: `TERM_PROGRAM=${environment.TERM_PROGRAM}` });
  else if (terminal.includes("vscode") || terminal === "code") matches.push({ editor: "vscode", evidence: `TERM_PROGRAM=${environment.TERM_PROGRAM}` });
  else if (terminal.includes("opencode")) matches.push({ editor: "opencode", evidence: `TERM_PROGRAM=${environment.TERM_PROGRAM}` });
  else if (terminal.includes("claude")) matches.push({ editor: "claude", evidence: `TERM_PROGRAM=${environment.TERM_PROGRAM}` });
  else if (terminal.includes("codex")) matches.push({ editor: "codex", evidence: `TERM_PROGRAM=${environment.TERM_PROGRAM}` });

  return matches.filter((match, index) => matches.findIndex((candidate) => candidate.editor === match.editor) === index);
}

function editorFromProcess(processInfo: ProcessDescriptor): RuntimeEditor | null {
  const name = processInfo.name.toLowerCase().replace(/\.exe$/u, "");
  const command = processInfo.commandLine.toLowerCase();
  if (name.includes("opencode") || /(?:^|[\\/\s])opencode(?:\.cmd|\.exe)?(?:\s|$)/u.test(command)) return "opencode";
  if (name === "cursor" || name.includes("cursor helper") || /(?:^|[\\/])cursor(?:\.exe|\.app)?(?:\s|$)/u.test(command)) return "cursor";
  if (name === "code" || name === "code-insiders" || name.includes("visual studio code")) return "vscode";
  if (name === "codex" || /@openai[\\/]codex|[\\/]codex(?:\.js|\.mjs)(?:\s|$)/u.test(command)) return "codex";
  if (name === "claude" && /claude(?:\.app|[\\/]resources[\\/]app)/u.test(command)) return "claude-desktop";
  if (name === "claude" || name === "claude-code" || /(?:^|[\\/\s])claude(?:\.cmd)?(?:\s|$)/u.test(command)) return "claude";
  return null;
}

function windowsParentProcessChain(startPid: number): ProcessDescriptor[] {
  const powershell = process.env.SystemRoot
    ? `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
    : "powershell.exe";
  const script = [
    "param([int]$StartPid)",
    "$items = @()",
    "$current = $StartPid",
    `for ($i = 0; $i -lt ${MAX_PARENT_DEPTH} -and $current -gt 0; $i++) {`,
    "  $process = Get-CimInstance Win32_Process -Filter \"ProcessId = $current\" -ErrorAction SilentlyContinue",
    "  if ($null -eq $process) { break }",
    "  $items += [pscustomobject]@{ pid = [int]$process.ProcessId; parentPid = [int]$process.ParentProcessId; name = [string]$process.Name; commandLine = [string]$process.CommandLine }",
    "  if ($process.ParentProcessId -eq $current) { break }",
    "  $current = [int]$process.ParentProcessId",
    "}",
    "$items | ConvertTo-Json -Compress",
  ].join("; ");
  const result = spawnSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script, String(startPid)], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 5000,
    maxBuffer: 512 * 1024,
  });
  if (result.status !== 0 || result.error || !result.stdout.trim()) return [];
  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    const values = Array.isArray(parsed) ? parsed : [parsed];
    return values.flatMap((value): ProcessDescriptor[] => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      const record = value as Record<string, unknown>;
      const pid = Number(record.pid);
      const parentPid = Number(record.parentPid);
      if (!Number.isInteger(pid) || !Number.isInteger(parentPid)) return [];
      return [{ pid, parentPid, name: String(record.name ?? ""), commandLine: String(record.commandLine ?? "") }];
    });
  } catch {
    return [];
  }
}

function posixParentProcessChain(startPid: number): ProcessDescriptor[] {
  const processes: ProcessDescriptor[] = [];
  let current = startPid;
  for (let depth = 0; depth < MAX_PARENT_DEPTH && current > 0; depth += 1) {
    const result = spawnSync("ps", ["-o", "pid=", "-o", "ppid=", "-o", "comm=", "-o", "args=", "-p", String(current)], {
      encoding: "utf8",
      timeout: 2000,
      maxBuffer: 128 * 1024,
    });
    if (result.status !== 0 || result.error) break;
    const line = result.stdout.trim();
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/u);
    if (!match) break;
    const pid = Number(match[1]);
    const parentPid = Number(match[2]);
    processes.push({ pid, parentPid, name: match[3] ?? "", commandLine: match[4] ?? "" });
    if (parentPid <= 0 || parentPid === pid) break;
    current = parentPid;
  }
  return processes;
}

export function getParentProcessChain(startPid = process.ppid): ProcessDescriptor[] {
  if (!Number.isInteger(startPid) || startPid <= 0) return [];
  return platform() === "win32" ? windowsParentProcessChain(startPid) : posixParentProcessChain(startPid);
}

export function detectEditorFromSignals(
  environment: NodeJS.ProcessEnv,
  processChain: ProcessDescriptor[],
): EditorDetection {
  const environmentMatches = environmentEditors(environment);
  const processMatches = processChain.flatMap((processInfo, index) => {
    const editor = editorFromProcess(processInfo);
    return editor ? [{ editor, index, processInfo }] : [];
  });

  const corroborated = processMatches.find((match) => environmentMatches.some((candidate) => candidate.editor === match.editor));
  if (corroborated) {
    const environmentMatch = environmentMatches.find((candidate) => candidate.editor === corroborated.editor);
    return {
      editor: corroborated.editor,
      confidence: "high",
      evidence: `${environmentMatch?.evidence ?? "environment signal"}; parent process ${corroborated.processInfo.name}`,
      processChain,
    };
  }
  const nearestProcess = processMatches[0];
  if (environmentMatches.length === 1 && environmentMatches[0]?.editor === "vscode" && nearestProcess?.editor === "cursor") {
    return {
      editor: "cursor",
      confidence: "high",
      evidence: `${environmentMatches[0].evidence} is shared by VS Code-compatible terminals; parent process ${nearestProcess.processInfo.name} identifies Cursor`,
      processChain,
    };
  }
  if (environmentMatches.length === 1) {
    return { editor: environmentMatches[0]?.editor ?? null, confidence: "high", evidence: environmentMatches[0]?.evidence ?? "environment signal", processChain };
  }
  if (processMatches.length > 0) {
    const nearest = processMatches[0];
    return { editor: nearest?.editor ?? null, confidence: "medium", evidence: `nearest matching parent process: ${nearest?.processInfo.name ?? "unknown"}`, processChain };
  }
  if (environmentMatches.length > 0) {
    const first = environmentMatches[0];
    return { editor: first?.editor ?? null, confidence: "medium", evidence: first?.evidence ?? "environment signal", processChain };
  }
  return { editor: null, confidence: "none", evidence: "no active editor signal found", processChain };
}

export function detectRuntimeEditor(environment: NodeJS.ProcessEnv = process.env): EditorDetection {
  return detectEditorFromSignals(environment, getParentProcessChain());
}

export function runtimeEditorLabel(editor: RuntimeEditor): string {
  const labels: Record<RuntimeEditor, string> = {
    codex: "Codex",
    opencode: "OpenCode",
    claude: "Claude Code",
    "claude-desktop": "Claude Desktop",
    cursor: "Cursor",
    vscode: "Visual Studio Code",
  };
  return labels[editor];
}
