#!/usr/bin/env node
// After a STABLE release: should the `next` channel (npm dist-tag `next`, Docker `:next`) move to it?
//
// Rule: move `next` to the new stable version only when that version is NEWER than what `next` points to now.
//   - 2.4.0 released, next = 2.4.0-beta.12 → move (the beta line has shipped; @next users would run an older build).
//   - 2.4.1 released, next = 2.5.0-beta.3  → keep (a newer beta from a working branch is in flight).
//   - next unset                           → move.
//
// Usage: node .github/scripts/next-channel.mjs <stable version> [<current next version>]
//   The current version defaults to `npm view digital-ai-testing-mcp dist-tags.next` (public, no credentials).
//   npm's `next` is the reference for Docker too: both are published by the same release runs.
// Outputs (GITHUB_OUTPUT, else stdout): move=true|false, current=<version or empty>
import { appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z][0-9A-Za-z.-]*))?$/;

/** True when `stable` should replace `current` as the `next` channel. `stable` has no prerelease part. */
export function shouldMoveNext(stable, current) {
  const s = VERSION_RE.exec(stable);
  if (!s || s[4]) throw new Error(`"${stable}" is not a stable version like 2.4.0`);
  if (!current) return true;
  const c = VERSION_RE.exec(current);
  if (!c) throw new Error(`the current next version "${current}" is not a version`);
  for (let i = 1; i <= 3; i++) {
    const d = Number(s[i]) - Number(c[i]);
    if (d !== 0) return d > 0;
  }
  // Same major.minor.patch: a stable release is newer than its own prereleases, and equal to itself.
  return Boolean(c[4]);
}

function main() {
  const [stable, given] = process.argv.slice(2);
  if (!stable) throw new Error('usage: next-channel.mjs <stable version> [<current next version>]');
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const current =
    given ?? execFileSync(npm, ['view', 'digital-ai-testing-mcp', 'dist-tags.next'], { encoding: 'utf8', shell: process.platform === 'win32' }).trim();
  const move = shouldMoveNext(stable.replace(/^v/, ''), current);
  const lines = [`move=${move}`, `current=${current}`];
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, lines.join('\n') + '\n');
  else console.log(lines.join('\n'));
  console.error(move ? `next (${current || 'unset'}) is older than ${stable}: move it` : `next (${current}) is newer than ${stable}: keep it`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
