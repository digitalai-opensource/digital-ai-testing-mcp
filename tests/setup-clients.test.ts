/**
 * `setup clients` (src/cli/clients.ts + src/cli/setup.ts): the launch entry, client detection, and editing each
 * client's configuration file. Files live in a temp "home"; nothing reads or writes the real one.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildLaunchEntry,
  claudeCodeCommand,
  clientStatus,
  codexBlock,
  entryProfiles,
  packageSpec,
  knownClients,
  removeClientEntry,
  setupCommand,
  writeClientEntry,
  type ClientContext,
  type ClientTarget,
} from '../src/cli/clients.js';
import { runSetupCli, type SetupIO } from '../src/cli/setup.js';

// ─── The launch entry (pure strings: any platform) ────────────────────────────

const fakeCtx = (platform: NodeJS.Platform, execPath: string, present: string[], env: NodeJS.ProcessEnv = {}): ClientContext => ({
  platform,
  env,
  home: platform === 'win32' ? 'C:\\Users\\u' : '/Users/u',
  execPath,
  exists: (p) => present.includes(p),
});

describe('buildLaunchEntry', () => {
  it('Windows, official installer: absolute node + npm\'s npx-cli.js, its own PATH, no key', () => {
    const e = buildLaunchEntry(
      fakeCtx('win32', 'C:\\Program Files\\nodejs\\node.exe', ['C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js'], { SystemRoot: 'C:\\WINDOWS' })
    );
    expect(e).toEqual({
      command: 'C:\\Program Files\\nodejs\\node.exe',
      args: ['C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js', '-y', 'digital-ai-testing-mcp@latest'],
      env: { PATH: 'C:\\Program Files\\nodejs;C:\\WINDOWS\\System32', MCP_DEPLOYMENT_MODE: 'local' },
      notes: [],
    });
  });

  it('fnm: swaps the versioned folder for the stable aliases\\default one when it exists', () => {
    const fnm = 'C:\\Users\\u\\AppData\\Roaming\\fnm';
    const alias = `${fnm}\\aliases\\default`;
    const e = buildLaunchEntry(
      fakeCtx('win32', `${fnm}\\node-versions\\v22.22.3\\installation\\node.exe`, [`${alias}\\node.exe`, `${alias}\\node_modules\\npm\\bin\\npx-cli.js`])
    );
    expect(e.command).toBe(`${alias}\\node.exe`);
    expect(e.env.PATH.startsWith(`${alias};`)).toBe(true);
    expect(e.notes).toEqual([]);
    const noAlias = buildLaunchEntry(
      fakeCtx('win32', `${fnm}\\node-versions\\v22.22.3\\installation\\node.exe`, [`${fnm}\\node-versions\\v22.22.3\\installation\\node_modules\\npm\\bin\\npx-cli.js`])
    );
    expect(noAlias.command).toContain('v22.22.3');
    expect(noAlias.notes[0]).toMatch(/version-specific path/);
  });

  it('fnm per-terminal link (npx from an fnm shell): never written — swapped for the stable alias', () => {
    const fnm = 'C:\\Users\\u\\AppData\\Roaming\\fnm';
    const alias = `${fnm}\\aliases\\default`;
    const link = 'C:\\Users\\u\\AppData\\Local\\fnm_multishells\\38400_1794907852984';
    const present = [`${alias}\\node.exe`, `${alias}\\node_modules\\npm\\bin\\npx-cli.js`];

    // Default location (live layout 2026-11-18), with and without FNM_DIR
    for (const env of [{}, { FNM_DIR: fnm }]) {
      const e = buildLaunchEntry(fakeCtx('win32', `${link}\\node.exe`, present, env));
      expect(e.command).toBe(`${alias}\\node.exe`);
      expect(JSON.stringify(e)).not.toContain('fnm_multishells');
      expect(e.notes).toEqual([]);
    }
    // FNM_DIR elsewhere wins over the default folder
    const custom = 'D:\\tools\\fnm';
    const c = buildLaunchEntry(fakeCtx('win32', `${link}\\node.exe`, [`${custom}\\aliases\\default\\node.exe`, `${custom}\\aliases\\default\\node_modules\\npm\\bin\\npx-cli.js`], { FNM_DIR: custom }));
    expect(c.command).toBe(`${custom}\\aliases\\default\\node.exe`);

    // No alias anywhere: the link's real target is used (version-specific)
    const real = `${fnm}\\node-versions\\v22.22.3\\installation`;
    const r = buildLaunchEntry({ ...fakeCtx('win32', `${link}\\node.exe`, [`${real}\\node_modules\\npm\\bin\\npx-cli.js`]), realPath: () => real });
    expect(r.command).toBe(`${real}\\node.exe`);
    expect(r.notes[0]).toMatch(/version-specific path/);

    // Nothing resolvable: says so plainly
    const none = buildLaunchEntry(fakeCtx('darwin', '/Users/u/.local/state/fnm_multishells/123_456/bin/node', []));
    expect(none.notes.some((n) => /per-terminal link/.test(n) && /fnm default/.test(n))).toBe(true);
    const mac = buildLaunchEntry(
      fakeCtx('darwin', '/Users/u/.local/state/fnm_multishells/123_456/bin/node', ['/Users/u/.local/share/fnm/aliases/default/bin/node', '/Users/u/.local/share/fnm/aliases/default/lib/node_modules/npm/bin/npx-cli.js'])
    );
    expect(mac.command).toBe('/Users/u/.local/share/fnm/aliases/default/bin/node');
  });

  it('setupCommand names the install that is running (a bare command can start an old global copy)', () => {
    expect(setupCommand('npx', '2.4.0-beta.4')).toBe('npx -y digital-ai-testing-mcp@next setup');
    expect(setupCommand('npx', '2.4.0')).toBe('npx -y digital-ai-testing-mcp@latest setup');
    expect(setupCommand('npm', '2.4.0')).toBe('digital-ai-testing-mcp setup');
    expect(setupCommand('source', '2.4.0')).toBe('node dist/index.js setup');
  });

  it('macOS Homebrew: npx-cli.js under ../lib, POSIX PATH', () => {
    const e = buildLaunchEntry(fakeCtx('darwin', '/opt/homebrew/bin/node', ['/opt/homebrew/lib/node_modules/npm/bin/npx-cli.js']));
    expect(e.command).toBe('/opt/homebrew/bin/node');
    expect(e.args[0]).toBe('/opt/homebrew/lib/node_modules/npm/bin/npx-cli.js');
    expect(e.env.PATH).toBe('/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin');
  });

  it('a beta setup writes the beta channel (@next); a release writes @latest', () => {
    expect(packageSpec('2.4.0-beta.1')).toBe('digital-ai-testing-mcp@next');
    expect(packageSpec('2.4.0')).toBe('digital-ai-testing-mcp@latest');
    expect(packageSpec(undefined)).toBe('digital-ai-testing-mcp@latest');
    const present = ['/opt/homebrew/lib/node_modules/npm/bin/npx-cli.js'];
    const beta = buildLaunchEntry({ ...fakeCtx('darwin', '/opt/homebrew/bin/node', present), version: '2.4.0-beta.1' });
    expect(beta.args).toEqual([present[0], '-y', 'digital-ai-testing-mcp@next']);
    expect(beta.notes[0]).toMatch(/^This is a beta \(2\.4\.0-beta\.1\)/);
    const fallback = buildLaunchEntry({ ...fakeCtx('linux', '/odd/node', []), version: '2.4.0-rc.1' });
    expect(fallback.args).toEqual(['-y', 'digital-ai-testing-mcp@next']);
  });

  it('nvm: versioned path with a note; npx-cli.js missing: plain npx from the client PATH', () => {
    const nvm = buildLaunchEntry(fakeCtx('darwin', '/Users/u/.nvm/versions/node/v22.1.0/bin/node', ['/Users/u/.nvm/versions/node/v22.1.0/lib/node_modules/npm/bin/npx-cli.js']));
    expect(nvm.notes[0]).toMatch(/version-specific path/);
    expect(buildLaunchEntry(fakeCtx('win32', 'D:\\odd\\node.exe', []))).toMatchObject({ command: 'cmd', args: ['/c', 'npx', '-y', 'digital-ai-testing-mcp@latest'] });
    expect(buildLaunchEntry(fakeCtx('linux', '/odd/node', []))).toMatchObject({ command: 'npx', args: ['-y', 'digital-ai-testing-mcp@latest'] });
  });

  it('on Windows the Claude Code command uses forward slashes (Claude Code strips backslashes when it saves)', () => {
    const e = buildLaunchEntry(
      fakeCtx('win32', 'C:\\Program Files\\nodejs\\node.exe', ['C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js'], { SystemRoot: 'C:\\WINDOWS' })
    );
    const cmd = claudeCodeCommand(e, 'win32');
    expect(cmd).not.toContain('\\');
    expect(cmd).toBe(
      'claude mcp add --scope user -e "PATH=C:/Program Files/nodejs;C:/WINDOWS/System32" -e "MCP_DEPLOYMENT_MODE=local" digital-ai-testing -- ' +
        '"C:/Program Files/nodejs/node.exe" "C:/Program Files/nodejs/node_modules/npm/bin/npx-cli.js" "-y" "digital-ai-testing-mcp@latest"'
    );
  });

  it('the Claude Code command carries the same entry, quoted for the shell', () => {
    const e = buildLaunchEntry(fakeCtx('darwin', '/opt/homebrew/bin/node', ['/opt/homebrew/lib/node_modules/npm/bin/npx-cli.js']));
    expect(claudeCodeCommand(e, 'darwin')).toBe(
      "claude mcp add --scope user -e 'PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin' -e 'MCP_DEPLOYMENT_MODE=local' digital-ai-testing -- " +
        "'/opt/homebrew/bin/node' '/opt/homebrew/lib/node_modules/npm/bin/npx-cli.js' '-y' 'digital-ai-testing-mcp@latest'"
    );
  });
});

// ─── Detection and file editing (real temp files, host platform) ──────────────

let home: string;
let ctx: ClientContext;
const target = (id: string): ClientTarget => knownClients(ctx).find((t) => t.id === id)!;
const json = (p: string) => JSON.parse(readFileSync(p, 'utf8'));

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dai-clients-'));
  ctx = {
    platform: process.platform,
    env: { APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local'), XDG_CONFIG_HOME: join(home, '.config') },
    home,
    execPath: process.execPath,
    exists: existsSync,
  };
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const entry = () => buildLaunchEntry(ctx);

describe('Claude Desktop on Windows (faked file system, any OS)', () => {
  const L = 'C:\\Users\\u\\AppData\\Local';
  const R = 'C:\\Users\\u\\AppData\\Roaming';
  const data = `${L}\\Claude-Data\\claude_pzs8sxrjxfjjc`;
  const store = `${L}\\Packages\\Claude_pzs8sxrjxfjjc\\LocalCache\\Roaming\\Claude`;
  const desktopFile = (present: string[]) =>
    knownClients({
      ...fakeCtx('win32', 'C:\\n\\node.exe', present, { LOCALAPPDATA: L, APPDATA: R }),
      listDir: (p) => (p === `${L}\\Claude-Data` ? ['claude_pzs8sxrjxfjjc', 'README.txt'] : p === `${L}\\Packages` ? ['Claude_pzs8sxrjxfjjc', 'Other_x'] : []),
    }).find((t) => t.id === 'claude-desktop')!;

  it('uses Claude-Data\\claude_<id> (current versions), where the config file is', () => {
    const t = desktopFile([data, `${data}\\claude_desktop_config.json`, store, `${R}\\Claude`]);
    expect(t.file).toBe(`${data}\\claude_desktop_config.json`);
    expect(t.detected).toBe(true);
  });
  it('exactly one config file decides, whichever layout it is in (the old %APPDATA% one too)', () => {
    const t = desktopFile([store, `${R}\\Claude`, `${R}\\Claude\\claude_desktop_config.json`]);
    expect(t.file).toBe(`${R}\\Claude\\claude_desktop_config.json`);
    expect(t.choices).toBeUndefined();
  });

  it('several config files, or none yet: no guess — the candidates are listed for --config', () => {
    const two = desktopFile([data, `${data}\\claude_desktop_config.json`, `${R}\\Claude`, `${R}\\Claude\\claude_desktop_config.json`]);
    expect(two.choices).toEqual([`${data}\\claude_desktop_config.json`, `${R}\\Claude\\claude_desktop_config.json`]);
    const none = desktopFile([data, store]);
    expect(none).toMatchObject({ detected: true, choices: [`${data}\\claude_desktop_config.json`, `${store}\\claude_desktop_config.json`] });
    expect(desktopFile([]).detected).toBe(false);
  });

  it('also looks in the Anthropic.Claude_<id>\\LocalCache\\Local\\Claude variant', () => {
    const variant = `${L}\\Packages\\Anthropic.Claude_abc\\LocalCache\\Local\\Claude`;
    const t = knownClients({
      ...fakeCtx('win32', 'C:\\n\\node.exe', [variant, `${variant}\\claude_desktop_config.json`], { LOCALAPPDATA: L, APPDATA: R }),
      listDir: (p) => (p === `${L}\\Packages` ? ['Anthropic.Claude_abc'] : []),
    }).find((c) => c.id === 'claude-desktop')!;
    expect(t.file).toBe(`${variant}\\claude_desktop_config.json`);
  });
});

describe('client detection', () => {
  it('a client counts as installed when its own folder exists, whether or not the file does', () => {
    expect(knownClients(ctx).filter((t) => t.detected)).toEqual([]);
    mkdirSync(join(home, '.cursor'));
    mkdirSync(join(home, '.codex'));
    expect(knownClients(ctx).filter((t) => t.detected).map((t) => t.id)).toEqual(['cursor', 'codex']);
    expect(target('cursor').file).toBe(join(home, '.cursor', 'mcp.json'));
  });
});

describe('JSON clients', () => {
  it('adds the entry, keeps every other server and setting, backs up the old file', () => {
    mkdirSync(join(home, '.cursor'));
    const file = join(home, '.cursor', 'mcp.json');
    writeFileSync(file, JSON.stringify({ theme: 'dark', mcpServers: { other: { command: 'x' } } }));
    const r = writeClientEntry(target('cursor'), entry());
    expect(r).toEqual({ ok: true, backup: `${file}.digital-ai-testing.bak` });
    const after = json(file);
    expect(after.theme).toBe('dark');
    expect(after.mcpServers.other).toEqual({ command: 'x' });
    expect(after.mcpServers['digital-ai-testing']).toEqual({ command: entry().command, args: entry().args, env: entry().env });
    expect(JSON.stringify(after)).not.toMatch(/ACCESS_KEY/);
    expect(json(r.backup!)).toEqual({ theme: 'dark', mcpServers: { other: { command: 'x' } } });
    expect(clientStatus(target('cursor'), entry())).toMatchObject({ hasEntry: true, upToDate: true, entryHasKeys: false });
  });

  it('creates the file when missing; reports an entry that carries its own key; finds the server under another name', () => {
    mkdirSync(join(home, '.gemini'));
    expect(writeClientEntry(target('gemini-cli'), entry())).toEqual({ ok: true, backup: undefined });
    const file = target('gemini-cli').file;
    const d = json(file);
    d.mcpServers['digital-ai-testing'].env.DIGITAL_AI_ACCESS_KEY = 'aut_1_x';
    d.mcpServers.legacy = { command: 'npx', args: ['-y', 'digital-ai-testing-mcp@latest'] };
    writeFileSync(file, JSON.stringify(d));
    expect(clientStatus(target('gemini-cli'), entry())).toMatchObject({ hasEntry: true, entryHasKeys: true, upToDate: false, otherNames: ['legacy'] });
  });

  it('VS Code uses "servers" with type stdio; a file with comments is never rewritten', () => {
    const userDir = target('vscode').file.replace(/[\\/]mcp\.json$/, '');
    mkdirSync(userDir, { recursive: true });
    expect(writeClientEntry(target('vscode'), entry()).ok).toBe(true);
    expect(json(target('vscode').file).servers['digital-ai-testing']).toMatchObject({ type: 'stdio', command: entry().command });

    const commented = '{\n  // my servers\n  "servers": {}\n}\n';
    writeFileSync(target('vscode').file, commented);
    expect(clientStatus(target('vscode'), entry()).unreadable).toMatch(/comments/);
    expect(writeClientEntry(target('vscode'), entry()).ok).toBe(false);
    expect(readFileSync(target('vscode').file, 'utf8')).toBe(commented);
  });

  it('OpenCode uses "mcp" with a command array and "environment"', () => {
    mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
    writeClientEntry(target('opencode'), entry());
    expect(json(target('opencode').file).mcp['digital-ai-testing']).toEqual({
      type: 'local',
      command: [entry().command, ...entry().args],
      environment: entry().env,
      enabled: true,
    });
  });

  it('remove takes out only our entry', () => {
    mkdirSync(join(home, '.cursor'));
    writeFileSync(target('cursor').file, JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
    writeClientEntry(target('cursor'), entry());
    expect(removeClientEntry(target('cursor'))).toMatchObject({ ok: true, removed: true });
    expect(json(target('cursor').file)).toEqual({ mcpServers: { other: { command: 'x' } } });
    expect(removeClientEntry(target('cursor'))).toMatchObject({ ok: true, removed: false });
  });
});

describe('Codex (TOML)', () => {
  const existing = 'model = "o4"\n\n[mcp_servers.other]\ncommand = "x"\n\n[profiles.fast]\nmodel = "mini"\n';

  it('appends our tables, updates them in place, and removes only them', () => {
    mkdirSync(join(home, '.codex'));
    const file = target('codex').file;
    writeFileSync(file, existing);
    writeClientEntry(target('codex'), entry());
    const once = readFileSync(file, 'utf8');
    expect(once.startsWith(existing.trimEnd())).toBe(true);
    expect(once).toContain(codexBlock(entry()));
    expect(clientStatus(target('codex'), entry())).toMatchObject({ hasEntry: true, upToDate: true });

    writeClientEntry(target('codex'), entry()); // a second run changes nothing
    expect(readFileSync(file, 'utf8')).toBe(once);

    expect(removeClientEntry(target('codex'))).toMatchObject({ ok: true, removed: true });
    expect(readFileSync(file, 'utf8')).toBe(existing);
  });

  it('entryProfiles reads the profiles of our env table (not another table\'s)', () => {
    mkdirSync(join(home, '.codex'));
    writeFileSync(
      target('codex').file,
      '[mcp_servers.digital-ai-testing]\ncommand = "npx"\n\n[mcp_servers.digital-ai-testing.env]\n' +
        'DIGITAL_AI_BASE_URL = "https://a.example.com/"\nDIGITAL_AI_ACCESS_KEY = \'aut_1_x\'\nDAI_PROFILE_QA_URL = "https://b.example.com"\nDAI_PROFILE_QA_KEY = "k2"\n\n' +
        '[mcp_servers.old.env]\nDAI_PROFILE_OTHER_KEY = "k3"\n'
    );
    expect(entryProfiles(target('codex'))).toEqual([
      { name: 'default', url: 'https://a.example.com', key: 'aut_1_x' },
      { name: 'qa', url: 'https://b.example.com', key: 'k2' },
    ]);
  });

  it('reports a key in our env table and another table that runs the package', () => {
    mkdirSync(join(home, '.codex'));
    writeFileSync(
      target('codex').file,
      '[mcp_servers.digital-ai-testing]\ncommand = "npx"\n\n[mcp_servers.digital-ai-testing.env]\nDIGITAL_AI_ACCESS_KEY = "aut_1_x"\n\n' +
        '[mcp_servers.old]\ncommand = "npx"\nargs = ["-y", "digital-ai-testing-mcp"]\n'
    );
    expect(clientStatus(target('codex'), entry())).toMatchObject({ hasEntry: true, entryHasKeys: true, upToDate: false, otherNames: ['old'] });
  });
});

// ─── The commands ─────────────────────────────────────────────────────────────

function io(answers: string[] = [], interactive = false) {
  const out: string[] = [];
  const err: string[] = [];
  const q = [...answers];
  const s: SetupIO = {
    out: (t) => void out.push(t),
    err: (t) => void err.push(t),
    ask: async (question) => {
      if (!q.length) throw new Error(`unexpected question: ${question}`);
      return q.shift()!;
    },
    askSecret: async () => '',
    readStdin: async () => '',
    interactive,
    verify: async () => ({ ok: false, problem: 'unreachable' }),
    clients: ctx,
  };
  return { s, out, err, all: () => [...out, ...err].join('\n') };
}

describe('setup clients commands', () => {
  it('list shows each client\'s state, the hand-set-up clients and the Claude Code command', async () => {
    mkdirSync(join(home, '.cursor'));
    const t = io();
    expect(await runSetupCli(['clients'], t.s)).toBe(0);
    expect(t.all()).toMatch(/cursor\s+Cursor: installed, not set up/);
    expect(t.all()).toMatch(/windsurf\s+Windsurf: not installed/);
    expect(t.all()).toContain('android-studio-gemini');
    expect(t.all()).toContain('claude mcp add --scope user');
  });

  it('add sets up every installed client; a second run reports them as already set up', async () => {
    mkdirSync(join(home, '.cursor'));
    mkdirSync(join(home, '.codex'));
    const t = io();
    expect(await runSetupCli(['clients', 'add'], t.s)).toBe(0);
    expect(t.all()).toMatch(/Cursor: added/);
    expect(t.all()).toMatch(/OpenAI Codex .*: added/);
    const again = io();
    expect(await runSetupCli(['clients', 'add'], again.s)).toBe(0);
    expect(again.all()).toMatch(/Cursor: already set up/);
  });

  it('an existing entry with its own key needs --yes outside a terminal', async () => {
    mkdirSync(join(home, '.cursor'));
    const file = join(home, '.cursor', 'mcp.json');
    const withKey = { mcpServers: { 'digital-ai-testing': { command: 'npx', env: { DIGITAL_AI_ACCESS_KEY: 'aut_1_x' } } } };
    writeFileSync(file, JSON.stringify(withKey));
    const refused = io();
    expect(await runSetupCli(['clients', 'add', 'cursor'], refused.s)).toBe(1);
    expect(refused.all()).toContain('add --yes to replace its existing entry');
    expect(json(file)).toEqual(withKey);
    expect(await runSetupCli(['clients', 'add', 'cursor', '--yes'], io().s)).toBe(0);
    expect(json(file).mcpServers['digital-ai-testing'].env.DIGITAL_AI_ACCESS_KEY).toBeUndefined();
  });

  it('in a terminal, replacing asks first and says the entry holds its own key', async () => {
    mkdirSync(join(home, '.cursor'));
    writeFileSync(join(home, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { 'digital-ai-testing': { command: 'npx', env: { DIGITAL_AI_ACCESS_KEY: 'k' } } } }));
    const t = io(['n', 'n'], true); // no import, no replace
    expect(await runSetupCli(['clients', 'add', 'cursor'], t.s)).toBe(1);
    expect(t.all()).toMatch(/Cursor: not changed\./);
  });

  it('unknown and hand-set-up clients are usage errors', async () => {
    const unknown = io();
    expect(await runSetupCli(['clients', 'add', 'notepad'], unknown.s)).toBe(2);
    expect(unknown.all()).toContain('Unknown client "notepad"');
    const manual = io();
    expect(await runSetupCli(['clients', 'add', 'claude-code'], manual.s)).toBe(2);
    expect(manual.all()).toContain('claude mcp add');
  });

  it('remove needs confirmation and removes only our entry', async () => {
    mkdirSync(join(home, '.cursor'));
    await runSetupCli(['clients', 'add'], io().s);
    expect(await runSetupCli(['clients', 'remove'], io().s)).toBe(2);
    expect(await runSetupCli(['clients', 'remove', '--yes'], io().s)).toBe(0);
    expect(json(join(home, '.cursor', 'mcp.json'))).toEqual({ mcpServers: {} });
  });

  it('a file setup will not rewrite gets the entry printed to paste, and counts as not changed', async () => {
    mkdirSync(join(home, '.cursor'));
    writeFileSync(join(home, '.cursor', 'mcp.json'), '{ /* mine */ }');
    const t = io();
    expect(await runSetupCli(['clients', 'add', 'cursor'], t.s)).toBe(1);
    expect(t.all()).toContain('"mcpServers"');
    expect(t.all()).toContain('"digital-ai-testing"');
  });

  it('--config names the file for one client; it must be that client\'s file name in an existing folder', async () => {
    mkdirSync(join(home, 'custom'));
    const file = join(home, 'custom', 'mcp.json');
    expect(await runSetupCli(['clients', 'add', 'cursor', '--config', file], io().s)).toBe(0);
    expect(json(file).mcpServers['digital-ai-testing']).toBeDefined();
    const wrongName = io();
    expect(await runSetupCli(['clients', 'add', 'cursor', '--config', join(home, 'custom', 'other.json')], wrongName.s)).toBe(2);
    expect(wrongName.all()).toContain('must point to a file named mcp.json');
    expect(await runSetupCli(['clients', 'add', 'cursor', '--config', join(home, 'missing', 'mcp.json')], io().s)).toBe(2);
    expect(await runSetupCli(['clients', 'add', 'cursor', 'windsurf', '--config', file], io().s)).toBe(2);
  });

  it.runIf(process.platform === 'win32')('Windows: two Claude Desktop config files → nothing written, candidates listed; --config + a yes writes it', async () => {
    const data = join(home, 'AppData', 'Local', 'Claude-Data', 'claude_test');
    const legacy = join(home, 'AppData', 'Roaming', 'Claude');
    mkdirSync(data, { recursive: true });
    mkdirSync(legacy, { recursive: true });
    const original = JSON.stringify({ mcpServers: { mine: { command: 'x' } } });
    writeFileSync(join(data, 'claude_desktop_config.json'), original);
    writeFileSync(join(legacy, 'claude_desktop_config.json'), original);

    const ambiguous = io();
    expect(await runSetupCli(['clients', 'add', 'claude-desktop'], ambiguous.s)).toBe(1);
    expect(ambiguous.all()).toContain('setup cannot tell which one this install reads');
    expect(ambiguous.all()).toContain(join(data, 'claude_desktop_config.json'));
    expect(readFileSync(join(data, 'claude_desktop_config.json'), 'utf8')).toBe(original);
    expect(readFileSync(join(legacy, 'claude_desktop_config.json'), 'utf8')).toBe(original);

    const chosen = join(data, 'claude_desktop_config.json');
    const declined = io(['n'], true);
    expect(await runSetupCli(['clients', 'add', 'claude-desktop', '--config', chosen], declined.s)).toBe(1);
    expect(readFileSync(chosen, 'utf8')).toBe(original);

    const noTerminal = io();
    expect(await runSetupCli(['clients', 'add', 'claude-desktop', '--config', chosen], noTerminal.s)).toBe(1);
    expect(noTerminal.all()).toContain(`add --yes to edit ${chosen}`);

    const accepted = io(['y'], true);
    expect(await runSetupCli(['clients', 'add', 'claude-desktop', '--config', chosen], accepted.s)).toBe(0);
    expect(json(chosen).mcpServers).toHaveProperty('mine');
    expect(json(chosen).mcpServers).toHaveProperty('digital-ai-testing');
    expect(accepted.all()).toContain('To confirm Claude Desktop reads this file');
    expect(readFileSync(join(legacy, 'claude_desktop_config.json'), 'utf8')).toBe(original); // the other file untouched
  });

  it('nothing installed: add says so', async () => {
    const t = io();
    expect(await runSetupCli(['clients', 'add'], t.s)).toBe(1);
    expect(t.all()).toContain('No AI clients were found');
  });
});
