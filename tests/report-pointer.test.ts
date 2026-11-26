/**
 * The report pointer (src/utils/report-pointer.ts): a data tool's result says how to present what it returned
 * (render_report for any data, or the report tool that already builds the finished report of that data). Offline: the pure
 * rules, the wrapper, and the real entry point over stdio against a stub API (the pointer is added in src/index.ts).
 */
import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startStubApi, accountInfo } from './helpers/offline.js';
import {
  REPORT_POINTER_TOOLS, REPORT_POINTER_REPEAT_MS, holdsData, isReportPointerEnabled, reportPointer, resetReportPointerForTests, withReportPointer,
} from '../src/utils/report-pointer.js';
import { REGISTERED_TOOLS } from '../src/tools/meta-tools.js';
import { TOOL_TOOLSETS } from '../src/utils/toolsets.js';
import { READ_ONLY_TOOL_RE } from '../src/utils/tool-annotations.js';

type Result = { content: Array<{ type: string; text?: string }>; isError?: boolean };
const text = (t: string): Result => ({ content: [{ type: 'text', text: t }] });
const records = (n: number) => Array.from({ length: n }, (_, k) => ({ id: k, name: `Device ${k}`, status: 'Available' }));
const savedEnv = process.env.MCP_REPORT_POINTER;

beforeEach(() => { resetReportPointerForTests(); delete process.env.MCP_REPORT_POINTER; });
afterEach(() => { if (savedEnv === undefined) delete process.env.MCP_REPORT_POINTER; else process.env.MCP_REPORT_POINTER = savedEnv; });

describe('which tools carry the pointer', () => {
  it('only registered, read-only data tools; a named report tool is one of the per-recipe tools', () => {
    const registered = new Set<string>(REGISTERED_TOOLS);
    for (const [tool, recipe] of Object.entries(REPORT_POINTER_TOOLS)) {
      assert.ok(registered.has(tool), `${tool} is a registered tool`);
      // By name: find_unhealthy_devices has an opt-in mode that tags devices, and its ordinary answer is still a list to present.
      assert.match(tool, READ_ONLY_TOOL_RE, `${tool} is a tool that reads`);
      assert.doesNotMatch(tool, /_command$|_log$|^create_|render_report|inspection|session(?!s$)|boilerplate|^get_(test_report|device_detail|transaction|application_info)$/, `${tool}: a list or an aggregate, not a detail, a log or a command`);
      if (recipe) assert.ok(TOOL_TOOLSETS[recipe], `${tool} → ${recipe} is a report tool`);
    }
    for (const never of ['get_test_log', 'get_device_log', 'get_element_tree', 'get_page_dom', 'get_test_boilerplate', 'get_server_info', 'create_report', 'render_report', 'list_environments', 'list_inspection_sessions']) {
      assert.equal(reportPointer(never), null, never);
    }
  });

  it('names the finished report where one exists, render_report otherwise, and says it is not for a quick answer', () => {
    const plain = reportPointer('list_devices')!;
    assert.match(plain, /render_report lays out the numbers you send as a branded report in one call: no hand-written HTML, no long table\. Not for a quick answer\./);
    assert.doesNotMatch(plain, /create_/);
    const recipe = reportPointer('summarize_usage_report')!;
    assert.match(recipe, /create_usage_summary_report builds the finished branded report of this data in one call \(do not assemble it from these numbers\)\. For another cut, render_report lays out the numbers you send\./);
    assert.match(recipe, /Not for a quick answer\.$/);
    for (const tool of Object.keys(REPORT_POINTER_TOOLS)) assert.ok(reportPointer(tool)!.length < 260, `${tool}: ${reportPointer(tool)!.length} chars`);
  });
});

describe('holdsData: more than a handful of values', () => {
  it('JSON: five or more entries in a list, or a dozen numbers; fewer is an answer', () => {
    assert.equal(holdsData(JSON.stringify({ devices: records(5) })), true);
    assert.equal(holdsData(JSON.stringify(records(5))), true, 'a top-level list');
    assert.equal(holdsData(JSON.stringify({ devices: records(4) })), false);
    assert.equal(holdsData(JSON.stringify({ result: { page: { data: records(6) } } })), true, 'nested');
    assert.equal(holdsData(JSON.stringify({ android: { passed: 1, failed: 2, error: 3, total: 6 }, ios: { passed: 1, failed: 2, error: 3, total: 6 }, web: { passed: 1, failed: 2, error: 3, total: 6 } })), true, 'an aggregate with no list');
    assert.equal(holdsData(JSON.stringify({ total: 161, available: 129, offline: 26 })), false);
    const three = Array.from({ length: 3 }, (_, k) => ({ test_id: k, duration: 1200, start: 1700000000 + k, steps: 14, attachments: 2 }));
    assert.equal(holdsData(JSON.stringify({ count: 3, data: three })), false, 'three records with many numeric fields are still three records');
    assert.equal(holdsData(''), false);
  });

  it('formatted text: twelve or more lines', () => {
    assert.equal(holdsData(Array.from({ length: 12 }, (_, k) => `Device ${k} | Available`).join('\n')), true);
    assert.equal(holdsData('3 devices\n\nPixel 8 | Available\niPhone 15 | In Use\nGalaxy S24 | Offline'), false);
    assert.equal(holdsData('{ not json\n'.repeat(12)), true, 'text that only looks like JSON is counted as lines');
  });
});

describe('withReportPointer', () => {
  it('puts the pointer first: a field in a JSON object, a leading line for a list or formatted text', async () => {
    const obj = (await withReportPointer('list_devices', async () => text(JSON.stringify({ count: 6, devices: records(6) })))()) as Result;
    const parsed = JSON.parse(obj.content[0].text!);
    assert.equal(Object.keys(parsed)[0], '_presentAsReport');
    assert.equal(parsed._presentAsReport, reportPointer('list_devices'));
    assert.equal(parsed.devices.length, 6, 'the data is untouched');
    const arr = (await withReportPointer('list_applications', async () => text(JSON.stringify(records(6))))()) as Result;
    assert.equal(arr.content[0].text, reportPointer('list_applications'));
    assert.equal(JSON.parse(arr.content[1].text!).length, 6);
    const lines = (await withReportPointer('find_unhealthy_devices', async () => text(Array.from({ length: 15 }, (_, k) => `row ${k}`).join('\n')))()) as Result;
    assert.match(lines.content[0].text!, /create_device_health_report builds the finished branded report/);
    assert.match(lines.content[1].text!, /^row 0/);
  });

  it('leaves everything else exactly as it was: a short result, an error, a tool that is not a data tool, a result that already names the report tools', async () => {
    const small = text(JSON.stringify({ devices: records(3) }));
    assert.equal(await withReportPointer('list_devices', async () => small)(), small, 'the same object');
    const failed: Result = { isError: true, content: [{ type: 'text', text: JSON.stringify({ devices: records(9) }) }] };
    assert.equal(await withReportPointer('list_devices', async () => failed)(), failed);
    const cb = async () => text(JSON.stringify({ lines: records(50) }));
    assert.equal(withReportPointer('get_test_log', cb), cb, 'not wrapped at all');
    const own = text(`${JSON.stringify({ devices: records(9) })}\nFor a report call create_device_health_report.`);
    assert.equal(await withReportPointer('list_devices', async () => own)(), own);
    const ownRecipe = text(`${JSON.stringify({ data: records(9) })}\nFor a finished report use create_test_breakdown_report.`);
    assert.equal(await withReportPointer('get_grouped_test_reports', async () => ownRecipe)(), ownRecipe);
  });

  it('a result that names ANOTHER report still gets the pointer to its own (the scope line of get_grouped_test_reports)', async () => {
    const scoped = text(JSON.stringify({ scope: 'the access key\'s own project ONLY (create_test_inventory_report builds the all-time report)', data: records(9) }));
    const r = (await withReportPointer('get_grouped_test_reports', async () => scoped)()) as Result;
    assert.match(String(JSON.parse(r.content[0].text!)._presentAsReport), /create_test_breakdown_report builds the finished branded report/);
  });

  it('paging does not repeat it: once per tool every two minutes; another tool has its own clock; MCP_REPORT_POINTER=false turns it off', async () => {
    let t = 1_000_000;
    const big = () => text(JSON.stringify({ data: records(20) }));
    const has = (r: unknown) => /_presentAsReport/.test((r as Result).content[0].text ?? '');
    const reports = withReportPointer('list_test_reports', async () => big(), () => t);
    const devices = withReportPointer('list_devices', async () => big(), () => t);
    assert.equal(has(await reports()), true);
    t += 30_000;
    assert.equal(has(await reports()), false, 'the next page, half a minute later');
    assert.equal(has(await devices()), true, 'a different tool');
    t += REPORT_POINTER_REPEAT_MS;
    assert.equal(has(await reports()), true, 'a later question');
    process.env.MCP_REPORT_POINTER = 'false';
    assert.equal(isReportPointerEnabled(), false);
    t += 10 * REPORT_POINTER_REPEAT_MS;
    assert.equal(has(await reports()), false);
    process.env.MCP_REPORT_POINTER = 'true';
    assert.equal(has(await reports()), true);
  });

  it('a failing callback still fails; the wrapper adds nothing of its own', async () => {
    await assert.rejects(() => withReportPointer('list_devices', async () => { throw new Error('boom'); })() as Promise<unknown>, /boom/);
    const odd = { content: 'not an array' } as unknown as Result;
    assert.equal(await withReportPointer('list_devices', async () => odd)(), odd);
  });
});

describe('the server adds it (real entry point over stdio, stub API)', () => {
  const ENTRY = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.ts');
  const TSX_LOADER = import.meta.resolve('tsx');
  const device = (k: number) => ({ id: k, udid: `u${k}`, deviceName: `Device ${k}`, deviceOs: k % 2 ? 'iOS' : 'Android', osVersion: '14', modelName: 'M', manufacturer: 'X', displayStatus: 'Available', currentStatus: 'Available',
    statusAgeInMinutes: 5, region: 'US1', agentName: 'h1', deviceCategory: 'PHONE', tags: [], isEmulator: false });

  async function start(devices: number, extraEnv: Record<string, string> = {}) {
    const api = await startStubApi((req) => {
      if (req.path === '/api/v1/users/my-account-info') return accountInfo('Admin', 'Default');
      if (req.path === '/api/v1/devices') return { status: 'SUCCESS', data: Array.from({ length: devices }, (_, k) => device(k)) };
      return undefined;
    });
    const cwd = mkdtempSync(join(tmpdir(), 'dai-report-pointer-'));
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) { if (v !== undefined && !/^(DIGITAL_AI_|DAI_PROFILE_|MCP_)/.test(k)) env[k] = v; }
    Object.assign(env, { MCP_UPDATE_CHECK: 'false', MCP_DEBUG_MODE: 'false', MCP_CREDENTIAL_STORE: 'off', DIGITAL_AI_BASE_URL: api.baseUrl, DIGITAL_AI_ACCESS_KEY: 'aut_1_pointer' }, extraEnv);
    const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', TSX_LOADER, ENTRY], env, cwd, stderr: 'ignore' });
    const client = new Client({ name: 'report-pointer-test', version: '1.0.0' });
    await client.connect(transport);
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = (await client.callTool({ name, arguments: args })) as Result;
      return { r, text: r.content.map((c) => c.text ?? '').join('\n') };
    };
    return { call, async close() { await client.close(); await api.close(); rmSync(cwd, { recursive: true, force: true }); } };
  }

  it('a device list of eight carries the pointer once; the data follows it unchanged; a list of two carries none', async () => {
    const s = await start(8);
    try {
      const first = await s.call('list_devices', { outputFormat: 'json' });
      assert.notEqual(first.r.isError, true, first.text);
      assert.match(first.text, /📊 Presenting this to the user \(a summary, ranking, trend or comparison\)\? render_report lays out the numbers you send/);
      assert.match(first.text, /Device 7/);
      const again = await s.call('list_devices', { outputFormat: 'json' });
      assert.doesNotMatch(again.text, /Presenting this to the user/, 'the same tool a moment later');
      assert.match(again.text, /Device 7/);
      const info = await s.call('get_server_info', {});
      assert.doesNotMatch(info.text, /Presenting this to the user/, 'not a data tool');
    } finally { await s.close(); }
    const few = await start(2);
    try {
      const r = await few.call('list_devices', { outputFormat: 'json' });
      assert.doesNotMatch(r.text, /Presenting this to the user/);
      assert.match(r.text, /Device 1/);
    } finally { await few.close(); }
  }, 60_000);

  it('MCP_REPORT_POINTER=false: no pointer', async () => {
    const s = await start(8, { MCP_REPORT_POINTER: 'false' });
    try {
      const r = await s.call('list_devices', { outputFormat: 'json' });
      assert.doesNotMatch(r.text, /Presenting this to the user/);
      assert.match(r.text, /Device 7/);
    } finally { await s.close(); }
  }, 60_000);
});
