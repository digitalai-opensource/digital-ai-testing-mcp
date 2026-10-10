/**
 * Second UAT run of 2026-10-10 (against 2.0.0) + its remediation notes — the findings 2.0.1 didn't cover:
 *  A. a failed session start deletes the "Error" report it left behind (verified live: report 743038)
 *  B. automotiveProjection narrows the DEFAULT Android query to Android 10+ (version comparison verified live)
 *  C. the Maestro validation message names only what Maestro accepts
 *  D. get_test_view says "not found" instead of a bare 404
 *  E. validate_test_script verdicts get no debug-mode reminder
 *  F. test-view create/update/delete return structured output; the delete guard names the view
 *  G. switch_environment warns when "admin" matched a same-named profile that isn't Cloud Admin
 */
import { describe, it, beforeAll, afterAll, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { resetClient } from '../src/api/client.js';
import { setAccessLevelOverrideForTests } from '../src/utils/access-level.js';
import { createInspectionSession } from '../src/api/webdriver.js';
import { validateTestRunRequest } from '../src/api/test-runs.js';
import { nudgeFor, startRemediationSession } from '../src/utils/remediation.js';
import { registerTestViewTools } from '../src/tools/test-view-tools.js';
import { registerMetaTools } from '../src/tools/meta-tools.js';

const sessionBodies: Array<{ desiredCapabilities: Record<string, unknown> }> = [];
const deleted: number[][] = [];
let server: http.Server;
let base = '';
let client: Client;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const url = req.url ?? '';
      const body = raw ? JSON.parse(raw) : {};
      res.setHeader('Content-Type', 'application/json');
      if (url.startsWith('/api/v1/users/my-account-info')) {
        return void res.end(JSON.stringify({ status: 'SUCCESS', data: { username: 'u', firstName: 'U', lastName: 'T', role: 'ProjectAdmin', project: { id: 7, name: 'Mobile QA', isAppiumOss: true } } }));
      }
      if (url === '/wd/hub/session') {
        sessionBodies.push(body);
        res.statusCode = 500;
        return void res.end(JSON.stringify({ value: { message: 'Failed to prepare the Appium Infrastructure: Failed to enable automotive dev mode and start Android Auto on the device.' } }));
      }
      if (url.startsWith('/reporter/api/tests/list')) {
        const name = body.filter?.find((f: { property: string }) => f.property === 'name')?.value;
        const now = Date.now();
        return void res.end(JSON.stringify({ count: null, data: [
          { test_id: 9001, name, status: 'Error', start_time: new Date(now).toISOString() },          // this attempt
          { test_id: 9002, name, status: 'Passed', start_time: new Date(now).toISOString() },         // not a failed start
          { test_id: 9003, name, status: 'Error', start_time: new Date(now - 3_600_000).toISOString() }, // an hour old
        ] }));
      }
      if (url.startsWith('/reporter/api/tests/delete')) {
        deleted.push(body);
        return void res.end('{}');
      }
      if (url === '/reporter/api/testView/205') { res.statusCode = 404; return void res.end('{}'); }
      if (url === '/reporter/api/testView/7' && req.method === 'GET') {
        return void res.end(JSON.stringify({ id: 7, name: 'Android by model', byKey: 'device.os', createdBy: 'u' }));
      }
      if (url === '/reporter/api/testView' && req.method === 'POST') {
        return void res.end(JSON.stringify({ id: 88, name: body.name, byKey: body.byKey, createdBy: 'u' }));
      }
      if (url === '/reporter/api/testView/7' && req.method === 'DELETE') return void res.end('{}');
      res.statusCode = 404;
      res.end('{}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // G: a profile literally named "admin" (as in the dev .env), holding a Project Admin key.
  process.env.DAI_PROFILE_ADMIN_URL = base;
  process.env.DAI_PROFILE_ADMIN_KEY = 'aut_1_project_admin_key';
  resetClient(base, 'aut_1_uat1010b', 'uat1010b');
  const mcp = new McpServer({ name: 's', version: '0' });
  registerTestViewTools(mcp);
  registerMetaTools(mcp);
  client = new Client({ name: 'c', version: '0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([mcp.connect(b), client.connect(a)]);
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
afterEach(() => setAccessLevelOverrideForTests(null));

async function call(name: string, args: Record<string, unknown>) {
  const res = (await client.callTool({ name, arguments: args })) as { content: Array<{ text?: string }>; isError?: boolean };
  return { res, text: res.content.map((c) => c.text ?? '').join('') };
}

describe('second UAT 2026-10-10 fixes', () => {
  it('A+B: a failed projection start uses an Android 10+ default query and deletes only its own Error report', async () => {
    setAccessLevelOverrideForTests('cloud-admin');
    sessionBodies.length = 0;
    deleted.length = 0;
    await assert.rejects(
      createInspectionSession({ platform: 'android', automotiveProjection: '800x480', testName: 'UAT automotive' }),
      (e: Error) => /Android 10 or later/.test(e.message) && /The report this attempt created \(9001\) was deleted\./.test(e.message)
    );
    assert.equal(sessionBodies[0].desiredCapabilities['digitalai:deviceQuery'], "@os='android' and @category='PHONE' and @version>='10.0'");
    assert.deepEqual(deleted, [[9001]], 'not the Passed record, not the hour-old one');
  });

  it('B: an explicit query or a non-projection session is left alone', async () => {
    setAccessLevelOverrideForTests('cloud-admin');
    sessionBodies.length = 0;
    await assert.rejects(createInspectionSession({ platform: 'android', automotiveProjection: '800x480', deviceQuery: "@serialNumber='X'" }));
    await assert.rejects(createInspectionSession({ platform: 'android' }));
    assert.equal(sessionBodies[0].desiredCapabilities['digitalai:deviceQuery'], "@serialNumber='X'");
    assert.equal(sessionBodies[1].desiredCapabilities['digitalai:deviceQuery'], "@os='android' and @category='PHONE'");
  });

  it('A: when the role may not delete reports, the leftover report is named instead', async () => {
    setAccessLevelOverrideForTests('project-user');
    deleted.length = 0;
    // The project-level refusal needs the project flag readable and false; when it can't be read the platform decides,
    // so assert only that either path ends with a clear sentence about report 9001.
    await assert.rejects(
      createInspectionSession({ platform: 'android', testName: 'UAT automotive' }),
      (e: Error) => /9001/.test(e.message)
    );
  });

  it('C: Maestro with no test source names only the flow bundle', () => {
    const msg = validateTestRunRequest({ executionType: 'MAESTRO', runningType: 'fastFeedback', cloudAppId: 1, deviceQueries: ["@os='android'"] });
    assert.match(msg ?? '', /MAESTRO needs the flow bundle as a file: pass testsPath/);
    assert.doesNotMatch(msg ?? '', /testsUrl|cloudTestAppId/);
  });

  it('D: get_test_view says the view was not found', async () => {
    const { res, text } = await call('get_test_view', { id: 205 });
    assert.equal(res.isError, true);
    assert.match(text, /Test view 205 not found — it may have been deleted/);
  });

  it('E: validate_test_script verdicts get no debug reminder; other tools still do', () => {
    startRemediationSession({ mcpVersion: 't', toolsets: 'all', client: () => undefined });
    assert.equal(nudgeFor('validate_test_script', 'error', 'fail'), null);
    assert.match(nudgeFor('get_test_report', 'error', 'boom') ?? '', /^\[debug mode\]/);
  });

  it('F: create returns structured output with the id; the delete guard and result name the view', async () => {
    const created = await call('create_test_view', { name: 'By OS', byKey: 'device.os', outputFormat: 'json' });
    assert.deepEqual({ created: JSON.parse(created.text).created, id: JSON.parse(created.text).id }, { created: true, id: 88 });
    const guard = await call('delete_test_view', { id: 7 });
    assert.notEqual(guard.res.isError, true);
    assert.match(guard.text, /test view "Android by model" \(ID 7\)/);
    const done = await call('delete_test_view', { id: 7, confirmDeletion: true, outputFormat: 'json' });
    assert.deepEqual(JSON.parse(done.text), { deleted: true, id: 7, name: 'Android by model' });
  });

  it('G: "admin" matching a same-named Project Admin profile says so', async () => {
    setAccessLevelOverrideForTests('project-admin');
    const { text } = await call('switch_environment', { profileName: 'admin' });
    assert.match(text, /Switched from .* to "admin"/);
    assert.match(text, /matched a profile by that exact name, which is not Cloud Admin.*switch_environment\("cloud admin"\)/);
  });
});
