#!/usr/bin/env node
// Waits until a just-published version can really be installed, so the release can move `latest`/`next` to it only
// then. The registry lists a new version minutes before its tarball can be downloaded; a channel moved at publish time
// sent every `npx …@latest` in that gap to a 404 (about nine minutes after 2.4.2, 2026-11-20).
//
// Two phases:
//   1. The version document and the tarball, both with a cache-busting query: the origin has the file. These requests
//      never touch the plain URLs, so they cannot leave a cached 404 there.
//   2. The PLAIN tarball URL, the one npm requests: no CDN edge still serves a cached 404 for it (something may have
//      requested it early, e.g. a registry mirror or scanner).
// Both must pass `confirmations` times in a row, then the script waits `marginMs` and exits 0. Timeout → exit 1, and
// the channels stay where they were (users keep the previous release).
//
// Usage: node .github/scripts/wait-for-npm.mjs <version> [<package>]
// Env (optional): WAIT_TIMEOUT_SECONDS (default 1500), WAIT_INTERVAL_SECONDS (20), WAIT_MARGIN_SECONDS (60).
import { pathToFileURL } from 'node:url';

const REGISTRY = 'https://registry.npmjs.org';

export function tarballUrl(pkg, version) {
  const base = pkg.startsWith('@') ? pkg.split('/')[1] : pkg;
  return `${REGISTRY}/${pkg}/-/${base}-${version}.tgz`;
}

/**
 * Resolves true when `version` of `pkg` is installable, false on timeout. Every dependency is injected for tests:
 * fetch(url) → { status }, sleep(ms), now() → ms, log(line).
 */
export async function waitForNpm({
  pkg,
  version,
  fetch: get = (url) => fetch(url, { cache: 'no-store', headers: { 'user-agent': 'release-workflow' } }),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(),
  log = (line) => console.error(line),
  timeoutMs = 25 * 60_000,
  intervalMs = 20_000,
  marginMs = 60_000,
  confirmations = 2,
}) {
  const plain = tarballUrl(pkg, version);
  const status = async (url) => {
    try {
      return (await get(url)).status;
    } catch (e) {
      return `error (${e instanceof Error ? e.message : e})`;
    }
  };
  const start = now();
  const elapsed = () => `${Math.round((now() - start) / 1000)} s`;
  let phase = 1;
  let streak = 0;
  for (;;) {
    let ok;
    if (phase === 1) {
      const cb = `cb=${now()}`;
      const doc = await status(`${REGISTRY}/${pkg}/${version}?${cb}`);
      const tgz = await status(`${plain}?${cb}`);
      ok = doc === 200 && tgz === 200;
      log(`[${elapsed()}] origin: version document ${doc}, tarball ${tgz}`);
    } else {
      const tgz = await status(plain);
      ok = tgz === 200;
      log(`[${elapsed()}] plain tarball URL (what npm downloads): ${tgz}`);
    }
    streak = ok ? streak + 1 : 0;
    if (streak >= confirmations) {
      if (phase === 2) break;
      phase = 2;
      streak = 0;
      continue;
    }
    if (now() - start >= timeoutMs) {
      log(`${pkg}@${version} could not be downloaded after ${elapsed()}; the channels are not moved.`);
      return false;
    }
    await sleep(intervalMs);
  }
  log(`${pkg}@${version} can be downloaded (${elapsed()}). Waiting ${Math.round(marginMs / 1000)} s more for the other CDN edges.`);
  await sleep(marginMs);
  return true;
}

async function main() {
  const [version, pkg = 'digital-ai-testing-mcp'] = process.argv.slice(2);
  if (!version) throw new Error('usage: wait-for-npm.mjs <version> [<package>]');
  const secs = (name, d) => 1000 * (Number(process.env[name]) || d);
  const ok = await waitForNpm({
    pkg,
    version: version.replace(/^v/, ''),
    timeoutMs: secs('WAIT_TIMEOUT_SECONDS', 1500),
    intervalMs: secs('WAIT_INTERVAL_SECONDS', 20),
    marginMs: secs('WAIT_MARGIN_SECONDS', 60),
  });
  process.exit(ok ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
