/**
 * Debug mode (MCP_DEBUG_MODE) — event log, notes, nudges, redaction. Off must mean no behaviour change.
 */
import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { homedir, hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  isDebugMode, redact, classifyOutcome, instrumentHandler, startRemediationSession, getRecordedEvents, saveNote,
  debugInstructions, debugStatusLine, summarizeEvents, REMEDIATION_CATEGORIES, resolveRemediationLocation, looksLikeProject, locateStartFolder,
  ensureRemediationDir, getRemediationSession, nudgeFor, recordToolEvent, isSensitiveArg,
  setDebugMode, onDebugModeChange, debugModeOverridden, configuredDebugMode, resetDebugModeForTests,
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
  resetDebugModeForTests();
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

  // Both are registered either way; index.ts hides record_remediation_note while debug mode is off (set_debug_mode).
  it('registers set_debug_mode and record_remediation_note whether debug mode is on or off', () => {
    const names = (on: boolean) => {
      process.env.MCP_DEBUG_MODE = on ? 'true' : 'false';
      const s = new McpServer({ name: 's', version: '0' });
      registerRemediationTools(s);
      return Object.keys((s as unknown as { _registeredTools: Record<string, unknown> })._registeredTools);
    };
    assert.deepEqual(names(false), ['set_debug_mode', 'record_remediation_note']);
    assert.deepEqual(names(true), ['set_debug_mode', 'record_remediation_note']);
  });

  it('instructions list all six categories and where notes go', () => {
    const text = debugInstructions();
    for (const c of REMEDIATION_CATEGORIES) assert.match(text, new RegExp(`\\b${c}\\b`));
    assert.match(text, /remediation\/ folder of the project/);
    assert.match(text, /Never include credentials/);
  });

  it('instructions open with debug mode, state its purpose, and exempt expected outcomes', () => {
    const text = debugInstructions();
    assert.match(text, /^DEBUG MODE IS ON/, 'first, so client truncation cannot cut it');
    assert.match(text, /improve this MCP's functionality and cut wasted tokens/);
    assert.match(text, /Do NOT record expected outcomes — deliberate negative tests/);
    assert.match(text, /\n\n$/, 'separated from the server instructions that follow');
  });

  it('debug status line states the mode whether it is on or off', () => {
    assert.match(debugStatusLine(), /^Debug mode:\s+ON — call record_remediation_note .*not for expected errors/);
    process.env.MCP_DEBUG_MODE = 'false';
    assert.match(debugStatusLine(), /^Debug mode:\s+OFF \(MCP_DEBUG_MODE\) — no remediation notes are recorded\. .*set_debug_mode/);
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
    assert.equal(classifyOutcome(ok('⚠️  Preview — nothing has been shared.')).outcome, 'guard');
    // Generated code that merely mentions "blocked" is a normal result, not a guard.
    const boilerplate = JSON.stringify({ platform: 'android', serverModeNote: 'x'.repeat(500), files: [{ content: '// the request is blocked until login completes' }] });
    assert.equal(classifyOutcome(ok(boilerplate)).outcome, 'ok');
  });

  it('validate_test_script verdicts get no debug reminder; other tools still do', () => {
    startRemediationSession({ mcpVersion: 't', toolsets: 'all', client: () => undefined });
    assert.equal(nudgeFor('validate_test_script', 'error', 'fail'), null);
    assert.match(nudgeFor('get_test_report', 'error', 'boom') ?? '', /^\[debug mode\]/);
  });

  it('never records typed text or secret arguments — only their length', () => {
    startRemediationSession({ mcpVersion: 't', toolsets: 'all', client: () => undefined });
    const typed = recordToolEvent({ tool: 'type_into_element', args: { handle: 'h1', strategy: 'id', selector: 'password', text: 'Hunter2!pw' }, ms: 1, result: ok() });
    assert.equal(typed.args.text, '‹10 chars, not recorded›');
    assert.equal(typed.args.selector, 'password', 'the locator is still recorded');
    const clip = recordToolEvent({ tool: 'device_control', args: { action: 'set_clipboard', text: 'otp 482913' }, ms: 1, result: ok() });
    assert.equal(clip.args.text, '‹10 chars, not recorded›');
    const p12 = recordToolEvent({ tool: 'upload_provisioning_profile', args: { password: 'p12-secret', keyPassword: 'k', keystorePassword: 'ks' }, ms: 1, result: ok() });
    assert.deepEqual(p12.args, { password: '‹10 chars, not recorded›', keyPassword: '‹1 chars, not recorded›', keystorePassword: '‹2 chars, not recorded›' });
    // A `text` argument on other tools (a Maestro step's visible text, a search) is not typed input — still recorded.
    assert.equal(isSensitiveArg('generate_maestro_flow', 'text'), false);
    assert.ok(!JSON.stringify(getRecordedEvents()).match(/Hunter2|482913|p12-secret/));
  });

  it('records each call, flags retries and repeats, and nudges once per tool and outcome', async () => {
    let n = 0;
    const flaky = instrumentHandler('get_test_report', async () => (++n <= 2 ? err('Error: not found') : ok('report')));
    const r1 = (await flaky({ testId: 1 })) as { content: Array<{ text: string }> };
    const r2 = (await flaky({ testId: 1 })) as { content: Array<{ text: string }> };
    const r3 = (await flaky({ testId: 2 })) as { content: Array<{ text: string }> };
    assert.match(r1.content[0].text, /^\[debug mode\] If this error was unexpected .*Skip it if the error was expected/, 'leads the response, not a trailing footer');
    assert.equal(r1.content[1].text, 'Error: not found', 'the tool result itself is kept');
    assert.equal(r2.content.length, 1, 'no second nudge for the same error');
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

  it('a different error from the same tool gets its own reminder', async () => {
    let n = 0;
    const tool = instrumentHandler('start_inspection_session', async () =>
      err(++n === 1 ? 'Error: CarPlay supports automotiveProjection "800x480" only.' : 'Error: HTTP 500: Automotive Projection is only supported on Apple Silicon Device Host Machines'));
    const a = (await tool({})) as { content: Array<{ text: string }> };
    const b = (await tool({})) as { content: Array<{ text: string }> };
    assert.match(a.content[0].text, /^\[debug mode\]/);
    assert.match(b.content[0].text, /^\[debug mode\]/);
  });

  it('puts the reminder inside a JSON payload as _debugMode, keeping the payload parseable', async () => {
    const payload = { verdict: 'fail', highSeverityCount: 2 };
    const r = (await instrumentHandler('execute_test_run', async () => ({ content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], isError: true }))({})) as { content: Array<{ text: string }> };
    assert.equal(r.content.length, 1);
    const parsed = JSON.parse(r.content[0].text);
    assert.match(parsed._debugMode, /^\[debug mode\]/);
    assert.equal(Object.keys(parsed)[0], '_debugMode', 'first key, so it is seen');
    assert.equal(parsed.verdict, 'fail');
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

  it('writes the session header again when the log was moved away while the server kept running', async () => {
    await instrumentHandler('list_devices', async () => ok())({ os: 'android' });
    const [file] = readdirSync(dir).filter((f) => f.endsWith('.events.jsonl'));
    const first = readFileSync(join(dir, file), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(first[0].continued, undefined, 'the first header is not a continuation');
    rmSync(join(dir, file)); // what an intake's archive does to it

    await instrumentHandler('list_devices', async () => ok())({ os: 'ios' });
    await instrumentHandler('list_devices', async () => ok())({ os: 'ios', maxResults: 5 });
    const lines = readFileSync(join(dir, file), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((l) => l.type), ['session', 'tool', 'tool'], 'one header, then the events');
    assert.equal(lines[0].continued, true);
    assert.equal(lines[0].mcpVersion, '9.9.9');
    assert.equal(lines[0].session, file.replace('.events.jsonl', ''));
  });

  it('keeps events in memory only under Docker', async () => {
    process.env.MCP_DEPLOYMENT_MODE = 'docker';
    await instrumentHandler('list_devices', async () => ok())({});
    assert.deepEqual(readdirSync(dir), []);
    assert.equal(getRecordedEvents().length, 1);
  });
});

describe('location: the client project, never committed', () => {
  const restart = (roots?: () => Promise<string[]>) =>
    startRemediationSession({ mcpVersion: '9.9.9', toolsets: 'all', client: () => undefined, roots, now: new Date(2026, 9, 9, 16, 30, 12) });

  it('prefers the client workspace root (MCP roots) over the start folder and home', async () => {
    delete process.env.MCP_REMEDIATION_DIR;
    const project = mkdtempSync(join(tmpdir(), 'client-project-'));
    restart(async () => [pathToFileURL(project).href]);
    try {
      const loc = await resolveRemediationLocation();
      assert.deepEqual(loc, { dir: join(project, 'remediation'), source: 'client-roots' });
      await instrumentHandler('list_devices', async () => ok())({});
      assert.ok(existsSync(join(project, 'remediation', `${getRemediationSession()!.id}.events.jsonl`)));
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('falls back to ./remediation in the start folder when it is a project; a failing roots call is harmless', async () => {
    delete process.env.MCP_REMEDIATION_DIR;
    restart(async () => { throw new Error('client has no roots'); });
    const loc = await resolveRemediationLocation();
    // The test runner starts in this repo (it has package.json), so the start folder qualifies.
    assert.deepEqual(loc, { dir: join(process.cwd(), 'remediation'), source: 'start-folder' });
    assert.notEqual(loc.dir, join(homedir(), 'remediation'));
  });

  it('a start folder that is not a project (home, a drive root, System32) gets no folder — never ~/remediation', () => {
    assert.equal(looksLikeProject(process.cwd()), true);
    assert.equal(looksLikeProject(homedir()), false);
    const empty = mkdtempSync(join(tmpdir(), 'not-a-project-'));
    try {
      assert.equal(looksLikeProject(empty), false);
      assert.deepEqual(locateStartFolder(empty), { dir: '', source: 'none' });
      assert.deepEqual(locateStartFolder(homedir()), { dir: '', source: 'none' });
      assert.deepEqual(locateStartFolder('C:\\'), { dir: '', source: 'none' });
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('MCP_REMEDIATION_DIR wins, and the folder ignores itself so it can never be committed', async () => {
    restart(async () => ['file:///somewhere/else']);
    assert.deepEqual(await resolveRemediationLocation(), { dir, source: 'env' });
    ensureRemediationDir();
    assert.match(readFileSync(join(dir, '.gitignore'), 'utf8'), /^\*$/m);
  });

  it('records machine, user and location in the notes front matter', () => {
    const r = saveNote({ category: 'improvement', title: 'x', intent: 'y', whatHappened: 'z' });
    const text = readFileSync(r.written!, 'utf8');
    assert.match(text, new RegExp(`machine: ${hostname()}`));
    assert.match(text, /^user: \S+/m);
    assert.match(text, /^location: env /m);
  });

  it('Docker: tells the agent to save in its project and create the self-ignoring .gitignore', async () => {
    process.env.MCP_DEPLOYMENT_MODE = 'docker';
    const s = new McpServer({ name: 's', version: '0' });
    registerRemediationTools(s);
    const tool = (s as unknown as { _registeredTools: Record<string, { handler: (a: unknown, extra: unknown) => Promise<{ content: Array<{ text: string }> }> }> })._registeredTools.record_remediation_note;
    const res = await tool.handler({ category: 'error', title: 'abc', intent: 'i', whatHappened: 'w' }, {});
    assert.match(res.content[0].text, /remediation\/\S+\.md in the root of the project you are working in/);
    assert.match(res.content[0].text, /remediation\/\.gitignore containing a single line "\*"/);
    assert.deepEqual(readdirSync(dir), []);
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

  it('local: appends to remediation/<session>.md with front matter once, redacted', () => {
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

  it('local: a note saved after the notes file was moved away gets its own front matter', () => {
    const first = saveNote(note);
    rmSync(first.written!); // archived by an intake while the server kept running
    const second = saveNote({ ...note, category: 'better-path', title: 'After the archive' });
    assert.equal(second.written, first.written);
    const text = readFileSync(second.written!, 'utf8');
    assert.equal((text.match(/^---$/gm) ?? []).length, 2, 'one front-matter block in the new file');
    assert.match(text, /mcpVersion: 9\.9\.9/);
    assert.match(text, /## \[better-path\] After the archive/);
    assert.doesNotMatch(text, /install_application 400 while reserved/);
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

describe('set_debug_mode — on or off until the server restarts', () => {
  type Tool = { handler: (a: unknown, extra: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }> };
  const tools = () => {
    const s = new McpServer({ name: 's', version: '0' });
    registerRemediationTools(s);
    return (s as unknown as { _registeredTools: Record<string, Tool> })._registeredTools;
  };

  it('overrides MCP_DEBUG_MODE in both directions; choosing the configured value clears the override', () => {
    process.env.MCP_DEBUG_MODE = 'false';
    assert.equal(isDebugMode(), false);
    assert.deepEqual(setDebugMode(true), { changed: true });
    assert.equal(isDebugMode(), true);
    assert.equal(configuredDebugMode(), false, 'the configuration itself is untouched');
    assert.equal(debugModeOverridden(), true);
    assert.deepEqual(setDebugMode(true), { changed: false });
    assert.deepEqual(setDebugMode(false), { changed: true });
    assert.equal(debugModeOverridden(), false);

    process.env.MCP_DEBUG_MODE = 'true';
    setDebugMode(false);
    assert.equal(isDebugMode(), false, 'off wins over MCP_DEBUG_MODE=true for this run');
    resetDebugModeForTests(); // = a restart
    assert.equal(isDebugMode(), true, 'after a restart the configuration applies again');
  });

  it('tells listeners only about real changes', () => {
    process.env.MCP_DEBUG_MODE = 'false';
    const heard: boolean[] = [];
    onDebugModeChange((on) => heard.push(on));
    setDebugMode(false);
    setDebugMode(true);
    setDebugMode(true);
    setDebugMode(false);
    assert.deepEqual(heard, [true, false]);
  });

  it('off: tools run unwrapped — no event, no nudge — and the event log resumes when turned back on', async () => {
    process.env.MCP_DEBUG_MODE = 'true';
    setDebugMode(false);
    const wrapped = instrumentHandler('install_application', async () => err());
    const r = (await wrapped({ appId: 1 })) as { content: Array<{ text: string }> };
    assert.equal(r.content[0].text, 'Error: boom', 'no nudge while off');
    assert.equal(getRecordedEvents().length, 0);
    setDebugMode(true);
    await wrapped({ appId: 1 });
    assert.equal(getRecordedEvents().length, 1);
  });

  it('turning it on returns the rules (the server instructions cannot change after connect)', async () => {
    process.env.MCP_DEBUG_MODE = 'false';
    const t = tools();
    const on = await t.set_debug_mode.handler({ enabled: true }, {});
    assert.match(on.content[0].text, /^Debug mode is now ON for this run of the MCP server\. MCP_DEBUG_MODE in the client configuration is off; it applies again when the MCP server restarts\./);
    assert.match(on.content[0].text, /DEBUG MODE IS ON \(turned on with set_debug_mode until the server restarts\)/);
    for (const c of REMEDIATION_CATEGORIES) assert.match(on.content[0].text, new RegExp(`\\b${c}\\b`));
    assert.equal(isDebugMode(), true);
    assert.match(debugStatusLine(), /ON — .*Set with set_debug_mode for this run; MCP_DEBUG_MODE applies again after a restart\./);

    const again = await t.set_debug_mode.handler({ enabled: true }, {});
    assert.match(again.content[0].text, /^Debug mode is already ON\. Nothing changed\./);
  });

  it('turning it off tells the agent to ignore the DEBUG MODE instructions, and notes are refused', async () => {
    process.env.MCP_DEBUG_MODE = 'true';
    const t = tools();
    const off = await t.set_debug_mode.handler({ enabled: false }, {});
    assert.match(off.content[0].text, /^Debug mode is now OFF for this run of the MCP server\. MCP_DEBUG_MODE in the client configuration is on;/);
    assert.match(off.content[0].text, /ignore any DEBUG MODE block in the server instructions/);
    assert.match(debugStatusLine(), /^Debug mode:\s+OFF for this run — do not record remediation notes\./);

    const note = await t.record_remediation_note.handler({ category: 'error', title: 'abc', intent: 'i', whatHappened: 'w' }, {});
    assert.match(note.content[0].text, /^Debug mode is off, so the note was not recorded/);
    assert.notEqual(note.isError, true);
    assert.deepEqual(readdirSync(dir), [], 'nothing written');
  });

  it('a session started by set_debug_mode says so in its files', () => {
    process.env.MCP_DEBUG_MODE = 'false';
    setDebugMode(true);
    startRemediationSession({ mcpVersion: '9.9.9', toolsets: 'all', client: () => undefined });
    const r = saveNote({ category: 'improvement', title: 'x', intent: 'y', whatHappened: 'z' });
    assert.match(readFileSync(r.written!, 'utf8'), /^enabledBy: set_debug_mode$/m);
    const events = readFileSync(join(dir, `${getRemediationSession()!.id}.events.jsonl`), 'utf8');
    assert.match(events, /"enabledBy":"set_debug_mode"/);
  });
});

// The production wiring (index.ts): the real entry point over stdio, as an AI client starts it.
describe('set_debug_mode over stdio', () => {
  // Claude Desktop does not reload the tool list mid-run, so the tool list must be the same before and after the switch.
  it('keeps the tool list unchanged, records notes only while on, and starts the session on the first switch', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'dai-debug-toggle-'));
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(DIGITAL_AI_|DAI_PROFILE_|MCP_)/.test(k)) env[k] = v;
    // Unreachable host: nothing here calls the platform.
    Object.assign(env, {
      DIGITAL_AI_BASE_URL: 'http://127.0.0.1:9', DIGITAL_AI_ACCESS_KEY: 'aut_1_debugToggleTestKey', MCP_CREDENTIAL_STORE: 'off',
      MCP_UPDATE_CHECK: 'false', MCP_DEBUG_MODE: 'false', MCP_DEPLOYMENT_MODE: 'local', MCP_REMEDIATION_DIR: cwd,
    });
    const entry = join(__dirname, '..', 'src', 'index.ts');
    const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', import.meta.resolve('tsx'), entry], env, cwd, stderr: 'pipe' });
    const client = new Client({ name: 'debug-toggle-test', version: '1.0.0' });
    let listChanged = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => { listChanged++; });
    const note = (title: string) => client.callTool({ name: 'record_remediation_note', arguments: { category: 'improvement', title, intent: 'i', whatHappened: 'w' } });
    await client.connect(transport);
    const names = async () => (await client.listTools()).tools.map((t) => t.name);
    const text = (r: unknown) => (r as { content: Array<{ text?: string }> }).content.map((c) => c.text ?? '').join('\n');
    try {
      assert.doesNotMatch(client.getInstructions() ?? '', /DEBUG MODE IS ON/);
      const before = await names();
      assert.ok(before.includes('set_debug_mode') && before.includes('record_remediation_note'), 'both listed while off');
      assert.match(text(await note('while off')), /^Debug mode is off, so the note was not recorded/);
      assert.deepEqual(readdirSync(cwd), [], 'nothing written while off');

      const on = await client.callTool({ name: 'set_debug_mode', arguments: { enabled: true } });
      assert.match(text(on), /^Debug mode is now ON/);
      assert.deepEqual(await names(), before, 'same tool list');

      assert.match(text(await note('toggle test')), /Remediation note saved to /);
      const files = readdirSync(join(cwd)).filter((f) => f.endsWith('.md'));
      assert.equal(files.length, 1);
      assert.match(readFileSync(join(cwd, files[0]), 'utf8'), /^enabledBy: set_debug_mode$/m);
      assert.ok(readdirSync(cwd).some((f) => f.endsWith('.events.jsonl')), 'event log started');

      const off = await client.callTool({ name: 'set_debug_mode', arguments: { enabled: false } });
      assert.match(text(off), /^Debug mode is now OFF/);
      assert.match(text(await note('off again')), /^Debug mode is off, so the note was not recorded/);
      assert.deepEqual(await names(), before, 'same tool list');
      assert.equal(listChanged, 0, 'no tools/list_changed — nothing for the client to reload');
    } finally {
      await client.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 60_000);
});
