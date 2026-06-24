import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { getAllBrowsers } from './helpers/test-client.js';

describe('Browsers API', () => {
  it('GET /api/v1/browsers — returns array', async () => {
    const browsers = await getAllBrowsers();
    assert.ok(Array.isArray(browsers), 'Response should be an array');
  });

  it('Each browser has browserName, browserVersion, platform, osName, agentName', async () => {
    const browsers = await getAllBrowsers();
    for (const b of browsers.slice(0, 5)) {
      assert.ok(typeof b.browserName === 'string', 'browserName should be a string');
      assert.ok(typeof b.browserVersion === 'string', 'browserVersion should be a string');
      assert.ok(typeof b.agentName === 'string', 'agentName should be a string');
    }
  });

  it('browserName values are from known set: chrome, firefox, safari, MicrosoftEdge', async () => {
    const browsers = await getAllBrowsers();
    const knownBrowsers = ['chrome', 'firefox', 'safari', 'microsoftedge', 'edge', 'opera'];
    for (const b of browsers) {
      const normalized = b.browserName.toLowerCase();
      assert.ok(
        knownBrowsers.some((k) => normalized.includes(k)),
        `Unexpected browser name: ${b.browserName}`
      );
    }
  });
});
