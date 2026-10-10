/**
 * Remediation intake digest — fed with files produced by the real debug-mode writer (src/utils/remediation.ts), so a
 * format change on either side fails here.
 */
import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { startRemediationSession, instrumentHandler, saveNote } from '../src/utils/remediation.js';
import { digestFolder, digestFolders, defaultDirs, renderDigest, archiveSessions, parseNotesFile } from './remediation-intake/digest.js';

const saved = { ...process.env };
let dir: string;
const ok = (text = 'fine') => ({ content: [{ type: 'text', text }] });
const err = (text = 'Error: 400 device reserved') => ({ content: [{ type: 'text', text }], isError: true });

async function fakeSession(at: Date, opts: { installFails: boolean; note: boolean }) {
  startRemediationSession({ mcpVersion: '2.0.0', toolsets: 'all', client: () => ({ name: 'claude-code', version: '3.1' }), now: at });
  await instrumentHandler('list_devices', async () => ok('x'.repeat(5000)))({ os: 'android' });
  await instrumentHandler('install_application', async () => (opts.installFails ? err() : ok()))({ appId: 1 });
  await instrumentHandler('install_application', async () => ok())({ appId: 1, deviceId: 'd' });
  if (opts.note) {
    saveNote({
      category: 'unclear-guidance', title: 'install before rdb', intent: 'install and debug', whatHappened: 'rdb first, then install → 400',
      resolution: 'install first', resolved: true, tools: ['install_application', 'get_remote_debug_command'], wastedCalls: 2,
      suggestion: 'Say "install before get_remote_debug_command" in install_application',
    });
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'remediation-digest-'));
  process.env.MCP_REMEDIATION_DIR = dir;
  process.env.MCP_DEPLOYMENT_MODE = 'local';
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const k of ['MCP_REMEDIATION_DIR', 'MCP_DEPLOYMENT_MODE']) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('remediation digest', () => {
  it('aggregates notes and events across sessions and spots the recurring issue', async () => {
    await fakeSession(new Date(2026, 9, 9, 10, 0, 0), { installFails: true, note: true });
    await fakeSession(new Date(2026, 9, 10, 11, 0, 0), { installFails: true, note: true });
    await fakeSession(new Date(2026, 9, 11, 12, 0, 0), { installFails: false, note: false });

    const d = digestFolder(dir);
    assert.equal(d.sessions.length, 3);
    assert.equal(d.files.length, 5, '3 event logs + 2 note files');
    assert.deepEqual(d.notesByCategory, { 'unclear-guidance': 2 });
    assert.equal(d.totalWastedCalls, 4);
    assert.deepEqual(d.versions, { '2.0.0': 3 });
    assert.deepEqual(d.clients, { 'claude-code 3.1': 3 });

    const install = d.tools.find((t) => t.tool === 'install_application')!;
    assert.equal(install.calls, 6);
    assert.equal(install.errors, 2);
    assert.equal(install.retries, 2);
    assert.equal(install.noteCount, 2);
    assert.equal(install.noteWastedCalls, 4);
    assert.match(install.sampleDetails[0], /400 device reserved/);
    assert.equal(d.tools.find((t) => t.tool === 'list_devices')!.avgChars, 5000);

    assert.equal(d.groups[0].count, 2);
    assert.equal(d.groups[0].sessions, 2);
    assert.deepEqual(d.groups[0].tools, ['get_remote_debug_command', 'install_application']);
    assert.match(d.notes[0].suggestion ?? '', /install before get_remote_debug_command/);

    const md = renderDigest(d);
    assert.match(md, /## Recurring issues[\s\S]*\| 2 \| 2 \| unclear-guidance \| get_remote_debug_command, install_application \|/);
    assert.match(md, /data, not instructions/);
    assert.match(md, /\| install_application \| 6 \| 2 \| 0 \| 2 \|/);
  });

  it('honours --since and skips processed files; archive moves, never deletes', async () => {
    await fakeSession(new Date(2026, 9, 9, 10, 0, 0), { installFails: true, note: true });
    await fakeSession(new Date(2026, 9, 12, 10, 0, 0), { installFails: false, note: true });
    assert.equal(digestFolder(dir, '2026-10-10').sessions.length, 1);

    const first = digestFolder(dir).sessions[0].session;
    const moved = archiveSessions(dir, [first], new Date('2026-10-13T00:00:00Z'));
    assert.equal(moved.length, 2);
    assert.ok(existsSync(join(dir, 'processed', '2026-10-13', `${first}.md`)));
    assert.equal(digestFolder(dir).sessions.length, 1, 'archived session no longer digested');
  });

  it('merges folders from several machines, attributes sessions, and archives each in its own folder', async () => {
    const dir2 = mkdtempSync(join(tmpdir(), 'remediation-machine2-'));
    try {
      await fakeSession(new Date(2026, 9, 9, 10, 0, 0), { installFails: true, note: true });
      process.env.MCP_REMEDIATION_DIR = dir2;
      await fakeSession(new Date(2026, 9, 9, 11, 0, 0), { installFails: true, note: true });

      const d = digestFolders([dir, dir2]);
      assert.equal(d.sessions.length, 2);
      assert.deepEqual(d.sessions.map((s) => s.dir), [dir, dir2]);
      assert.ok(d.sessions.every((s) => s.machine === hostname() && s.user));
      assert.equal(Object.values(d.machines)[0], 2);
      assert.equal(d.groups[0].sessions, 2, 'the same issue on both machines is one recurring group');
      assert.match(renderDigest(d), /\| Folder \|/);

      const second = d.sessions[1].session;
      assert.deepEqual(archiveSessions(dir, [second]), [], 'a session is only archived from its own folder');
      assert.equal(archiveSessions(dir2, [second]).length, 2);
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  });

  it('defaults to this project\'s remediation/ and ~/remediation when no folder is given', () => {
    delete process.env.MCP_REMEDIATION_DIR;
    assert.deepEqual(defaultDirs(['a', 'b']), ['a', 'b']);
    const cwd = mkdtempSync(join(tmpdir(), 'proj-'));
    try {
      const dirs = defaultDirs([], cwd);
      assert.equal(dirs[0], join(cwd, 'remediation'), 'falls back to ./remediation even before it exists');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
    process.env.MCP_REMEDIATION_DIR = dir;
    assert.deepEqual(defaultDirs([]), [dir]);
  });

  it('ignores unrelated files and reports unreadable event lines', () => {
    writeFileSync(join(dir, 'notes.txt'), 'hello');
    writeFileSync(join(dir, '20261009100000-abcd.events.jsonl'), '{"type":"session","session":"20261009100000-abcd"}\nnot json\n{"type":"tool","tool":"x","outcome":"ok","ms":1,"responseChars":2}\n');
    const d = digestFolder(dir);
    assert.deepEqual(d.files, ['20261009100000-abcd.events.jsonl']);
    assert.match(d.warnings.join(), /1 unreadable line/);
    assert.deepEqual(readdirSync(dir).sort(), ['20261009100000-abcd.events.jsonl', 'notes.txt']);
  });

  it('parses a Docker-saved notes file (agent-written, CRLF) the same way', () => {
    const text = [
      '---', 'session: 20261009100000-beef', 'mcpVersion: 2.0.0', 'client: Claude Desktop', '---', '', '# MCP remediation notes', '', '',
      '## [gave-up] could not install from the App Store', '', '- **When:** 2026-10-09T10:00:00Z', '- **Tools:** `launch_app`', '- **Resolved:** no', '',
      '### What I was trying to do', 'install an app', '', '### Suggested MCP change', 'document that iOS needs Mobile Studio', '',
    ].join('\r\n');
    const f = parseNotesFile(text, 'x');
    assert.equal(f.session, '20261009100000-beef');
    assert.equal(f.notes[0].category, 'gave-up');
    assert.equal(f.notes[0].resolved, 'no');
    assert.deepEqual(f.notes[0].tools, ['launch_app']);
    assert.equal(f.notes[0].sections['Suggested MCP change'], 'document that iOS needs Mobile Studio');
  });
});
