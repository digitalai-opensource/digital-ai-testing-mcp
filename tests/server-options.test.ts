/**
 * Server options kept in the profiles file (`setup options`, src/utils/server-options.ts): which can be stored, how a
 * value is checked, that a variable already set wins, and that the real server applies them at start (entry point over
 * stdio, stub API, a store in a temp folder: the developer's own profiles file is never read).
 */
import { describe, it, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startStubApi, accountInfo } from './helpers/offline.js';
import { SERVER_OPTIONS, applyStoredOptions, findServerOption, readStoredOptions } from '../src/utils/server-options.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** A profiles file with these options in a fresh temp folder; returns an environment that points the store at it. */
function storeWith(options: unknown): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), 'dai-options-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'profiles.json'), JSON.stringify({ version: 1, profiles: {}, ...(options === undefined ? {} : { options }) }));
  return { MCP_CREDENTIAL_STORE_DIR: dir };
}

describe('which options can be stored, and how a value is checked', () => {
  it('five options, found by variable name or short name; never a credential, a path or a store setting', () => {
    assert.deepEqual(SERVER_OPTIONS.map((o) => o.env), ['MCP_TOOLSETS', 'MCP_REPORT_POINTER', 'MCP_UPDATE_CHECK', 'MCP_DEBUG_MODE', 'MCP_SESSION_IDLE_TIMEOUT_SECONDS']);
    assert.equal(findServerOption('toolsets')?.env, 'MCP_TOOLSETS');
    assert.equal(findServerOption(' mcp_report_pointer ')?.alias, 'report-pointer');
    for (const never of ['DIGITAL_AI_ACCESS_KEY', 'DIGITAL_AI_BASE_URL', 'PATH', 'MCP_CREDENTIAL_STORE', 'MCP_CREDENTIAL_STORE_DIR', 'MCP_REPORT_DIR', 'NODE_OPTIONS']) {
      assert.equal(findServerOption(never), undefined, never);
    }
  });

  it('toolsets: names in any case, separated by commas or spaces; an unknown name is refused with the valid ones', () => {
    const t = findServerOption('toolsets')!;
    assert.deepEqual(t.check('core'), { value: 'core' });
    assert.deepEqual(t.check(' Reporting, DEVICES '), { value: 'reporting,devices' });
    assert.deepEqual(t.check('reporting devices'), { value: 'reporting,devices' });
    const bad = t.check('reporting,reports');
    assert.ok('error' in bad && /unknown toolset: reports \(valid: devices, apps, reporting, .*, core, all\)/.test(bad.error), JSON.stringify(bad));
    assert.ok('error' in t.check(' , '));
  });

  it('on/off options and the idle limit', () => {
    const p = findServerOption('report-pointer')!;
    assert.deepEqual(['true', 'ON', 'yes', '1'].map((v) => p.check(v)), Array(4).fill({ value: 'true' }));
    assert.deepEqual(['false', 'Off', 'no', '0'].map((v) => p.check(v)), Array(4).fill({ value: 'false' }));
    assert.ok('error' in p.check('maybe'));
    const idle = findServerOption('idle-timeout')!;
    assert.deepEqual(idle.check('600'), { value: '600' });
    for (const v of ['30', '5000', '90.5', 'ten']) assert.ok('error' in idle.check(v), v);
  });
});

describe('reading and applying the stored options', () => {
  it('reads what can be used and names what cannot; nothing is read with the store switched off', () => {
    const env = storeWith({ MCP_TOOLSETS: 'Core', 'report-pointer': false, MCP_SESSION_IDLE_TIMEOUT_SECONDS: 30, DIGITAL_AI_ACCESS_KEY: 'aut_1_x', MCP_DEBUG_MODE: { on: true } });
    const r = readStoredOptions(env);
    assert.deepEqual(r.options, { MCP_TOOLSETS: 'core', MCP_REPORT_POINTER: 'false' });
    assert.deepEqual(r.problems, [
      'option MCP_SESSION_IDLE_TIMEOUT_SECONDS: use a whole number of seconds from 60 to 1800; it is ignored',
      'option "DIGITAL_AI_ACCESS_KEY" is not one this server stores; it is ignored',
      'option MCP_DEBUG_MODE: the value is not text; it is ignored']);
    assert.ok(!JSON.stringify(r).includes('aut_1_x'), 'a value that is not an option is never repeated');
    assert.deepEqual(readStoredOptions({ ...env, MCP_CREDENTIAL_STORE: 'off' }), { options: {}, problems: [] });
    assert.deepEqual(readStoredOptions(storeWith(undefined)), { options: {}, problems: [] });
    assert.deepEqual(readStoredOptions(storeWith(['MCP_TOOLSETS'])).problems, ['"options" in the profiles file is not an object; it is ignored']);
  });

  it('a variable that is already set wins; an unset or empty one takes the stored value', () => {
    const env: NodeJS.ProcessEnv = { ...storeWith({ MCP_TOOLSETS: 'core', MCP_REPORT_POINTER: 'false', MCP_UPDATE_CHECK: 'false' }), MCP_TOOLSETS: 'reporting', MCP_UPDATE_CHECK: ' ' };
    const r = applyStoredOptions(env);
    assert.deepEqual(r.applied, { MCP_REPORT_POINTER: 'false', MCP_UPDATE_CHECK: 'false' });
    assert.deepEqual(r.overridden, ['MCP_TOOLSETS']);
    assert.equal(env.MCP_TOOLSETS, 'reporting', 'the client configuration is not overwritten');
    assert.equal(env.MCP_REPORT_POINTER, 'false');
    assert.equal(env.MCP_UPDATE_CHECK, 'false');
  });

  it('a broken profiles file changes nothing and does not throw', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dai-options-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'profiles.json'), '{ not json');
    const env: NodeJS.ProcessEnv = { MCP_CREDENTIAL_STORE_DIR: dir };
    assert.deepEqual(applyStoredOptions(env).applied, {});
    assert.equal(env.MCP_TOOLSETS, undefined);
  });
});

describe('the server applies them at start (real entry point over stdio, stub API)', () => {
  const ENTRY = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.ts');
  const TSX_LOADER = import.meta.resolve('tsx');
  const device = (k: number) => ({ id: k, udid: `u${k}`, deviceName: `Device ${k}`, deviceOs: 'Android', osVersion: '14', modelName: 'M', displayStatus: 'Available', currentStatus: 'Available',
    statusAgeInMinutes: 5, region: 'US1', agentName: 'h1', deviceCategory: 'PHONE', tags: [], isEmulator: false });

  async function start(options: unknown, extraEnv: Record<string, string> = {}) {
    const api = await startStubApi((req) => {
      if (req.path === '/api/v1/users/my-account-info') return accountInfo('Admin', 'Default');
      if (req.path === '/api/v1/devices') return { status: 'SUCCESS', data: Array.from({ length: 8 }, (_, k) => device(k)) };
      return undefined;
    });
    const store = storeWith(options).MCP_CREDENTIAL_STORE_DIR!;
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) { if (v !== undefined && !/^(DIGITAL_AI_|DAI_PROFILE_|MCP_)/.test(k)) env[k] = v; }
    Object.assign(env, { MCP_CREDENTIAL_STORE_DIR: store, DIGITAL_AI_BASE_URL: api.baseUrl, DIGITAL_AI_ACCESS_KEY: 'aut_1_options' }, extraEnv);
    const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', TSX_LOADER, ENTRY], env, cwd: store, stderr: 'ignore' });
    const client = new Client({ name: 'server-options-test', version: '1.0.0' });
    await client.connect(transport);
    const tools = new Map((await client.listTools()).tools.map((t) => [t.name, t.description ?? '']));
    const call = async (name: string, args: Record<string, unknown>) => ((await client.callTool({ name, arguments: args })) as { content: Array<{ text?: string }> }).content.map((c) => c.text ?? '').join('\n');
    return { tools, call, async close() { await client.close(); await api.close(); } };
  }

  it('toolsets, the update check and the report pointer come from the store; get_server_info says so', async () => {
    const s = await start({ MCP_TOOLSETS: 'core', MCP_UPDATE_CHECK: 'false', MCP_REPORT_POINTER: 'false' });
    try {
      assert.match(s.tools.get('list_devices')!, /^\[devices toolset — loads on first call/, 'MCP_TOOLSETS=core from the store');
      assert.doesNotMatch(s.tools.get('create_report')!, /^\[/);
      const info = await s.call('get_server_info', {});
      assert.match(info, /Server options from setup: MCP_TOOLSETS=core, MCP_UPDATE_CHECK=false, MCP_REPORT_POINTER=false/);
      await s.call('list_devices', {}); // loads the toolset
      const devices = await s.call('list_devices', { outputFormat: 'json' });
      assert.match(devices, /Device 7/);
      assert.doesNotMatch(devices, /Presenting this to the user/, 'the report pointer is off');
    } finally { await s.close(); }
  }, 60_000);

  it('a variable in the client configuration wins over the stored option', async () => {
    const s = await start({ MCP_TOOLSETS: 'core' }, { MCP_TOOLSETS: 'all', MCP_UPDATE_CHECK: 'false' });
    try {
      assert.doesNotMatch(s.tools.get('list_devices')!, /^\[devices toolset/);
      assert.match(await s.call('get_server_info', {}), /Server options from setup: none in effect \(set in the client's configuration instead: MCP_TOOLSETS\)/);
    } finally { await s.close(); }
  }, 60_000);
});
