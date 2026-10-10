/**
 * Report references: UUID-first lookup. Numeric test_ids collide across reporter scopes (verified live: test_id 20 is a
 * different test for a Cloud Admin than for a project key), and sessions now print /reporter/video-report/<uuid> URLs —
 * which get_test_report used to reject with "UUID lookup is not supported".
 */
import { describe, it, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { parseReportRef } from '../src/utils/report-ref.js';
import { resetClient } from '../src/api/client.js';
import { clearAccessInfoCache } from '../src/utils/access-level.js';
import { registerReportingTools } from '../src/tools/reporting-tools.js';

const U = '44882dbd-7cbd-4f82-96a1-9e12fcbead5f';
const SHARING_OFF = '11111111-1111-1111-1111-111111111111'; // report whose project has sharing disabled
const NO_SHARE = '22222222-2222-2222-2222-222222222222';    // flag says enabled, but the share call 400s

describe('parseReportRef (pure)', () => {
  const cases: Array<[string | number, ReturnType<typeof parseReportRef>]> = [
    [U, { kind: 'uuid', uuid: U }],
    [U.toUpperCase(), { kind: 'uuid', uuid: U }],
    [`https://uscloud.experitest.com/reporter/video-report/${U}`, { kind: 'uuid', uuid: U }],
    [`https://host/reporter/html-report/${U}`, { kind: 'uuid', uuid: U }],
    [`https://host/reporter/html-report/index.html?test_id=742849`, { kind: 'testId', testId: 742849 }],
    [`https://host/reporter/reporter/tests/742849`, { kind: 'testId', testId: 742849 }],
    [`https://host/reporter/reporter/tests/742849?x=1`, { kind: 'testId', testId: 742849 }],
    ['742849', { kind: 'testId', testId: 742849 }],
    [742849, { kind: 'testId', testId: 742849 }],
  ];
  for (const [input, expected] of cases) {
    it(`${String(input).slice(0, 70)}`, () => assert.deepEqual(parseReportRef(input), expected));
  }
  it('a UUID wins over a number in the same URL', () => {
    assert.deepEqual(parseReportRef(`https://h/reporter/video-report/${U}?test_id=5`), { kind: 'uuid', uuid: U });
  });
  it('unrecognised input → null', () => {
    for (const bad of ['', 'not-a-report', 'https://host/reporter/', 0, -3, 1.5]) assert.equal(parseReportRef(bad as never), null, String(bad));
  });
});

let server: http.Server;
let client: Client;
const seen: string[] = [];
const RAW = (id: number, uuid: string) => ({ uuid, id, name: `t${id}`, startTime: '2026-10-09T00:00:00Z', duration: 5, status: 'Failed', success: false, projectName: 'Default', sharingEnabled: true, keyValuePairs: { cause: 'boom', errorCategory: 'application' }, testAttachments: [] });

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = req.url ?? '';
    seen.push(`${req.method} ${url}`);
    res.setHeader('Content-Type', 'application/json');
    const share = url.match(/^\/reporter\/api\/reports\/([0-9a-f-]{36})\/share$/);
    if (share && req.method === 'POST') {
      if (share[1] === NO_SHARE) { res.statusCode = 400; return void res.end('{"detail":"sharing disabled"}'); }
      return void res.end(JSON.stringify({ testReportShare: 'TOKEN123', expires: '2026-10-23T17:29:37.374Z' }));
    }
    const byUuid = url.match(/^\/reporter\/api\/reports\/([0-9a-f-]{36})$/);
    if (byUuid) return void res.end(JSON.stringify({ ...RAW(742849, byUuid[1]), sharingEnabled: byUuid[1] !== SHARING_OFF }));
    const byId = url.match(/^\/reporter\/api\/tests\/(\d+)$/);
    if (byId) return void res.end(JSON.stringify(RAW(Number(byId[1]), '00000000-0000-0000-0000-000000000000')));
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  clearAccessInfoCache();
  resetClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, 'aut_1_report_ref', 'ref');
  const mcp = new McpServer({ name: 's', version: '0' });
  registerReportingTools(mcp);
  client = new Client({ name: 'c', version: '0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([mcp.connect(b), client.connect(a)]);
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

async function call(name: string, args: Record<string, unknown>) {
  seen.length = 0;
  const res = (await client.callTool({ name, arguments: { ...args, outputFormat: 'json' } })) as { content: Array<{ text?: string }>; isError?: boolean };
  const text = res.content.map((c) => c.text ?? '').join('');
  let json: Record<string, unknown> | undefined;
  try { json = res.isError ? undefined : JSON.parse(text); } catch { json = undefined; } // previews are plain text
  return { res, text, json };
}

describe('get_test_report — UUID first', () => {
  it('a session report URL (/reporter/video-report/<uuid>) resolves via /reporter/api/reports/{uuid}', async () => {
    const { res, json } = await call('get_test_report', { reportUrl: `https://uscloud.experitest.com/reporter/video-report/${U}` });
    assert.notEqual(res.isError, true);
    assert.deepEqual(seen, [`GET /reporter/api/reports/${U}`]);
    assert.equal(json?.uuid, U);
    assert.equal(json?.projectName, 'Default');
    assert.equal(json?.sharingEnabled, true);
  });

  it('uuid param uses the UUID endpoint; testId still uses the numeric one', async () => {
    await call('get_test_report', { uuid: U });
    assert.deepEqual(seen, [`GET /reporter/api/reports/${U}`]);
    await call('get_test_report', { testId: 77 });
    assert.deepEqual(seen, ['GET /reporter/api/tests/77']);
  });

  it('refuses more than one identifier (they could point at different reports) and none at all', async () => {
    assert.equal((await call('get_test_report', { uuid: U, testId: 1 })).res.isError, true);
    assert.equal((await call('get_test_report', {})).res.isError, true);
    assert.deepEqual(seen, [], 'no request on a refused call');
  });

  it('list_test_attachments accepts a uuid', async () => {
    const { json } = await call('list_test_attachments', { uuid: U });
    assert.deepEqual(seen, [`GET /reporter/api/reports/${U}`]);
    assert.equal(json?.uuid, U);
  });

  it('get_test_by_report_id given a UUID points to get_test_report(uuid) — not "no endpoint"', async () => {
    const { res, text } = await call('get_test_by_report_id', { reportApiId: U });
    assert.equal(res.isError, true);
    assert.match(text, /get_test_report\(uuid:/);
    assert.doesNotMatch(text, /no API endpoint/i);
  });
});

describe('share_test_report — public link behind an explicit confirmation', () => {
  it('without confirmPublicShare: previews what would be exposed and shares NOTHING (not an error)', async () => {
    const { res, text } = await call('share_test_report', { uuid: U });
    assert.notEqual(res.isError, true);
    assert.match(text, /nothing has been shared/i);
    assert.match(text, /without logging in/);
    assert.deepEqual(seen, [`GET /reporter/api/reports/${U}`], 'must not POST /share without confirmation');
  });

  it('with confirmPublicShare: true returns the public URL and expiry', async () => {
    const { res, json } = await call('share_test_report', { reportUrl: `https://h/reporter/video-report/${U}`, confirmPublicShare: true });
    assert.notEqual(res.isError, true);
    assert.deepEqual(seen, [`GET /reporter/api/reports/${U}`, `POST /reporter/api/reports/${U}/share`]);
    assert.match(String(json?.publicUrl), /\/reporter\/html-report\/public\/TOKEN123$/);
    assert.equal(json?.expires, '2026-10-23T17:29:37.374Z');
  });

  it('refuses numeric ids (sharing needs the UUID) without any request', async () => {
    const { res } = await call('share_test_report', { reportUrl: 'https://h/reporter/html-report/index.html?test_id=5', confirmPublicShare: true });
    assert.equal(res.isError, true);
    assert.deepEqual(seen, []);
  });

  it('sharing disabled → error before any POST; a 400 from /share explains the setting', async () => {
    const off = await call('share_test_report', { uuid: SHARING_OFF, confirmPublicShare: true });
    assert.equal(off.res.isError, true);
    assert.match(off.text, /disabled/);
    assert.ok(!seen.some((r) => r.startsWith('POST')));
    const bad = await call('share_test_report', { uuid: NO_SHARE, confirmPublicShare: true });
    assert.equal(bad.res.isError, true);
    assert.match(bad.text, /sharing is disabled/);
  });
});
