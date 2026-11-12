/**
 * Playwright runs through the Execution Service API (execute_playwright_run + the UUID branch of get_test_run_status /
 * cancel_test_run). Wire format verified live 2026-11-12: multipart type/project/conf to POST /api/v1/executions,
 * UUID run ids, QUEUED with "Reason for Queue", PUT …/actions/cancel → CANCELED, logs as a zip.
 */
import { describe, it, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AdmZip from 'adm-zip';
import {
  isPlaywrightRunId,
  loadPlaywrightProject,
  buildPlaywrightConf,
  normalizePlaywrightStatus,
} from '../src/api/playwright-runs.js';
import { registerTestRunTools } from '../src/tools/test-run-tools.js';
import { startStubApi, connectTools, reply, type StubApi, type ToolClient } from './helpers/offline.js';

const RUN = 'f5e9dbfa-0a2f-440d-be2a-b82864a17781';
let dir: string;
let project: string;
let api: StubApi;
let tools: ToolClient;
const submissions: string[] = [];
let state = 'QUEUED';

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'pw-runs-'));
  project = join(dir, 'shop-tests');
  mkdirSync(join(project, 'tests'), { recursive: true });
  mkdirSync(join(project, 'node_modules', '@playwright', 'test'), { recursive: true });
  mkdirSync(join(project, 'playwright-report'), { recursive: true });
  writeFileSync(join(project, 'tests', 'cart.spec.ts'), "import { test } from '@playwright/test';\ntest('cart', async () => {});\n");
  writeFileSync(join(project, 'playwright.config.ts'), 'export default { projects: [{ name: "chromium" }] };\n');
  writeFileSync(join(project, 'package.json'), JSON.stringify({ devDependencies: { '@playwright/test': '^1.49.1' } }));
  writeFileSync(join(project, 'node_modules', '@playwright', 'test', 'index.js'), 'x');
  writeFileSync(join(project, 'playwright-report', 'index.html'), 'x');
  writeFileSync(join(project, '.env'), 'SECRET=1');
  writeFileSync(join(project, 'id_rsa'), 'key');

  api = await startStubApi((req) => {
    if (req.path === '/api/v1/executions' && req.method === 'POST') {
      submissions.push(req.raw);
      if (/v0\.0\.1|"0\.0\.1"/.test(req.raw)) return reply(400, { status: 'ERROR', data: { message: 'The version of Playwright entered is invalid, Could not find image [mcr.microsoft.com/playwright:v0.0.1]' } });
      return { status: 'SUCCESS', code: 'OK', data: { 'Test Run Id': RUN, 'Link to Reporter': 'https://cloud/reporter?run' } };
    }
    if (req.path === `/api/v1/executions/${RUN}/status`) {
      return { status: 'SUCCESS', code: 'OK', data: { 'Test Run Id': RUN, 'Test Run State': state, ...(state === 'QUEUED' ? { 'Reason for Queue': 'Waiting for licenses' } : {}), 'Link to Reporter': 'https://cloud/reporter?run' } };
    }
    if (req.path === `/api/v1/executions/${RUN}/actions/cancel` && req.method === 'PUT') {
      if (state === 'CANCELED') return 'Invalid request. This execution session is already canceled';
      state = 'CANCELED';
      return `Execution session id - ${RUN} canceled`;
    }
    if (req.path === `/api/v1/executions/${RUN}/logs`) {
      const z = new AdmZip();
      z.addFile('run.log', Buffer.from('chromium: 1 passed'));
      return reply(200, [z.toBuffer()]);
    }
    if (req.path === '/api/v1/test-run/123/status') return { data: { 'Test Run State': 'Finished', 'Number of passed tests': '2' } };
    return undefined;
  });
  tools = await connectTools(registerTestRunTools);
});
afterAll(async () => { await tools.close(); await api.close(); rmSync(dir, { recursive: true, force: true }); });

describe('playwright runs (pure)', () => {
  it('a UUID is a Playwright run, a number is a Test Run API run', () => {
    assert.equal(isPlaywrightRunId(RUN), true);
    assert.equal(isPlaywrightRunId('27971404'), false);
  });

  it('zips a project folder without node_modules, reports or credential files, and reads the @playwright/test version', () => {
    const p = loadPlaywrightProject(project);
    assert.deepEqual([...p.files].sort(), ['package.json', 'playwright.config.ts', 'tests/cart.spec.ts']);
    assert.ok(p.skipped.includes('node_modules/') && p.skipped.includes('playwright-report/') && p.skipped.includes('.env') && p.skipped.includes('id_rsa'), p.skipped.join(','));
    assert.equal(p.hasConfig, true);
    assert.equal(p.specCount, 1);
    assert.equal(p.detectedVersion, '1.49.1');
    assert.equal(p.fileName, 'shop-tests.zip');
  });

  it('builds conf: config projects pin only the image; explicit browsers list one entry each; bad versions refused', () => {
    assert.deepEqual(buildPlaywrightConf({ hasConfig: true }, '1.49.0'), { browsers: [{ imageVersion: '1.49.0' }] });
    assert.deepEqual(buildPlaywrightConf({ hasConfig: false }, '1.49.0', ['chromium', 'webkit']), { browsers: [{ browser: 'chromium', imageVersion: '1.49.0' }, { browser: 'webkit', imageVersion: '1.49.0' }] });
    assert.match(String(buildPlaywrightConf({ hasConfig: false }, '1.49.0')), /pass browsers/);
    assert.match(String(buildPlaywrightConf({ hasConfig: true }, 'latest')), /must look like "1\.49\.0"/);
  });

  it('normalizes the live QUEUED / CANCELED payloads', () => {
    const q = normalizePlaywrightStatus(RUN, { 'Test Run State': 'QUEUED', 'Reason for Queue': 'Waiting for licenses', 'Number of requested browsers': '2', 'Number of browsers in queue': '2' });
    assert.equal(q.finished, false);
    assert.equal(q.kind, 'playwright');
    assert.equal(q.queueReason, 'Waiting for licenses');
    assert.equal(q.counts.requested, 2);
    assert.equal(normalizePlaywrightStatus(RUN, { 'Test Run State': 'CANCELED' }).finished, true);
    assert.equal(normalizePlaywrightStatus(RUN, { 'Test Run State': 'RUNNING' }).finished, false);
  });
});

describe('execute_playwright_run → get_test_run_status → cancel_test_run (UUID routing)', () => {
  it('submits type=Playwright, the zipped project and conf with the detected image version', async () => {
    const j = await tools.callJson('execute_playwright_run', { projectPath: project });
    assert.equal(j.testRunId, RUN);
    assert.equal(j.imageVersion, '1.49.1');
    assert.equal(j.imageVersionSource, 'package.json');
    const raw = submissions.at(-1)!;
    assert.match(raw, /name="type"\r\n\r\nPlaywright/);
    assert.match(raw, /name="project"; filename="shop-tests\.zip"/);
    assert.match(raw, /name="conf"\r\n\r\n\{"browsers":\[\{"imageVersion":"1\.49\.1"\}\]\}/);
    assert.doesNotMatch(raw, /SECRET=1/, 'the .env file never leaves the machine');
  });

  it('the platform\'s image check comes back as the error', async () => {
    const r = await tools.call('execute_playwright_run', { projectPath: project, imageVersion: '0.0.1' });
    assert.equal(r.res.isError, true);
    assert.match(r.text, /Could not find image \[mcr\.microsoft\.com\/playwright:v0\.0\.1\]/);
  });

  it('refuses a project with no tests, and one with no version to take', async () => {
    const empty = join(dir, 'empty');
    mkdirSync(empty);
    writeFileSync(join(empty, 'README.md'), 'x');
    let r = await tools.call('execute_playwright_run', { projectPath: empty });
    assert.match(r.text, /no Playwright tests found/);
    const noPkg = join(dir, 'nopkg');
    mkdirSync(noPkg);
    writeFileSync(join(noPkg, 'a.spec.js'), 'x');
    r = await tools.call('execute_playwright_run', { projectPath: noPkg, browsers: ['chromium'] });
    assert.match(r.text, /pass imageVersion/);
  });

  it('status of a UUID reads the Execution Service and explains a license queue', async () => {
    const r = await tools.call('get_test_run_status', { testRunId: RUN, outputFormat: 'human' });
    assert.match(r.text, /🎭 Playwright run .*: QUEUED \(in progress\)/);
    assert.match(r.text, /Queued because: Waiting for licenses — the cloud has no free Playwright \(Cross Browser\) license/);
    const numeric = await tools.call('get_test_run_status', { testRunId: '123', outputFormat: 'human' });
    assert.match(numeric.text, /🧪 Test run 123: Finished/);
  });

  it('cancel of a UUID uses PUT …/actions/cancel; a repeat says it was already canceled', async () => {
    let r = await tools.call('cancel_test_run', { testRunId: RUN, confirmDeletion: true, outputFormat: 'human' });
    assert.match(r.text, /🛑 Cancel requested\.\n🎭 Playwright run .*: CANCELED/);
    r = await tools.call('cancel_test_run', { testRunId: RUN, confirmDeletion: true, outputFormat: 'human' });
    assert.match(r.text, /already canceled/);
  });

  it('logsPath saves the run\'s logs zip (Playwright ids only)', async () => {
    const out = join(dir, 'logs.zip');
    const r = await tools.call('get_test_run_status', { testRunId: RUN, logsPath: out, outputFormat: 'human' });
    assert.match(r.text, /Logs: \d+ bytes written to .*logs\.zip \(1 file\)/);
    assert.ok(existsSync(out));
    assert.equal(new AdmZip(readFileSync(out)).getEntry('run.log')?.getData().toString(), 'chromium: 1 passed');
    const bad = await tools.call('get_test_run_status', { testRunId: '123', logsPath: out });
    assert.match(bad.text, /logsPath is for Playwright runs/);
  });
});
