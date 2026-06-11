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
    // Resolves from both dist/utils/ (compiled) and src/utils/ (ts-node) to the repo root.
    const pkgPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
    cached = pkg.version ?? '0.0.0';
  } catch {
    cached = '0.0.0';
  }
  return cached;
}
