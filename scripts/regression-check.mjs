import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { detectEditorFromSignals } from "../dist/editor-detection.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliEntry = join(repositoryRoot, "dist", "cli.js");

function sanitizedEnvironment(overrides = {}) {
  const environment = { ...process.env, ...overrides };
  for (const key of ["GEMINI_API_KEY", "OPENAI_API_KEY", "CLAUDE_CODE", "CURSOR_BUILD", "OPENCODE", "VSCODE_CWD", "VSCODE_PID"]) {
    delete environment[key];
  }
  return { ...environment, ...overrides };
}

function runCli(args, environment, timeoutMs = 240_000) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [cliEntry, ...args], {
      cwd: repositoryRoot,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      rejectPromise(new Error(`CLI timed out: ${args.join(" ")}`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", rejectPromise);
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise({ stdout, stderr });
      else rejectPromise(new Error(`CLI failed (${code}): ${stderr || stdout}`));
    });
  });
}

function callAnalyzeImages(environment, argumentsValue, timeoutMs = 180_000) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [cliEntry, "serve"], {
      cwd: repositoryRoot,
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdoutBuffer = "";
    let stderr = "";
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      if (error) rejectPromise(error);
      else resolvePromise(value);
    };
    const timer = setTimeout(() => finish(new Error(`MCP call timed out: ${stderr}`)), timeoutMs);
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);

    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split(/\r?\n/u);
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          finish(new Error(`Invalid MCP output: ${line}`));
          return;
        }
        if (message.id === 1) {
          if (message.error) return finish(new Error(`Initialize failed: ${JSON.stringify(message.error)}`));
          send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
          send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "analyze_images", arguments: argumentsValue } });
        } else if (message.id === 2) {
          if (message.error) return finish(new Error(`Tool call failed: ${JSON.stringify(message.error)}`));
          finish(undefined, message.result);
        }
      }
    });
    child.once("error", (error) => finish(error));
    child.once("exit", (code) => {
      if (!settled) finish(new Error(`MCP server exited early (${code}): ${stderr}`));
    });
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "omni-regression", version: "1.0.0" } },
    });
  });
}

function resultText(result) {
  const text = result?.content?.find((item) => item?.type === "text")?.text;
  assert.equal(typeof text, "string", "MCP result must contain text");
  return text;
}

const environmentDetection = detectEditorFromSignals({ TERM_PROGRAM: "vscode" }, []);
assert.equal(environmentDetection.editor, "vscode");
assert.equal(environmentDetection.confidence, "high");
const processDetection = detectEditorFromSignals({}, [{ pid: 10, parentPid: 1, name: "Cursor.exe", commandLine: "Cursor.exe" }]);
assert.equal(processDetection.editor, "cursor");
const cursorTerminalDetection = detectEditorFromSignals(
  { TERM_PROGRAM: "vscode" },
  [{ pid: 10, parentPid: 1, name: "Cursor.exe", commandLine: "Cursor.exe" }],
);
assert.equal(cursorTerminalDetection.editor, "cursor", "Cursor's VS Code-compatible terminal must not be misidentified as VS Code");

const temporaryRoot = await mkdtemp(join(tmpdir(), "omni-vision-pro-regression-"));
try {
  const attachmentRoot = join(temporaryRoot, "opencode");
  await mkdir(attachmentRoot, { recursive: true });
  const oldImage = join(attachmentRoot, "old-project-shot.png");
  const firstImage = join(attachmentRoot, "attachment-first.png");
  const secondImage = join(attachmentRoot, "attachment-second.png");
  await sharp({ create: { width: 160, height: 64, channels: 3, background: "#ffffff" } }).png().toFile(oldImage);
  await sharp({ create: { width: 160, height: 64, channels: 3, background: "#dce8ff" } }).png().toFile(firstImage);
  await sharp({ create: { width: 160, height: 64, channels: 3, background: "#e6f7ef" } }).png().toFile(secondImage);
  const now = Date.now();
  await utimes(oldImage, new Date(now - 20 * 60_000), new Date(now - 20 * 60_000));
  await utimes(firstImage, new Date(now - 2 * 60_000), new Date(now - 2 * 60_000));
  await utimes(secondImage, new Date(now - 60_000), new Date(now - 60_000));

  const imageEnvironment = sanitizedEnvironment({
    TEMP: temporaryRoot,
    TMP: temporaryRoot,
    TMPDIR: temporaryRoot,
    OPENCODE: "1",
    OMNI_INCLUDE_ABSOLUTE_PATHS: "true",
    OMNI_RECENT_ATTACHMENT_MS: "600000",
    OMNI_VISION_PROVIDER: "ocr",
  });
  const automatic = resultText(await callAnalyzeImages(imageEnvironment, { max_auto_images: 2 }));
  assert.match(automatic, /--- \[Image Index 1\] Visual Analysis ---/u);
  assert.match(automatic, /--- \[Image Index 2\] Visual Analysis ---/u);
  assert.ok(automatic.indexOf("attachment-first.png") < automatic.indexOf("attachment-second.png"), "automatic images must preserve chronological upload order");
  assert.ok(!automatic.includes("old-project-shot.png"), "images older than the session window must not be auto-selected");

  const explicit = resultText(await callAnalyzeImages(imageEnvironment, { image_paths: oldImage }));
  assert.match(explicit, /tier 1: absolute path/u);
  assert.match(explicit, /old-project-shot\.png/u);

  const setupHome = join(temporaryRoot, "setup-home");
  await mkdir(setupHome, { recursive: true });
  const setupEnvironment = sanitizedEnvironment({
    OMNI_SETUP_HOME: setupHome,
    OMNI_RUNTIME_PACKAGE_SPEC: repositoryRoot,
    TERM_PROGRAM: "vscode",
  });
  const setup = await runCli(["setup", "--yes", "--provider", "ocr"], setupEnvironment);
  assert.match(setup.stdout, /Active client detected: Visual Studio Code/u);
  const vscodeConfig = join(setupHome, ".vscode-user", "mcp.json");
  assert.ok(existsSync(vscodeConfig), "active VS Code config must be created");
  const vscodeDocument = JSON.parse(await readFile(vscodeConfig, "utf8"));
  assert.ok(vscodeDocument.servers?.["omni-vision-pro"], "VS Code MCP entry must be present");
  assert.ok(!existsSync(join(setupHome, ".cursor", "mcp.json")), "Cursor config must not be modified by single-editor setup");
  assert.ok(!existsSync(join(setupHome, ".config", "opencode", "opencode.json")), "OpenCode config must not be modified by single-editor setup");
  assert.ok(!existsSync(join(setupHome, ".claude-desktop", "claude_desktop_config.json")), "Claude Desktop config must not be modified by single-editor setup");

  console.log("Regression checks passed: editor detection, three-tier image discovery, ordering, recency, and single-target setup.");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
