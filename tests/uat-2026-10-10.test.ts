/**
 * UAT 2026-10-10 + debug-mode remediation notes from the same run:
 *  - get_distinct_test_key_values folds device.os case variants like get_grouped_test_reports does
 *  - get_daily_execution_trend gives a concrete next step when maxRecords caps the window
 *  - get_test_report no longer invents status_code/project_id = 0
 *  - automotive session failures get specific guidance; no reference to a tool that doesn't exist
 */
import { describe, it, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { resetClient } from '../src/api/client.js';
import { clearAccessInfoCache } from '../src/utils/access-level.js';
import { registerReportingTools } from '../src/tools/reporting-tools.js';
import { automotiveSessionHint } from '../src/api/webdriver.js';
import { REGISTERED_TOOLS } from '../src/tools/meta-tools.js';

const HOUR = 3_600_000;
let spacingMs = HOUR; // gap between consecutive runs in the fake reporter
const NOW = Date.now();
// One run per hour, newest first — 100 records cover ~4 days of a 14-day window.
const listRows = (page: number) =>
  Array.from({ length: 500 }, (_, i) => {
    const n = (page - 1) * 500 + i;
    return { test_id: n + 1, name: `t${n}`, status: 'Passed', start_time: new Date(NOW - n * spacingMs).toISOString() };
  });

let server: http.Server;
let client: Client;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const url = req.url ?? '';
      res.setHeader('Content-Type', 'application/json');
      if (url.startsWith('/api/v1/users/my-account-info')) {
        return void res.end(JSON.stringify({ status: 'SUCCESS', data: { username: 'u', role: 'Admin', project: { id: 1, name: 'Default', isAppiumOss: true } } }));
      }
      if (url.startsWith('/reporter/api/tests/grouped')) {
        return void res.end(JSON.stringify({ count: 2, data: [{ status: 'Passed', _count_: 90 }, { status: 'Failed', _count_: 10 }] }));
      }
      if (url.startsWith('/reporter/api/tests/distinct')) {
        return void res.end(JSON.stringify({ count: 4, data: [{ 'device.os': 'ANDROID' }, { 'device.os': 'Android' }, { 'device.os': 'IOS' }, { 'device.os': 'iOS' }] }));
      }
      if (url.startsWith('/reporter/api/tests/list')) {
        const body = JSON.parse(raw || '{}');
        return void res.end(JSON.stringify({ count: null, data: listRows(body.page ?? 1) }));
      }
      if (url === '/reporter/api/tests/742904') {
        return void res.end(JSON.stringify({
          uuid: '3ed64d18-1146-4e95-9e67-cc7c20a4d559', id: 742904, name: 'health_check', startTime: new Date(NOW).toISOString(),
          duration: 1000, status: 'Failed', success: false, keyValuePairs: {}, projectName: 'Default',
          testAttachments: [{ type: 'log', filePath: 'a.log', size: 1 }, { type: 'video', filePath: 'v.mp4', size: 2 }],
        }));
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  clearAccessInfoCache();
  resetClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, 'aut_1_uat1010', 'uat1010');
  const mcp = new McpServer({ name: 's', version: '0' });
  registerReportingTools(mcp);
  client = new Client({ name: 'c', version: '0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([mcp.connect(b), client.connect(a)]);
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

async function callJson(name: string, args: Record<string, unknown>) {
  const res = (await client.callTool({ name, arguments: { ...args, outputFormat: 'json' } })) as { content: Array<{ text?: string }>; isError?: boolean };
  const text = res.content.map((c) => c.text ?? '').join('');
  assert.notEqual(res.isError, true, text);
  return JSON.parse(text) as Record<string, unknown>;
}

describe('UAT 2026-10-10 fixes', () => {
  it('get_distinct_test_key_values folds OS case variants and keeps the raw spellings', async () => {
    const r = await callJson('get_distinct_test_key_values', { keys: ['device.os'] });
    assert.deepEqual(r['device.os'], ['Android', 'iOS']);
    assert.deepEqual((r.rawValues as Record<string, unknown>)['device.os'], ['ANDROID', 'Android', 'IOS', 'iOS']);
  });

  it('get_grouped_test_reports adds totalRecords when returnTotalCount is true (the platform\x27s count is the number of groups)', async () => {
    const r = await callJson('get_grouped_test_reports', { groupBy: ['status'], returnTotalCount: true });
    assert.equal(r.count, 2);
    assert.equal(r.totalRecords, 100);
    const without = await callJson('get_grouped_test_reports', { groupBy: ['status'], returnTotalCount: false });
    assert.equal('totalRecords' in without, false);
  });

  it('get_daily_execution_trend names the missing range and suggests a maxRecords value when capped', async () => {
    const r = await callJson('get_daily_execution_trend', { lookbackDays: 14, maxRecords: 100 });
    assert.equal(r.windowComplete, false);
    const missing = r.missingRange as { from: string; to: string };
    assert.ok(new Date(missing.from).getTime() < new Date(missing.to).getTime());
    // ~24 runs/day × 14 days × 1.1, rounded up to 500 → 500
    assert.equal(r.suggestedMaxRecords, 500);
    assert.equal(r.fittingLookbackDays, undefined);
  });

  it('…and says when even the 25,000 maximum cannot cover the window', async () => {
    // ~24.2 runs/day × 365 × 1.1 ≈ 9,733 → rounded up to the next 500
    const r = await callJson('get_daily_execution_trend', { lookbackDays: 365, maxRecords: 100 });
    assert.equal(r.suggestedMaxRecords, 10000);
    // A busy project: one run every 10 minutes (~144/day) — 365 days would need ~58k records.
    spacingMs = 10 * 60_000;
    try {
      const r2 = await callJson('get_daily_execution_trend', { lookbackDays: 365, maxRecords: 100 });
      assert.equal(r2.suggestedMaxRecords, 25000);
      assert.ok(typeof r2.fittingLookbackDays === 'number' && (r2.fittingLookbackDays as number) > 100 && (r2.fittingLookbackDays as number) < 200);
    } finally {
      spacingMs = HOUR;
    }
  });

  it('get_test_report has no invented status_code/project_id and counts the attachment files', async () => {
    const r = await callJson('get_test_report', { testId: 742904 });
    assert.equal('status_code' in r, false);
    assert.equal('project_id' in r, false);
    assert.equal(r.projectName, 'Default');
    assert.equal(r.attachment_count, 2);
  });

  it('automotive session failures get specific guidance', () => {
    assert.match(automotiveSessionHint('HTTP 500: Automotive Projection is only supported on Apple Silicon Device Host Machines') ?? '', /Apple Silicon device host.*not your request/);
    assert.match(automotiveSessionHint('HTTP 500: Failed to enable automotive dev mode and start Android Auto on the device') ?? '', /Android 10 or later/);
    assert.match(automotiveSessionHint('HTTP 500: Timeout while waiting for the DHU process to connect.') ?? '', /head unit \(DHU\) never connected/);
    assert.match(automotiveSessionHint('HTTP 500: no Android Auto head unit server on the device') ?? '', /property of the device/);
    assert.equal(automotiveSessionHint('HTTP 500: something else'), null);
  });

  it('session-failure diagnostics only name tools that exist', () => {
    const src = readFileSync(new URL('../src/api/webdriver.ts', import.meta.url), 'utf8');
    const named = [...src.matchAll(/\b(check_[a-z_]+|find_available_device|get_device_health_summary|get_application_info)\b/g)].map((m) => m[1]);
    const registered = new Set<string>(REGISTERED_TOOLS);
    assert.deepEqual([...new Set(named)].filter((n) => !registered.has(n)), []);
  });
});
