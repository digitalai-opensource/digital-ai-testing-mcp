import { describe, it, assert, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { proposeFlows } from '../src/utils/exploration-flows.js';
import { startStubApi, connectTools, type StubApi, type ToolClient } from './helpers/offline.js';
import { registerExplorationTools } from '../src/tools/exploration-tools.js';

const loc = (v: string) => ({ using: 'xpath', value: `//*[@text='${v}']` });
const manifest = {
  app: { platform: 'android', appId: 'com.acme.bank', version: '3.1' }, device: { name: 'Pixel', os: 'Android', version: '14' },
  startedAt: '', stoppedBecause: 'finished', taps: 9, notes: [],
  screens: [
    { signature: 'a', title: 'Sign in', foreground: null, path: [], elements: 9, assertable: [], navigation: [], notVisited: [], login: 'done' },
    { signature: 'b', title: 'Home', foreground: null, path: [], elements: 30, assertable: [{ label: 'Balance', locator: loc('Balance') }], navigation: [], notVisited: [{ label: 'Log Out', kind: 'destructive', reason: '' }] },
    { signature: 'c', title: 'Transfer', foreground: null, path: [{ label: 'Transfer', locator: loc('Transfer') }], elements: 20, assertable: [{ label: 'Amount', locator: loc('Amount') }],
      navigation: [], notVisited: [{ label: 'Amount', kind: 'input', reason: '' }, { label: 'To account', kind: 'input', reason: '' }, { label: 'Send money', kind: 'action', reason: '' }] },
  ],
};

describe('proposeFlows', () => {
  it('proposes log in, opening each screen, filling each form and each destructive action (marked)', () => {
    const flows = proposeFlows(manifest as never);
    assert.deepEqual(flows.map((f) => [f.id, f.kind]), [['login', 'login'], ['confirm-log-out', 'destructive'], ['open-transfer', 'navigate'], ['submit-transfer', 'form']]);
    const form = flows.find((f) => f.kind === 'form')!;
    assert.deepEqual(form.needsData, ['Amount', 'To account']);
    assert.equal(form.action, 'Send money');
    assert.match(flows.find((f) => f.kind === 'destructive')!.caution!, /Destructive/);
    assert.equal(flows.find((f) => f.id === 'open-transfer')!.check?.label, 'Amount');
  });
});

describe('app_exploration_flows', () => {
  let stub: StubApi; let t: ToolClient;
  const dir = mkdtempSync(join(tmpdir(), 'dai-flows-'));
  const saved = process.env.MCP_EXPLORATION_DIR;
  beforeAll(async () => {
    process.env.MCP_EXPLORATION_DIR = dir;
    writeFileSync(join(dir, 'explore-bank1.json'), JSON.stringify(manifest));
    stub = await startStubApi(() => undefined);
    t = await connectTools(registerExplorationTools);
  });
  afterAll(async () => { await t.close(); await stub.close(); if (saved === undefined) delete process.env.MCP_EXPLORATION_DIR; else process.env.MCP_EXPLORATION_DIR = saved; rmSync(dir, { recursive: true, force: true }); });

  it('lists proposals, refuses unknown ids, and saves only the accepted ones with the exploration', async () => {
    let r = await t.call('app_exploration_flows', { jobId: 'explore-bank1', outputFormat: 'human' });
    assert.match(r.text, /4 proposed flow\(s\)/);
    assert.match(r.text, /submit-transfer: Fill and submit Transfer .* needs test data: Amount, To account/);
    r = await t.call('app_exploration_flows', { jobId: 'explore-bank1', accept: ['nope'] });
    assert.equal(r.res.isError, true);
    r = await t.call('app_exploration_flows', { jobId: 'explore-bank1', accept: ['login', 'open-transfer'], outputFormat: 'human' });
    assert.match(r.text, /Accepted 2 flow\(s\)/);
    const stored = JSON.parse(readFileSync(join(dir, 'explore-bank1.json'), 'utf8'));
    assert.deepEqual(stored.acceptedFlows.map((a: { id: string }) => a.id), ['login', 'open-transfer']);
    r = await t.call('app_exploration_flows', { jobId: 'explore-bank1', outputFormat: 'human' });
    assert.match(r.text, /open-transfer: .*\[accepted; (not run yet|last run)/);
  });
});
