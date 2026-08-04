# omni-vision-pro

`omni-vision-pro` is a local Model Context Protocol (MCP) server that gives text-only coding models useful context from screenshots, source trees, and ZIP archives.

It is designed for Codex, OpenCode, Claude Code, Cursor, Claude Desktop, and other clients that can launch a local MCP server over `stdio`.

## Fastest setup

Requirements:

- Node.js 20.10 or newer
- npm/npx
- At least one supported MCP client

Check your installation:

```bash
node --version
npm --version
```

Run the guided installer:

```bash
npx --yes omni-vision-pro@latest setup
```

The installer:

- detects Codex, OpenCode, Claude Code, and Cursor;
- asks which clients to configure;
- lets you choose free local OCR, Gemini, OpenAI, or both cloud providers;
- stores cloud keys in one private Omni settings file instead of copying them into every client config;
- installs a private, version-pinned runtime;
- preserves unrelated client settings and backs up JSON/JSONC files before changing them; and
- starts the MCP server and verifies that all three tools are discoverable.

### Copy and paste this into an AI coding chat

```text
Run this for me, then run its doctor:
npx --yes omni-vision-pro@latest setup --yes --provider ocr
npx --yes omni-vision-pro@latest doctor

Do not change unrelated MCP entries or put API keys in commands or JSON files. Tell me which apps I need to restart and where I need to approve the MCP server.
```

That instruction selects the free, fully local OCR mode. To enable Gemini or OpenAI, run the guided setup yourself so the key can be entered through its hidden prompt.

## Choose the vision mode

### Free local OCR

Choose this when screenshots mainly contain readable text and you do not want any image sent to a cloud provider.

```bash
npx --yes omni-vision-pro@latest setup --provider ocr
```

Tesseract English language data is bundled with the package. OCR extracts text but does not reliably infer icons, component boundaries, layout, or colors.

### Gemini

Choose Gemini for full UI/layout JSON analysis:

```bash
npx --yes omni-vision-pro@latest setup --provider gemini
```

The installer asks for `GEMINI_API_KEY` through a hidden prompt if it is not already available in your environment. The server uses Gemini first and falls back to local OCR if the API fails or its quota is exhausted.

The originally requested `gemini-1.5-flash` model is retired in current Google API environments. The server retains compatibility behavior and falls back to `gemini-2.5-flash`. To skip the legacy attempt, add this to the private Omni `.env` file:

```env
GEMINI_MODEL=gemini-2.5-flash
```

### OpenAI

Choose OpenAI for cost-optimized UI/layout JSON analysis:

```bash
npx --yes omni-vision-pro@latest setup --provider openai
```

Images are auto-oriented, resized inside a 1024 by 1024 box, compressed with `sharp`, and sent to `gpt-4o-mini` with an explicit `detail: "low"` setting. Cloud failure automatically falls back to local OCR.

Low-detail mode is intentionally economical, but exact cost cannot be permanently guaranteed because pricing and output length can change. It also uses a reduced image representation, so tiny text, exact coordinates, and model-estimated colors are best-effort rather than pixel-perfect. The server supplements the model response with locally measured dimensions, dominant color, and a compact color palette.

### Gemini plus OpenAI fallback

Configure both keys when you want the provider order Gemini, then OpenAI, then local OCR:

```bash
npx --yes omni-vision-pro@latest setup --provider both
```

Never pass keys with command-line flags. The CLI intentionally rejects `--gemini-key` and `--openai-key` because shell history and process lists can expose them.

## Set up particular clients

The guided installer can configure one client:

```bash
npx --yes omni-vision-pro@latest setup codex
npx --yes omni-vision-pro@latest setup opencode
npx --yes omni-vision-pro@latest setup claude-code
npx --yes omni-vision-pro@latest setup cursor
```

Or all supported clients:

```bash
npx --yes omni-vision-pro@latest setup all
```

User-wide setup is the default. For a project-only OpenCode, Claude Code, or Cursor entry, run the command from the project folder with `--project`:

```bash
npx --yes omni-vision-pro@latest setup cursor --project
```

Codex project setup is intentionally manual because Codex only loads project `.codex/config.toml` from trusted projects. See [Codex](#codex).

For unattended, OCR-only setup of detected clients:

```bash
npx --yes omni-vision-pro@latest setup --yes --provider ocr
```

## After setup

Completely restart or reload the configured client:

- Codex desktop app: open **Settings > MCP servers**, then restart if requested.
- Codex CLI/TUI: start a new session and use `/mcp`.
- Codex IDE extension: select **Restart extension** from its MCP server settings.
- OpenCode: close and reopen OpenCode, then run `opencode mcp list` if needed.
- Claude Code: restart the session and use `/mcp` or `claude mcp list`.
- Cursor: reload the window, open **Settings > Tools & MCP**, and enable the server if it is disabled.

Project-scoped MCP files can trigger a trust or permission prompt. Review the command, confirm that it points to `omni-vision-pro`, and approve it only if you trust the project.

Then attach an image and ask:

```text
Use omni-vision-pro to analyze this image. Return the UI hierarchy, visible text, colors, interactions, accessibility issues, and reusable components.
```

Other useful requests:

```text
Use omni-vision-pro to analyze these screenshots in the exact attached order and compare their responsive layouts.
```

```text
Use omni-vision-pro to read the code context from this project's src folder and summarize its architecture.
```

```text
Use omni-vision-pro to inspect this ZIP without extracting it and return its safe file tree and source contents.
```

## Doctor and uninstall

Verify the managed runtime and every detected client entry:

```bash
npx --yes omni-vision-pro@latest doctor
```

Check one client:

```bash
npx --yes omni-vision-pro@latest doctor cursor
```

Remove installer-owned entries from detected clients:

```bash
npx --yes omni-vision-pro@latest uninstall
```

Remove entries from every supported client:

```bash
npx --yes omni-vision-pro@latest uninstall --all
```

Project entries require `--project` and must be removed from the project directory:

```bash
npx --yes omni-vision-pro@latest uninstall cursor --project
```

Uninstall removes only an `omni-vision-pro` entry that the installer recognizes as its own. It refuses to overwrite or remove a foreign same-name entry. Provider settings are deliberately kept so reinstalling does not lose keys.

## Manual configuration

Manual examples use `@latest`. For reproducible startup, replace it with an exact version such as `@1.1.0`.

The MCP launch command is:

```text
npx --yes omni-vision-pro@latest serve
```

Cloud keys do not need to appear in the client JSON/TOML. Put them in the dedicated settings file described in [API keys and private settings](#api-keys-and-private-settings), or expose them to the client process as normal environment variables.

### Codex

Codex CLI, the Codex IDE extension, and the Codex desktop app share `~/.codex/config.toml`.

The simplest user-wide command is:

```bash
codex mcp add omni-vision-pro -- npx --yes omni-vision-pro@latest serve
```

Verify it:

```bash
codex mcp get omni-vision-pro --json
codex mcp list
```

For manual TOML, add this to `~/.codex/config.toml`, or to `.codex/config.toml` inside a trusted project:

```toml
[mcp_servers.omni-vision-pro]
command = "npx"
args = ["--yes", "omni-vision-pro@latest", "serve"]
startup_timeout_sec = 120
tool_timeout_sec = 1200
enabled = true
```

In the Codex desktop app you can instead open **Settings > MCP servers > Add server**, select **STDIO**, and enter the same command and arguments. Save, then select **Restart**.

### OpenCode

Add this to a project `opencode.json`/`opencode.jsonc`, or to the user config at `~/.config/opencode/opencode.json`. On Windows, `~` means your user folder, for example `C:\Users\you\.config\opencode\opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "omni-vision-pro": {
      "type": "local",
      "command": [
        "npx",
        "--yes",
        "omni-vision-pro@latest",
        "serve"
      ],
      "enabled": true,
      "timeout": 120000
    }
  }
}
```

Restart OpenCode and check:

```bash
opencode mcp list
```

OpenCode sometimes forwards pasted images as inline data rather than a durable file. `analyze_images` accepts `data:image/...;base64,...` directly. It also checks absolute and relative paths, known OpenCode cache locations, and bounded recent-image searches in system temporary folders; it never tells the user to copy an attachment into a special directory.

### Claude Code

For a private user-wide entry:

```bash
claude mcp add --scope user --transport stdio omni-vision-pro -- npx --yes omni-vision-pro@latest serve
```

For a team-shareable project entry, run this from the project root:

```bash
claude mcp add --scope project --transport stdio omni-vision-pro -- npx --yes omni-vision-pro@latest serve
```

The project command creates or updates `.mcp.json`. Claude Code asks users to approve project-scoped MCP servers before first use.

Equivalent `.mcp.json` content:

```json
{
  "mcpServers": {
    "omni-vision-pro": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "--yes",
        "omni-vision-pro@latest",
        "serve"
      ],
      "timeout": 1200000
    }
  }
}
```

Verify with:

```bash
claude mcp list
claude mcp get omni-vision-pro
```

### Cursor

#### One-click OCR installation

[Add omni-vision-pro to Cursor](cursor://anysphere.cursor-deeplink/mcp/install?name=omni-vision-pro&config=eyJ0eXBlIjoic3RkaW8iLCJjb21tYW5kIjoibnB4IiwiYXJncyI6WyItLXllcyIsIm9tbmktdmlzaW9uLXByb0BsYXRlc3QiLCJzZXJ2ZSJdfQ==)

Cursor will show the decoded MCP configuration before installation. Review it and approve only if it launches `npx --yes omni-vision-pro@latest serve`. The one-click link installs the MCP entry; it does not add a cloud API key, so it starts in local OCR mode unless the private Omni settings file already contains a key.

#### Manual Cursor configuration

Use `~/.cursor/mcp.json` for your user account or `.cursor/mcp.json` for one project:

```json
{
  "mcpServers": {
    "omni-vision-pro": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "--yes",
        "omni-vision-pro@latest",
        "serve"
      ]
    }
  }
}
```

Reload Cursor, open **Settings > Tools & MCP**, and switch the server on. A workspace entry may require project trust.

### Visual Studio Code

In VS Code, run **MCP: Add Server** from the Command Palette for a guided setup. Choose a local `stdio` server and enter the same `npx --yes omni-vision-pro@latest serve` launch command.

For manual setup, run **MCP: Open User Configuration** for an account-wide entry, or create `.vscode/mcp.json` in one project:

```json
{
  "servers": {
    "omni-vision-pro": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "--yes",
        "omni-vision-pro@latest",
        "serve"
      ]
    }
  }
}
```

Save the file, start the server from the inline action above its entry or run **MCP: List Servers**, and review the trust prompt before approving it. VS Code's official MCP setup reference is [Add and manage MCP servers in VS Code](https://code.visualstudio.com/docs/agent-customization/mcp-servers).

### Claude Desktop

Claude Desktop is not changed by the multi-client installer, but it can launch the same server. Add this to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "omni-vision-pro": {
      "command": "npx",
      "args": [
        "--yes",
        "omni-vision-pro@latest",
        "serve"
      ]
    }
  }
}
```

Common locations:

- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`

Completely quit and reopen Claude Desktop after saving.

## API keys and private settings

Guided setup stores keys in a dedicated `.env` file:

- Windows: `%APPDATA%\omni-vision-pro\.env`
- macOS/Linux: `${XDG_CONFIG_HOME:-~/.config}/omni-vision-pro/.env`

Example:

```env
# Choose either or both. Gemini is tried first when both are present.
GEMINI_API_KEY=your_gemini_key
GEMINI_MODEL=gemini-2.5-flash
OPENAI_API_KEY=your_openai_key
```

The server also reads a `.env` in its working directory, but only documented Gemini, OpenAI key, Omni, and OpenCode cache variables are accepted. Unrelated provider transport variables are ignored or removed so a project cannot redirect API requests or enable SDK debug logging.

Security rules:

- Never put API keys in chat messages, screenshots, command arguments, committed JSON/TOML, or source control.
- Prefer the installer's hidden key prompt.
- Restrict access to the private `.env`. Setup uses mode `0600` on macOS/Linux; Windows inherits the account directory's ACLs.
- Rotate a key immediately if it appears in terminal history, logs, a repository, or a shared configuration.
- Cloud modes upload the resized image to the selected provider. OCR mode keeps image processing local.

To erase retained credentials after uninstalling, delete only the private `.env` listed above. The managed runtime cache is stored under:

- Windows: `%LOCALAPPDATA%\omni-vision-pro\runtimes`
- macOS: `~/Library/Application Support/omni-vision-pro/runtimes`
- Linux: `${XDG_DATA_HOME:-~/.local/share}/omni-vision-pro/runtimes`

## Tools

### `analyze_images`

Accepts one image reference or an ordered array. Images are processed strictly in upload order and returned with delimiters such as:

```text
--- [Index 1] Visual UI JSON Analysis (Provider: OpenAI) ---
```

Example input:

```json
{
  "image_paths": [
    "C:/Screenshots/home.png",
    "C:/Screenshots/settings.png"
  ],
  "prompt": "Focus on reusable components and accessibility."
}
```

Supported references include absolute and relative paths, `file://` URLs, quoted paths, `@path`, Markdown image links, common OpenCode attachment references, and inline image data URLs. A failed image produces its own ordered result and does not stop later images.

### `read_code_context`

Reads a source file or directory and returns a clean file tree followed by text contents:

```json
{
  "path": "C:/Projects/my-app/src",
  "max_files": 80,
  "max_output_bytes": 750000
}
```

By default, code and ZIP access is limited to the MCP process working directory. To allow additional folders, set `OMNI_ALLOWED_ROOTS` in the private `.env`:

```env
# Windows: semicolon-separated
OMNI_ALLOWED_ROOTS=C:\Users\you\Projects;D:\Work
```

```env
# macOS/Linux: colon-separated
OMNI_ALLOWED_ROOTS=/Users/you/Projects:/Volumes/Work
```

### `read_zip_context`

Reads a `.zip` archive in memory without extracting it to disk:

```json
{
  "path": "C:/Downloads/project.zip",
  "max_files": 80,
  "max_output_bytes": 750000
}
```

The code and ZIP tools omit common generated folders, binaries, symbolic links, and likely secrets such as `.env`, private keys, credentials files, `node_modules`, `.git`, `dist`, `build`, and `.next`. ZIP handling also validates paths, entry counts, declared and actual sizes, compression ratios, CRC-32, duplicate paths, encryption, and malformed archives. Nested ZIPs are not expanded.

Returned source/archive text is explicitly marked as untrusted data for the consuming model. Filtering is defense in depth, not permission to process an archive from an untrusted sender without reviewing it.

## Troubleshooting

### Check the installed npm version

If a setup command behaves differently from this README, check the currently published version:

```bash
npm view omni-vision-pro version
```

Automatic setup needs `1.1.0` or newer. Update with `@latest` and try again.

### The desktop client cannot find `npx`

Guided setup normally avoids this after installation by configuring clients with the absolute Node path to its managed runtime. Manual and Cursor one-click configurations still use `npx`.

Find it with:

```powershell
where.exe npx
```

```bash
which npx
```

Then replace `npx` in the manual configuration with its full path. On Windows this is often `C:\Program Files\nodejs\npx.cmd`; JSON requires doubled backslashes, or you can use forward slashes.

### The MCP server is installed but not visible

1. Run `npx --yes omni-vision-pro@latest doctor`.
2. Completely restart the client or reload its extension/window.
3. Open the client's MCP settings and enable/approve `omni-vision-pro`.
4. For a project config, confirm that the project is trusted.
5. Check that Node.js is at least 20.10.

### OCR takes too long

The first Tesseract request starts a local worker. Keep client tool timeouts comfortably above 90 seconds; multi-image batches are sequential and may need several minutes.

### An attached image is not found

The resolver tries normal paths, OpenCode cache locations, known clipboard names, and bounded recent system-temp images. Some clients keep pasted bytes only in memory. In that case the client must pass the attachment as an inline image data URL, which `analyze_images` supports directly. No manual file-copy workaround is required.

### Gemini fails with a valid key

Use a currently available model in the private `.env`:

```env
GEMINI_MODEL=gemini-2.5-flash
```

Cloud errors and exhausted quota should still fall back to local OCR.

### The code or ZIP tool says the path is outside the allowed roots

The default boundary is the MCP server working directory. Add the intended project folder to `OMNI_ALLOWED_ROOTS`, restart the client, and try again. Do not use a drive root or your entire home directory unless that broad access is genuinely intended.

### A config file was changed unexpectedly

The installer creates timestamped backups before changing existing OpenCode/Cursor JSON or JSONC. It refuses to replace a same-name entry that it does not recognize as installer-owned. Restore the reported backup, then run `doctor`.

## Local source checkout

From this repository:

```bash
npm install
npm run check
npm run build
```

To test a local checkout, use a manual client entry that points directly to the built CLI:

```text
node C:/full/path/to/omni-vision-pro/dist/cli.js serve
```

For example, an OpenCode project entry on Windows is:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "omni-vision-pro": {
      "type": "local",
      "command": [
        "node",
        "C:/full/path/to/omni-vision-pro/dist/cli.js",
        "serve"
      ],
      "enabled": true,
      "timeout": 120000
    }
  }
}
```

Use an absolute path. Forward slashes avoid JSON backslash escaping on Windows.

## Privacy summary

- Gemini mode sends a resized copy of each image to Google.
- OpenAI mode sends a resized low-detail copy of each image to OpenAI.
- Tesseract mode processes images locally.
- Source and ZIP contents are read locally by this server and are not sent directly to the vision providers.
- The MCP host may include returned text in its own model context under that host's privacy policy.
- Absolute host paths are redacted from normal output unless `OMNI_INCLUDE_ABSOLUTE_PATHS=true` is explicitly configured.

## Development verification

```bash
npm run check
npm run build
npm pack --dry-run
npm audit --omit=dev
```

Protocol messages use stdout exclusively. Operational diagnostics use stderr so they cannot corrupt MCP `stdio` traffic.
