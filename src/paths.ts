import { readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";

interface PackageMetadata {
  name?: unknown;
  version?: unknown;
}

const packageMetadata = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as PackageMetadata;

if (typeof packageMetadata.name !== "string" || typeof packageMetadata.version !== "string") {
  throw new Error("omni-vision-pro package metadata is invalid");
}

export const PACKAGE_NAME = packageMetadata.name;
export const PACKAGE_VERSION = packageMetadata.version;

function setupHomeOverride(): string | undefined {
  const explicit = process.env.OMNI_SETUP_HOME?.trim();
  return explicit ? resolve(explicit) : undefined;
}

export function getSetupHome(): string {
  return setupHomeOverride() ?? resolve(homedir());
}

export function getOmniConfigDirectory(): string {
  const explicit = process.env.OMNI_CONFIG_DIR?.trim();
  if (explicit) return resolve(explicit);

  // OMNI_SETUP_HOME is also an isolation boundary. Once it is supplied, do
  // not fall back to the real user's APPDATA/XDG directories.
  const isolatedHome = setupHomeOverride();
  if (isolatedHome) return join(isolatedHome, ".config", PACKAGE_NAME);

  if (platform() === "win32") {
    const appData = process.env.APPDATA?.trim();
    if (appData) return resolve(appData, PACKAGE_NAME);
  }

  const xdgConfig = process.env.XDG_CONFIG_HOME?.trim();
  if (xdgConfig) return resolve(xdgConfig, PACKAGE_NAME);
  return join(getSetupHome(), ".config", PACKAGE_NAME);
}

export function getOmniDataDirectory(): string {
  const explicit = process.env.OMNI_DATA_DIR?.trim();
  if (explicit) return resolve(explicit);

  const isolatedHome = setupHomeOverride();
  if (isolatedHome) return join(isolatedHome, ".local", "share", PACKAGE_NAME);

  if (platform() === "win32") {
    const localAppData = process.env.LOCALAPPDATA?.trim();
    if (localAppData) return resolve(localAppData, PACKAGE_NAME);
  }

  if (platform() === "darwin") {
    return join(getSetupHome(), "Library", "Application Support", PACKAGE_NAME);
  }

  const xdgData = process.env.XDG_DATA_HOME?.trim();
  if (xdgData) return resolve(xdgData, PACKAGE_NAME);
  return join(getSetupHome(), ".local", "share", PACKAGE_NAME);
}

export function getOmniEnvironmentFile(): string {
  const explicit = process.env.OMNI_CONFIG_FILE?.trim();
  return explicit ? resolve(explicit) : join(getOmniConfigDirectory(), ".env");
}

export function getManagedRuntimeDirectory(version: string): string {
  return join(getOmniDataDirectory(), "runtimes", version);
}

export function getManagedRuntimeEntry(version: string): string {
  return join(getManagedRuntimeDirectory(version), "node_modules", PACKAGE_NAME, "dist", "cli.js");
}
