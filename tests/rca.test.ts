/**
 * get_root_cause_analysis — read-only view of the platform's AI Root Cause Analysis.
 * Fixtures mirror live payloads (2026-10-09): a COMPLETED analysis stored in keyValuePairs (rca.description /
 * rca.evidence JSON / rca.id), an exhausted submission_failed record, and a non-Appium report.
 */
import { describe, it, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildRootCauseAnalysis } from '../src/api/reporting.js';
import { resetClient } from '../src/api/client.js';
import { registerReportingTools } from '../src/tools/reporting-tools.js';

const EVIDENCE = JSON.stringify([
  { source: 'Cloud Server Log (cloudserver.log)', time: '2026-10-06 10:47:28.370', log: 'session CLOUD-SID:… not found', findings: 'Session state was already inconsistent.' },
  { source: 'Device Agent Log', time: '2026-10-06 10:47:30.266', log: "adb: error: cannot stat 'mock_apps.json'", findings: 'Config push failed.' },
]);
const COMPLETED = {
  uuid: '402efd81-9f7f-4e0d-a504-75a8166cdd21', id: 742388, name: 'Quick Start Android Native Demo', status: 'Failed', projectName: 'Default',
  keyValuePairs: {
    'test.framework': 'Appium Server', 'rca.status': 'COMPLETED', 'rca.id': '01a111e3', 'rca.evidence': EVIDENCE,
    'rca.description': 'Login elements were not found because the app had not finished rendering.',
    errorCategory: 'application', errorClassification: 'element_not_found', cause: 'NoSuchElement',
  },
};
const EXHAUSTED = {
  uuid: 'e5786e61-e027-4b50-ad9f-2088d91d99ee', id: 742741, name: 'My First Mobile Test', status: 'Failed',
  keyValuePairs: { 'test.framework': 'Appium Server' },
};
const SELENIUM = { uuid: 'b42dba76-9fbb-4a26-af9f-7416471b49ce', id: 742818, name: 'health_check', status: 'Failed', keyValuePairs: { 'test.framework': 'Selenium' } };

describe('buildRootCauseAnalysis (pure)', () => {
  it('completed analysis: hypothesis, parsed evidence, classification; re-run not allowed', () => {
    const a = buildRootCauseAnalysis(COMPLETED, { attemptCount: 0, lastStatus: 'completed', lastRcaId: '01a111e3' }, { enabled: true });
    assert.equal(a.status, 'completed');
    assert.match(a.hypothesis ?? '', /finished rendering/);
    assert.equal(a.evidence.length, 2);
    assert.equal(a.evidence[1].source, 'Device Agent Log');
    assert.deepEqual(a.classification, { errorCategory: 'application', errorClassification: 'element_not_found', cause: 'NoSuchElement' });
    assert.match(a.ineligibleReason ?? '', /already completed/);
  });

  it('submission_failed with 3 attempts: no result, attempts exhausted', () => {
    const a = buildRootCauseAnalysis(EXHAUSTED, { attemptCount: 3, lastStatus: 'submission_failed', lastRcaId: null }, { enabled: true });
    assert.equal(a.status, 'submission_failed');
    assert.equal(a.hypothesis, null);
    assert.equal(a.attemptsRemaining, 0);
    assert.match(a.ineligibleReason ?? '', /administrator must reset/);
  });

  it('non-Appium framework is explained; malformed evidence is kept as text, not thrown', () => {
    assert.match(buildRootCauseAnalysis(SELENIUM, null, null).ineligibleReason ?? '', /Appium Server .* Selenium/);
    const odd = buildRootCauseAnalysis({ ...COMPLETED, keyValuePairs: { ...COMPLETED.keyValuePairs, 'rca.evidence': 'not json' } }, null, null);
    assert.deepEqual(odd.evidence, [{ findings: 'not json' }]);
  });

  it('never analysed + fresh failure: status none, no ineligibility', () => {
    const a = buildRootCauseAnalysis({ ...EXHAUSTED, keyValuePairs: { 'test.framework': 'Appium Server' } }, { attemptCount: 0, lastStatus: null }, { enabled: true });
    assert.equal(a.status, 'none');
    assert.equal(a.ineligibleReason, null);
    assert.equal(a.attemptsRemaining, 3);
  });
});

let server: http.Server;
let client: Client;
const seen: string[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    res.setHeader('Content-Type', 'application/json');
    const url = req.url ?? '';
    if (url === '/reporter/api/rca/info') return void res.end('{"enabled":true,"pollIntervalSec":15,"jobTimeoutMins":20}');
    if (url === `/reporter/api/reports/${COMPLETED.uuid}/rca/status`) return void res.end('{"attemptCount":0,"lastStatus":"completed","lastRcaId":"01a111e3"}');
    if (url === `/reporter/api/reports/${COMPLETED.uuid}`) return void res.end(JSON.stringify(COMPLETED));
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  resetClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, 'aut_1_rca', 'rca');
  const mcp = new McpServer({ name: 's', version: '0' });
  registerReportingTools(mcp);
  client = new Client({ name: 'c', version: '0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([mcp.connect(b), client.connect(a)]);
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('get_root_cause_analysis (handler)', () => {
  it('reads the report, status and info — and never calls /rca/trigger', async () => {
    const res = (await client.callTool({ name: 'get_root_cause_analysis', arguments: { reportUrl: `https://h/reporter/video-report/${COMPLETED.uuid}`, outputFormat: 'human' } })) as { content: Array<{ text?: string }>; isError?: boolean };
    const text = res.content.map((c) => c.text ?? '').join('');
    assert.notEqual(res.isError, true, text);
    assert.match(text, /Hypothesis: Login elements/);
    assert.match(text, /Device Agent Log @ 2026-10-06/);
    assert.ok(!seen.some((s) => s.includes('/rca/trigger')), 'must be read-only');
  });
});
