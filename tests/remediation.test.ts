/**
 * Debug mode (MCP_DEBUG_MODE) — event log, notes, nudges, redaction. Off must mean no behaviour change.
 */
import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  isDebugMode, redact, classifyOutcome, instrumentHandler, startRemediationSession, getRecordedEvents, saveNote,
  debugInstructions, summarizeEvents, REMEDIATION_CATEGORIES,
} from '../src/utils/remediation.js';
import { registerRemediationTools } from '../src/tools/remediation-tools.js';

const saved = { ...process.env };
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'remediation-'));
  process.env.MCP_REMEDIATION_DIR = dir;
  process.env.MCP_DEBUG_MODE = 'true';
  process.env.MCP_DEPLOYMENT_MODE = 'local';
  startRemediationSession({ mcpVersion: '9.9.9', toolsets: 'all', client: () => ({ name: 'test-client', version: '1.0' }), now: new Date(2026, 9, 9, 16, 30, 12) });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const k of ['MCP_REMEDIATION_DIR', 'MCP_DEBUG_MODE', 'MCP_DEPLOYMENT_MODE']) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const ok = (text = 'fine') => ({ content: [{ type: 'text', text }] });
const err = (text = 'Error: boom') => ({ content: [{ type: 'text', text }], isError: true });

describe('MCP_DEBUG_MODE flag', () => {
  it('is off unless explicitly true', () => {
    for (const v of [undefined, '', 'false', '0', 'no', 'debug']) {
      if (v === undefined) delete process.env.MCP_DEBUG_MODE;
      else process.env.MCP_DEBUG_MODE = v;
      assert.equal(isDebugMode(), false, String(v));
    }
    for (const v of ['true', 'TRUE', '1', 'yes']) {
      process.env.MCP_DEBUG_MODE = v;
      assert.equal(isDebugMode(), true, v);
    }
  });

  it('registers record_remediation_note only when on', () => {
    const names = (on: boolean) => {
      process.env.MCP_DEBUG_MODE = on ? 'true' : 'false';
      const s = new McpServer({ name: 's', version: '0' });
      registerRemediationTools(s);
      return Object.keys((s as unknown as { _registeredTools: Record<string, unknown> })._registeredTools);
    };
    assert.deepEqual(names(false), []);
    assert.deepEqual(names(true), ['record_remediation_note']);
  });

  it('instructions list all six categories and where notes go', () => {
    const text = debugInstructions();
    for (const c of REMEDIATION_CATEGORIES) assert.match(text, new RegExp(`\\b${c}\\b`));
    assert.match(text, /~\/remediation/);
    assert.match(text, /Never include credentials/);
  });
});

describe('redact', () => {
  it('removes keys, JWTs, emails, bearer tokens and signed-URL parameters', () => {
    process.env.SOME_PROFILE_KEY = 'custom-secret-value-123';
    const out = redact(
      'key aut_1_abcdef123456 jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U ' +
      'mail joe@example.com Authorization: Bearer abcdefghijklmnop url https://x/y?token=abc123def&ok=1 custom-secret-value-123 accessKey: "zzzzzzzz"'
    );
    delete process.env.SOME_PROFILE_KEY;
    assert.doesNotMatch(out, /aut_1_abcdef|eyJhbGci|joe@example|abcdefghijklmnop|abc123def|custom-secret-value|zzzzzzzz/);
    assert.match(out, /ok=1/);
  });
});

describe('event log and nudges', () => {
  it('classifies ok, error and guard (deliberate stops are not failures)', () => {
    assert.equal(classifyOutcome(ok()).outcome, 'ok');
    assert.equal(classifyOutcome(err()).outcome, 'error');
    assert.equal(classifyOutcome(ok('⚠️  Large export guard triggered.')).outcome, 'guard');
    assert.equal(classifyOutcome(err('{"status": "blocked", "reason": "no_verified_selectors"}')).outcome, 'guard');
    assert.equal(classifyOutcome(ok('Re-call with confirmDeletion: true to delete')).outcome, 'guard');
  });

  it('records each call, flags retries and repeats, and nudges once per tool and outcome', async () => {
    let n = 0;
    const flaky = instrumentHandler('get_test_report', async () => (++n <= 2 ? err('Error: not found') : ok('report')));
    const r1 = (await flaky({ testId: 1 })) as { content: Array<{ text: string }> };
    const r2 = (await flaky({ testId: 1 })) as { content: Array<{ text: string }> };
    const r3 = (await flaky({ testId: 2 })) as { content: Array<{ text: string }> };
    assert.match(r1.content.at(-1)!.text, /\[debug mode\].*record_remediation_note/);
    assert.equal(r2.content.length, 1, 'no second nudge for the same tool+outcome');
    assert.equal(r3.content.length, 1, 'no nudge on success');
    const ev = getRecordedEvents();
    assert.deepEqual(ev.map((e) => e.outcome), ['error', 'error', 'ok']);
    assert.equal(ev[1].retryAfter, 'error');
    assert.equal(ev[1].repeatedArgs, true);
    assert.equal(ev[2].retryAfter, 'error');
    assert.equal(ev[2].repeatedArgs, undefined);
    assert.ok(ev.every((e) => typeof e.ms === 'number' && e.responseChars > 0));
    assert.match(summarizeEvents(), /3 tool calls: 1 ok, 2 error, 0 guard/);
    assert.match(summarizeEvents(), /Retried after an error\/guard: get_test_report/);
  });

  it('does not change a successful result and does not nudge placeholders', async () => {
    const result = ok('data');
    assert.equal(await instrumentHandler('list_devices', async () => result)({}), result);
    const ph = (await instrumentHandler('list_devices', async () => ok('Nothing was executed. Read the guidance.'), { placeholder: true })()) as { content: unknown[] };
    assert.equal(ph.content.length, 1);
    assert.equal(getRecordedEvents().at(-1)!.placeholder, true);
  });

  it("writes the event log (session header first) when the server is on the user's machine", async () => {
    await instrumentHandler('list_devices', async () => ok())({ os: 'android' });
    const [file] = readdirSync(dir).filter((f) => f.endsWith('.events.jsonl'));
    assert.match(file, /^20261009163012-[0-9a-f]{4}\.events\.jsonl$/);
    const lines = readFileSync(join(dir, file), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines[0].type, 'session');
    assert.equal(lines[0].client, 'test-client 1.0');
    assert.equal(lines[1].tool, 'list_devices');
    assert.deepEqual(lines[1].args, { os: 'android' });
  });

  it('keeps events in memory only under Docker', async () => {
    process.env.MCP_DEPLOYMENT_MODE = 'docker';
    await instrumentHandler('list_devices', async () => ok())({});
    assert.deepEqual(readdirSync(dir), []);
    assert.equal(getRecordedEvents().length, 1);
  });
});

describe('notes', () => {
  const note = {
    category: 'unclear-guidance' as const,
    title: 'install_application 400 while reserved',
    intent: 'Install the app, then debug it',
    whatHappened: 'Called get_remote_debug_command first, then install_application → 400. Key aut_1_abcdef123456 was active.',
    resolution: 'Install before connecting rdb',
    resolved: true,
    tools: ['install_application', 'get_remote_debug_command'],
    wastedCalls: 2,
  };

  it('local: appends to ~/remediation/<session>.md with front matter once, redacted', () => {
    const first = saveNote(note);
    saveNote({ ...note, category: 'better-path', title: 'Second' });
    assert.ok(first.written);
    const text = readFileSync(first.written!, 'utf8');
    assert.equal((text.match(/^---$/gm) ?? []).length, 2, 'one front-matter block');
    assert.match(text, /mcpVersion: 9\.9\.9/);
    assert.match(text, /eventsLog: 20261009163012-[0-9a-f]{4}\.events\.jsonl/);
    assert.match(text, /## \[unclear-guidance\] install_application 400 while reserved/);
    assert.match(text, /## \[better-path\] Second/);
    assert.match(text, /Calls that did not move the task forward:\*\* 2/);
    assert.doesNotMatch(text, /aut_1_abcdef/);
  });

  it('Docker: returns the markdown (with server-observed events) instead of writing', async () => {
    process.env.MCP_DEPLOYMENT_MODE = 'docker';
    await instrumentHandler('install_application', async () => err('Error: 400'))({ appId: 1 });
    const r = saveNote(note);
    assert.equal(r.written, null);
    assert.deepEqual(readdirSync(dir), []);
    assert.match(r.fileName, /^20261009163012-[0-9a-f]{4}\.md$/);
    assert.match(r.markdown, /^---\nsession: /);
    assert.match(r.markdown, /Server-observed events[\s\S]*1 tool calls: 0 ok, 1 error/);
    assert.doesNotMatch(saveNote(note).markdown, /^---/, 'front matter only on the first note');
  });
});
