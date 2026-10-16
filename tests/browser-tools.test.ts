/**
 * Browser tool handlers against a stub API (tests/api/browsers.test.ts covers the live API itself).
 *  - a list cut at maxResults must say so in its JSON: total / returned / truncated (UAT #49)
 */
import { describe, it, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import { registerBrowserTools } from '../src/tools/browser-tools.js';
import { startStubApi, connectTools, type StubApi, type ToolClient } from './helpers/offline.js';

const BROWSERS = Array.from({ length: 60 }, (_, i) => ({
  browserName: i % 2 ? 'chrome' : 'MicrosoftEdge', browserVersion: String(100 + i), platform: 'WINDOWS', osName: 'Windows 11', agentName: `agent-${i}`, region: 'US1',
}));

let api: StubApi;
let tools: ToolClient;

beforeAll(async () => {
  api = await startStubApi((req) => (req.path.startsWith('/api/v1/browsers') ? { status: 'SUCCESS', data: BROWSERS } : undefined));
  tools = await connectTools(registerBrowserTools);
});
afterAll(async () => { await tools.close(); await api.close(); });

describe('list_available_browsers', () => {
  it('reports total / returned / truncated when the list is cut at maxResults', async () => {
    const j = await tools.callJson('list_available_browsers', {});
    assert.equal(j.total, 60);
    assert.equal(j.returned, 50);
    assert.equal(j.truncated, true);
    assert.equal((j.browsers as unknown[]).length, 50);
  });
});
