/**
 * The release workflow's wait before moving `latest`/`next` (.github/scripts/wait-for-npm.mjs): a channel moves only
 * once the new version can be downloaded, so `npx …@latest` never resolves to a tarball that still answers 404.
 */
import { describe, it, expect } from 'vitest';
import { waitForNpm, tarballUrl } from '../.github/scripts/wait-for-npm.mjs';

const PLAIN = 'https://registry.npmjs.org/digital-ai-testing-mcp/-/digital-ai-testing-mcp-2.4.3.tgz';

/** A fake registry: `ready(url, t)` says whether that URL answers 200 at time t (ms). Records every URL requested. */
function harness(ready: (url: string, t: number) => boolean) {
  let t = 0;
  const urls: string[] = [];
  const log: string[] = [];
  const opts = {
    pkg: 'digital-ai-testing-mcp',
    version: '2.4.3',
    fetch: async (url: string) => {
      urls.push(url);
      return { status: ready(url, t) ? 200 : 404 };
    },
    sleep: async (ms: number) => {
      t += ms;
    },
    now: () => t,
    log: (l: string) => log.push(l),
    timeoutMs: 600_000,
    intervalMs: 20_000,
    marginMs: 60_000,
  };
  return { opts, urls, log, time: () => t };
}

describe('wait for npm before moving a channel', () => {
  it('builds the tarball URL, scoped or not', () => {
    expect(tarballUrl('digital-ai-testing-mcp', '2.4.3')).toBe(PLAIN);
    expect(tarballUrl('@scope/pkg', '1.0.0')).toBe('https://registry.npmjs.org/@scope/pkg/-/pkg-1.0.0.tgz');
  });

  it('never requests the plain URL until the origin has the file (an early request could leave a cached 404)', async () => {
    const originAt = 100_000;
    const h = harness((url, t) => t >= originAt);
    expect(await waitForNpm(h.opts)).toBe(true);
    const firstPlain = h.urls.indexOf(PLAIN);
    expect(firstPlain).toBeGreaterThan(0);
    // Every request before it was cache-busted, and the last ones answered 200 at the origin.
    expect(h.urls.slice(0, firstPlain).every((u) => u.includes('?cb='))).toBe(true);
    expect(h.log.join('\n')).toContain('tarball 200');
  });

  it('waits out a cached 404 on the plain URL, then the margin', async () => {
    const h = harness((url, t) => (url.includes('?cb=') ? t >= 40_000 : t >= 200_000));
    expect(await waitForNpm(h.opts)).toBe(true);
    expect(h.time()).toBeGreaterThanOrEqual(200_000 + 20_000 + 60_000); // two plain 200s in a row, then the margin
    expect(h.log.join('\n')).toContain('plain tarball URL (what npm downloads): 404');
  });

  it('one good answer is not enough: the streak restarts after a 404 from another edge', async () => {
    let n = 0;
    const h = harness((url) => url.includes('?cb=') || ++n !== 2); // plain: 200, 404, 200, 200
    expect(await waitForNpm(h.opts)).toBe(true);
    expect(h.urls.filter((u) => u === PLAIN)).toHaveLength(4);
  });

  it('gives up after the timeout and says the channels stay; request errors count as not ready', async () => {
    const h = harness(() => false);
    h.opts.fetch = async () => {
      throw new Error('ECONNRESET');
    };
    expect(await waitForNpm(h.opts)).toBe(false);
    expect(h.time()).toBeGreaterThanOrEqual(600_000);
    expect(h.log.join('\n')).toContain('error (ECONNRESET)');
    expect(h.log.at(-1)).toContain('the channels are not moved');
  });
});
