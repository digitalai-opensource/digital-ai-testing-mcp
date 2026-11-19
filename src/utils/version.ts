import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

// Single source of truth for the server version: package.json.
// MCP_SERVER_VERSION (if set) overrides; otherwise the hardcoded fallbacks
// scattered through the code drift from the real release version.
let cached: string | null = null;

export function getServerVersion(): string {
  if (process.env.MCP_SERVER_VERSION) return process.env.MCP_SERVER_VERSION;
  if (cached) return cached;
  try {
    // Resolves from both dist/utils/ (compiled) and src/utils/ (tsx) to the repo root.
    const pkgPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
    cached = pkg.version ?? '0.0.0';
  } catch {
    cached = '0.0.0';
  }
  return cached;
}

export const PACKAGE_NAME = 'digital-ai-testing-mcp';

/**
 * The npm spec to start or point people at: `@latest` normally; `@next` when the running version is a prerelease
 * (2.4.0-beta.1) — prereleases are published to npm `next` only (.github/scripts/release-channel.sh), so a beta keeps
 * its users on the beta channel.
 */
/**
 * The npx command to print for a person to type. On Windows it is `npx.cmd`: npm installs `npx.ps1` next to
 * `npx.cmd`, PowerShell prefers the .ps1, and Windows PowerShell 5.1's default execution policy refuses to run it
 * ("running scripts is disabled on this system" — seen live 2026-11-19). `npx.cmd` works in every Windows shell.
 * Client entries never use either: they run node directly (see buildLaunchEntry).
 */
export function npxCommand(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'npx.cmd' : 'npx';
}

export function packageSpec(version: string | undefined): string {
  return `${PACKAGE_NAME}@${version && version.includes('-') ? 'next' : 'latest'}`;
}
