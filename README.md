# omni-vision-pro

`omni-vision-pro` is a local Model Context Protocol (MCP) server that turns screenshots, source code, folders, and ZIP archives into clean text context for non-vision models.

It is designed for OpenCode, Claude Desktop, VS Code MCP clients, and other applications that can launch a standard `stdio` MCP server.

## What it provides

The server exposes three tools:

- `analyze_images` — analyzes one image or an ordered array of images. It accepts normal paths, `file://` URLs, Markdown image links, OpenCode attachment references, and `data:image/...;base64,...` URLs.
- `read_code_context` — reads a code file or directory and returns a file tree plus safe text contents.
- `read_zip_context` — inspects a `.zip` archive entirely in memory and returns a virtual file tree plus safe text contents.

Images are always processed sequentially in the exact order supplied. Every result has a delimiter such as:

```text
--- [Index 1] Visual UI JSON Analysis (Provider: OpenAI) ---
```

## Image provider order

For every image, the server uses the first provider that succeeds:

1. Gemini when `GEMINI_API_KEY` is configured.
2. OpenAI when `OPENAI_API_KEY` is configured.
3. Local Tesseract OCR when no cloud key is configured or cloud providers fail.

If both cloud keys are configured, Gemini is intentionally tried first and OpenAI is the second cloud fallback. A failure on one image does not stop later images.

### OpenAI cost controls

Before an image is sent to OpenAI, `sharp` automatically:

- applies EXIF orientation;
- limits the output to a 1024 × 1024 bounding box without enlargement;
- re-encodes screenshots/alpha images as optimized PNG and photographs as JPEG;
- strips unnecessary metadata; and
- sends the image with an explicit `detail: "low"` image-content setting.

The completion is also constrained to concise JSON with a fixed output-token ceiling. This is strongly cost-optimized, but exact price cannot be permanently guaranteed because provider pricing, generated output, and retries can change. OpenAI low-detail mode also internally uses a reduced representation, so tiny text, precise coordinates, and model-estimated colors are best-effort rather than pixel-perfect.

To improve deterministic visual context without additional vision tokens, the server measures the source dimensions, output dimensions, dominant color, and an eight-color local palette with `sharp`.

### Gemini model compatibility

The requested default is `gemini-1.5-flash`. Google has retired that model in some/current API environments, so the server automatically tries `gemini-2.5-flash` only when the legacy model is reported unavailable. You can choose a model explicitly:

```env
GEMINI_MODEL=gemini-2.5-flash
```

You may also change only the automatic fallback:

```env
GEMINI_FALLBACK_MODEL=gemini-2.5-flash
```

### Local OCR

Tesseract OCR requires no API key. Its English language data is packaged locally, so normal OCR fallback does not need to download a language file at runtime.

OCR extracts visible text only. It does not reliably infer layout, icons, component boundaries, or element colors.

## OpenCode image-path handling

OpenCode can represent an attached image in more than one way. `omni-vision-pro` handles the recoverable forms by:

- using exact absolute paths;
- resolving paths relative to the MCP server working directory;
- decoding `file://` paths, quoted paths, `@path` references, and Markdown image links;
- checking known OpenCode data/cache locations and `${temporary-directory}/opencode`;
- checking system temporary directories for an exact filename match;
- recognizing the known `opencode-clipboard.png` temporary filename; and
- accepting an inline `data:image/...;base64,...` URL when the MCP client forwards the attachment bytes directly.

The cache scan is bounded by depth and entry limits, never scans an entire home drive, and does not follow symlinks or junctions.

An important host limitation: some OpenCode builds keep pasted images only as in-memory data URLs and never create a durable file. No filesystem scanner can recover bytes that were never written. In that case, the client/model must pass the attachment's data URL to `analyze_images`; the tool supports it directly and does not require copying the image into a special folder.

## Safety for code and ZIP files

Code and archive tools intentionally omit common generated/vendor folders:

```text
node_modules, .git, dist, build, .next, coverage, __MACOSX
```

They also omit likely secrets, including:

```text
.env, .env.*, id_rsa, id_ed25519, *.pem, *.key, *.p12, *.pfx,
.npmrc, .netrc, .pypirc, credentials.json, service-account.json
```

Additional protections include:

- binary-content detection in addition to extension checks;
- strict UTF-8 validation;
- no filesystem symlink traversal;
- maximum file count, per-file size, and aggregate output limits;
- ZIP path traversal, drive path, UNC path, control character, duplicate path, encryption, and symlink rejection;
- ZIP entry, inflated-size, aggregate-size, and compression-ratio limits;
- no nested archive expansion; and
- no ZIP extraction to disk.

For a stricter filesystem boundary, configure `OMNI_ALLOWED_ROOTS`. Code and ZIP tools will only read paths inside those roots. Images are exempt so OpenCode/system temporary attachments can still resolve.

Windows uses semicolons between roots:

```env
OMNI_ALLOWED_ROOTS=C:\Users\you\Projects;D:\Work
```

macOS and Linux use colons:

```env
OMNI_ALLOWED_ROOTS=/Users/you/Projects:/Volumes/Work
```

## Requirements

- Node.js 20.10 or newer. A current Node.js LTS release is recommended.
- An MCP-compatible desktop/editor client.
- Optional: a Gemini or OpenAI API key. No key is needed for OCR-only mode.

## Install from npm after publishing

This workspace contains a complete npm package, but building it here does not publish it to the npm registry. The `npx` examples below become usable after you publish `omni-vision-pro`. To use these files immediately, follow **Use a local source checkout** below and use its absolute `dist/index.js` configuration.

After publication, you normally do not need a global installation. The configuration examples below use `npx`, which downloads and launches the package automatically.

For repeatable/offline startup after an initial install, you can instead run:

```bash
npm install --global omni-vision-pro
```

Then use `omni-vision-pro` as the client command.

## Configure OpenCode after npm publication

Create `opencode.json` in your project folder. You can instead use the global OpenCode configuration at `~/.config/opencode/opencode.json`.

### Gemini

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "omni-vision-pro": {
      "type": "local",
      "command": ["npx", "-y", "omni-vision-pro"],
      "environment": {
        "GEMINI_API_KEY": "PASTE_YOUR_GEMINI_KEY_HERE",
        "GEMINI_MODEL": "gemini-2.5-flash"
      },
      "enabled": true,
      "timeout": 120000
    }
  }
}
```

### OpenAI

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "omni-vision-pro": {
      "type": "local",
      "command": ["npx", "-y", "omni-vision-pro"],
      "environment": {
        "OPENAI_API_KEY": "PASTE_YOUR_OPENAI_KEY_HERE"
      },
      "enabled": true,
      "timeout": 120000
    }
  }
}
```

### Free OCR-only mode

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "omni-vision-pro": {
      "type": "local",
      "command": ["npx", "-y", "omni-vision-pro"],
      "enabled": true,
      "timeout": 120000
    }
  }
}
```

Restart OpenCode after saving. You can check the MCP connection with:

```bash
opencode mcp list
```

For project-local `.env` loading, set OpenCode's `cwd` to the folder containing `.env`, or put the key in the `environment` object as shown above. Client environment configuration is the most reliable choice for desktop applications.

## Configure Claude Desktop after npm publication

Open Claude Desktop, go to **Settings → Developer → Edit Config**, and add one of the configurations below.

Configuration file locations:

- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`

Claude Desktop is officially available on Windows and macOS. On Linux, use OpenCode or another standard MCP client.

### Gemini

```json
{
  "mcpServers": {
    "omni-vision-pro": {
      "command": "npx",
      "args": ["-y", "omni-vision-pro"],
      "env": {
        "GEMINI_API_KEY": "PASTE_YOUR_GEMINI_KEY_HERE",
        "GEMINI_MODEL": "gemini-2.5-flash"
      }
    }
  }
}
```

### OpenAI

```json
{
  "mcpServers": {
    "omni-vision-pro": {
      "command": "npx",
      "args": ["-y", "omni-vision-pro"],
      "env": {
        "OPENAI_API_KEY": "PASTE_YOUR_OPENAI_KEY_HERE"
      }
    }
  }
}
```

### Free OCR-only mode

```json
{
  "mcpServers": {
    "omni-vision-pro": {
      "command": "npx",
      "args": ["-y", "omni-vision-pro"]
    }
  }
}
```

Completely quit and reopen Claude Desktop after saving the file.

## Use a local source checkout

From this package folder:

```bash
npm install
npm run build
```

Then point the client to the built entry file using an absolute path.

OpenCode example on Windows:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "omni-vision-pro": {
      "type": "local",
      "command": ["node", "C:/full/path/to/omni-vision-pro/dist/index.js"],
      "enabled": true,
      "timeout": 120000
    }
  }
}
```

Claude Desktop example:

```json
{
  "mcpServers": {
    "omni-vision-pro": {
      "command": "node",
      "args": ["C:/full/path/to/omni-vision-pro/dist/index.js"]
    }
  }
}
```

Forward slashes work in Windows JSON and avoid backslash escaping mistakes.

## Use `.env`

The server loads `.env` from its current working directory and, for a local package checkout, the package root. Existing environment variables always take priority.

Example:

```env
# Choose either or both. Gemini is tried first when both exist.
GEMINI_API_KEY=your_gemini_key
GEMINI_MODEL=gemini-2.5-flash
OPENAI_API_KEY=your_openai_key

# Optional filesystem boundary for code and ZIP tools.
OMNI_ALLOWED_ROOTS=C:\Users\you\Projects
```

Never commit `.env` or API keys to source control.

## Example requests

After the MCP server is connected, ask your client naturally:

```text
Use omni-vision-pro to analyze this screenshot and reconstruct its UI hierarchy.
```

```text
Use omni-vision-pro to analyze these three screenshots in the exact order attached. Compare the responsive layout changes.
```

```text
Use omni-vision-pro to read the code context from C:/Projects/my-app/src and summarize the architecture.
```

```text
Use omni-vision-pro to inspect C:/Downloads/source-bundle.zip without extracting it and return the file tree plus relevant source files.
```

## Tool inputs

### `analyze_images`

```json
{
  "image_paths": [
    "C:/Screenshots/home.png",
    "C:/Screenshots/settings.png"
  ],
  "prompt": "Focus on reusable React components and accessibility."
}
```

`image_paths` may also be a single string. The tool processes at most 10 images by default.

### `read_code_context`

```json
{
  "path": "C:/Projects/my-app/src",
  "max_files": 80,
  "max_output_bytes": 750000
}
```

### `read_zip_context`

```json
{
  "path": "C:/Downloads/project.zip",
  "max_files": 80,
  "max_output_bytes": 750000
}
```

## Privacy

- Gemini mode transmits a resized copy of each image to Google.
- OpenAI mode transmits a resized copy of each image to OpenAI.
- Tesseract mode keeps OCR processing on the local machine.
- Source files and ZIP contents are read locally and are not automatically sent to Gemini or OpenAI by this server. The MCP client/model may still include returned tool text in its own model context according to that client's privacy policy.

## Troubleshooting

### The client cannot find `npx`

Check that Node.js is installed:

```bash
node --version
npx --version
```

Desktop applications sometimes have a smaller `PATH` than your terminal. Find the full path:

- Windows: `where npx`
- macOS/Linux: `which npx`

Then use that absolute path as the client command. On Windows it may look like `C:\\Program Files\\nodejs\\npx.cmd` inside JSON.

### The first OCR request takes longer

Tesseract starts a local worker on first fallback. Keep the OpenCode timeout at `120000` milliseconds or increase it if the computer is slow.

### An image is not found

The resolver automatically tries normal paths and known OpenCode/system temporary locations. If the image existed only in OpenCode memory, ask the client/model to pass the attachment as an inline data URL to `analyze_images`; no manual file-copy step is required.

### Gemini fails but the key is valid

Set an active model explicitly:

```env
GEMINI_MODEL=gemini-2.5-flash
```

The server also automatically falls back from the requested legacy `gemini-1.5-flash` model when the API reports it unavailable.

### JSON configuration errors

Check commas and quotation marks carefully. JSON does not allow comments. On Windows, use forward slashes in file paths or double every backslash.

## Build and verify

```bash
npm run check
npm run build
```

The server uses standard MCP over `stdio`. Protocol messages use stdout exclusively; operational diagnostics are written to stderr so they cannot corrupt MCP traffic.
