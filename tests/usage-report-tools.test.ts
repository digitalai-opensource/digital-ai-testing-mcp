/**
 * Usage-report tool handlers against a stub API (tests/usage-reports.test.ts covers the pure guards and path builder).
 *  - a summary whose groupBy/sumColumn live in the first (per-project) section stops reading there — the ~12 MB of
 *    per-reservation rows that make an unfiltered month take minutes are never downloaded (measured live 2026-10-14)
 *  - a fetch that outlives USAGE_REPORT_TIMEOUT_MS is abandoned with an actionable error instead of blocking the agent
 *    (fidelity eval 2026-10-14: three unfiltered month-long fetches blew a 10-minute session budget)
 *  - a normal summary reports how long the fetch took and how big the CSV was
 */
import { describe, it, beforeAll, afterAll, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { registerUsageReportTools } from '../src/tools/usage-report-tools.js';
import { startStubApi, connectTools, reply, type StubApi, type ToolClient } from './helpers/offline.js';

// Live shape: per-project summary, blank line, then one line per reservation (the bulk of a ~12 MB month).
const SECTION1 =
  'Project,Start Date,End Date,Total Reservation Time (hours)\n' +
  'Default,2026-04-01 00:00,2026-04-30 23:59,12.5\n' +
  'QA,2026-04-01 00:00,2026-04-30 23:59,3\n';
const SECTION2 =
  'Reservation Start Timestamp,Device Name,Project,Duration (minutes)\n' +
  Array.from({ length: 2000 }, (_, i) => `${1_700_000_000 + i},Pixel ${i % 7},${i % 2 ? 'QA' : 'Default'},${i % 90}\n`).join('');
const CSV = `${SECTION1}\n${SECTION2}`;

let delayMs = 0;
let api: StubApi;
let tools: ToolClient;
const ORIGINAL = process.env.USAGE_REPORT_TIMEOUT_MS;

beforeAll(async () => {
  api = await startStubApi(async (req) => {
    if (!req.path.startsWith('/api/v2/configuration/get-CSV-reports/')) return undefined;
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    return reply(200, CSV);
  });
  tools = await connectTools(registerUsageReportTools);
});
afterAll(async () => { await tools.close(); await api.close(); });
afterEach(() => {
  delayMs = 0;
  if (ORIGINAL === undefined) delete process.env.USAGE_REPORT_TIMEOUT_MS; else process.env.USAGE_REPORT_TIMEOUT_MS = ORIGINAL;
});

const ARGS = { reportType: 'Device Reservations', startDate: '2026-04-01', endDate: '2026-04-30', groupBy: 'Project', sumColumn: 'Total Reservation Time (hours)' };

describe('summarize_usage_report', () => {
  it('reports fetch time and CSV size alongside the aggregation', async () => {
    const j = await tools.callJson('summarize_usage_report', ARGS);
    assert.equal(j.totalRows, 2);
    assert.ok(typeof j.csvBytes === 'number' && j.csvBytes > 0);
    assert.ok(typeof j.fetchMs === 'number' && j.fetchMs >= 0);
  });

  it('stops reading after the summary section when groupBy/sumColumn live there, and reads it all otherwise', async () => {
    const j = await tools.callJson('summarize_usage_report', ARGS);
    assert.equal(j.stoppedAfterFirstSection, true);
    assert.equal(j.csvBytes, Buffer.byteLength(SECTION1.trimEnd()), 'only section 1 was kept (up to the blank line)');
    const groups = j.groups as Array<{ value: string; sum?: number }>;
    assert.deepEqual(groups.map((g) => [g.value, g.sum]), [['Default', 12.5], ['QA', 3]]);
    const { text } = await tools.call('summarize_usage_report', { ...ARGS, outputFormat: 'human' });
    assert.match(text, /Read only the summary section/);

    const full = await tools.callJson('summarize_usage_report', { ...ARGS, groupBy: 'Device Name', sumColumn: 'Duration (minutes)' });
    assert.equal(full.stoppedAfterFirstSection, undefined);
    assert.equal(full.csvBytes, Buffer.byteLength(CSV));
    assert.equal(full.totalRows, 2000);
    const { text: fullText } = await tools.call('summarize_usage_report', { ...ARGS, groupBy: 'Device Name', sumColumn: 'Duration (minutes)', outputFormat: 'human' });
    assert.match(fullText, /Fetched .* of CSV in \d+ s/);
  });

  it('abandons a fetch that outlives USAGE_REPORT_TIMEOUT_MS with an actionable error', async () => {
    process.env.USAGE_REPORT_TIMEOUT_MS = '150';
    delayMs = 1500;
    const { res, text } = await tools.call('summarize_usage_report', ARGS);
    assert.equal(res.isError, true);
    assert.match(text, /still being generated after 0 s and was abandoned/);
    assert.match(text, /projectId or userId/);
    assert.match(text, /get_usage_report_download_command/);
    assert.match(text, /USAGE_REPORT_TIMEOUT_MS/);
  });
});
