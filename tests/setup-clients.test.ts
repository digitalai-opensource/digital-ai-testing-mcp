/**
 * `setup clients` (src/cli/clients.ts + src/cli/setup.ts): the launch entry, client detection, and editing each
 * client's configuration file. Files live in a temp "home"; nothing reads or writes the real one.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  buildLaunchEntry,
  claudeCodeCommand,
  clientStatus,
  codexBlock,
  entryProfiles,
  findClaudeCli,
  packageSpec,
  knownClients,
  removeClientEntry,
  setupCommand,
  warmStart,
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
    expect(setupCommand('npx', '2.4.0-beta.4', 'darwin')).toBe('npx -y digital-ai-testing-mcp@next setup');
    expect(setupCommand('npx', '2.4.0', 'linux')).toBe('npx -y digital-ai-testing-mcp@latest setup');
    // Windows: npx.cmd — Windows PowerShell 5.1 refuses npm's npx.ps1 under the default execution policy.
    expect(setupCommand('npx', '2.4.0', 'win32')).toBe('npx.cmd -y digital-ai-testing-mcp@latest setup');
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
      'claude mcp add --scope user "--env=npm_config_yes=true" "--env=PATH=C:/Program Files/nodejs;C:/WINDOWS/System32" "--env=MCP_DEPLOYMENT_MODE=local" digital-ai-testing -- ' +
        '"C:/Program Files/nodejs/node.exe" "C:/Program Files/nodejs/node_modules/npm/bin/npx-cli.js" "digital-ai-testing-mcp@latest"'
    );
  });

  it('the Claude Code command carries the same entry, quoted for the shell', () => {
    const e = buildLaunchEntry(fakeCtx('darwin', '/opt/homebrew/bin/node', ['/opt/homebrew/lib/node_modules/npm/bin/npx-cli.js']));
    expect(claudeCodeCommand(e, 'darwin')).toBe(
      "claude mcp add --scope user '--env=npm_config_yes=true' '--env=PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin' '--env=MCP_DEPLOYMENT_MODE=local' digital-ai-testing -- " +
        "'/opt/homebrew/bin/node' '/opt/homebrew/lib/node_modules/npm/bin/npx-cli.js' 'digital-ai-testing-mcp@latest'"
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

  it('replacing an entry keeps that client\'s own options and non-credential variables, drops credentials and PATH', () => {
    const userDir = target('vscode').file.replace(/[\\/]mcp\.json$/, '');
    mkdirSync(userDir, { recursive: true });
    const old = {
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'digital-ai-testing-mcp@latest'],
      envFile: '${workspaceFolder}/.env',
      env: { DIGITAL_AI_BASE_URL: 'https://a', DIGITAL_AI_ACCESS_KEY: 'aut_1_x', DAI_PROFILE_QA_KEY: 'k', MCP_DEBUG_MODE: 'true', MCP_TOOLSETS: 'core', PATH: 'old' },
    };
    writeFileSync(target('vscode').file, JSON.stringify({ servers: { 'digital-ai-testing': old } }));
    expect(clientStatus(target('vscode'), entry()).envFile).toBe('${workspaceFolder}/.env');
    writeClientEntry(target('vscode'), entry());
    const e = json(target('vscode').file).servers['digital-ai-testing'];
    expect(e).toMatchObject({ type: 'stdio', command: entry().command, args: entry().args, envFile: '${workspaceFolder}/.env' });
    expect(e.env).toEqual({ ...entry().env, MCP_DEBUG_MODE: 'true', MCP_TOOLSETS: 'core' });
    expect(clientStatus(target('vscode'), entry())).toMatchObject({ upToDate: true, entryHasKeys: false });
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

  it('replacing keeps the other keys of our table and non-credential variables, multi-line values whole', () => {
    mkdirSync(join(home, '.codex'));
    writeFileSync(
      target('codex').file,
      '[mcp_servers.digital-ai-testing]\ncommand = "npx"\nargs = [\n  "-y",\n  "digital-ai-testing-mcp",\n]\nstartup_timeout_sec = 30\n' +
        'tools = [\n  "a",\n  "b [x]",\n]\n\n[mcp_servers.digital-ai-testing.env]\nDIGITAL_AI_ACCESS_KEY = "aut_1_x"\nMCP_DEBUG_MODE = "true"\nPATH = "old"\n\n[other]\nx = 1\n'
    );
    expect(writeClientEntry(target('codex'), entry()).ok).toBe(true);
    const text = readFileSync(target('codex').file, 'utf8');
    expect(text).toContain('startup_timeout_sec = 30');
    expect(text).toContain('tools = [\n  "a",\n  "b [x]",\n]');
    expect(text).toContain('MCP_DEBUG_MODE = "true"');
    expect(text).not.toContain('aut_1_x');
    expect(text).not.toContain('PATH = "old"');
    expect(text).not.toContain('"digital-ai-testing-mcp",\n]');
    expect(text).toContain('[other]\nx = 1');
    expect(clientStatus(target('codex'), entry()).upToDate).toBe(true);
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

  it('macOS Claude Desktop: one config location, so no "confirm it reads this file" note (Windows only)', async () => {
    ctx.platform = 'darwin';
    mkdirSync(join(home, 'Library', 'Application Support', 'Claude'), { recursive: true });
    const t = io();
    expect(await runSetupCli(['clients', 'add', 'claude-desktop', '--yes'], t.s)).toBe(0);
    expect(t.all()).toMatch(/Claude Desktop: added/);
    expect(t.all()).not.toContain('To confirm Claude Desktop reads this file');
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
    expect(await runSetupCli(['clients', 'add', 'xcode'], manual.s)).toBe(2);
    expect(manual.all()).toContain('Xcode');
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
    expect(t.all()).toContain('(replace the one there, if any)');
    expect(t.all()).not.toContain('Restart the AI clients');
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

  describe('Claude Code (user scope, through the claude command)', () => {
    // A fake claude command that keeps ~/.claude.json the way the real one does (top-level mcpServers, type first).
    const fakeClaude = (fail?: 'add' | 'remove') => {
      const calls: string[][] = [];
      const file = join(home, '.claude.json');
      const cli = {
        run: (args: string[]) => {
          calls.push(args);
          const data = existsSync(file) ? json(file) : { numStartups: 3 };
          data.mcpServers ??= {};
          if (args[1] === 'remove') {
            if (fail === 'remove') return { ok: false, output: 'boom' };
            delete data.mcpServers[args[2]];
          } else if (args[1] === 'add-json') {
            if (fail === 'add' && calls.filter((c) => c[1] === 'add-json').length === 1) return { ok: false, output: 'Invalid JSON aut_1_secretInOutput' };
            const { type, ...rest } = JSON.parse(args[5]);
            data.mcpServers[args[4]] = { type, ...rest };
          }
          writeFileSync(file, JSON.stringify(data));
          return { ok: true, output: 'ok' };
        },
      };
      ctx.claudeCli = () => cli;
      return { calls, file };
    };
    const ours = (file: string) => json(file).mcpServers['digital-ai-testing'];

    it('add claude-code runs "claude mcp add-json --scope user"; a second run is "already set up"', async () => {
      const c = fakeClaude();
      const t = io();
      expect(await runSetupCli(['clients', 'add', 'claude-code', '--yes'], t.s)).toBe(0);
      expect(c.calls[0].slice(0, 5)).toEqual(['mcp', 'add-json', '--scope', 'user', 'digital-ai-testing']);
      const e = ours(c.file);
      expect(e.args).not.toContain('-y');
      expect(e.env.npm_config_yes).toBe('true');
      expect(e.type).toBe('stdio');
      expect(json(c.file).numStartups).toBe(3);
      expect(t.all()).toContain('Claude Code: added for all your projects');
      const again = io();
      expect(await runSetupCli(['clients', 'add', 'claude-code'], again.s)).toBe(0);
      expect(again.all()).toContain('Claude Code: already set up');
      expect(c.calls).toHaveLength(1);
    });

    it('setup clients prints the claude mcp add command only while Claude Code is not set up', async () => {
      fakeClaude();
      const before = io();
      expect(await runSetupCli(['clients'], before.s)).toBe(0);
      expect(before.all()).toMatch(/claude-code\s+Claude Code \(all your projects\): installed, not set up/);
      expect(before.all()).toContain('claude mcp add --scope user');
      expect(await runSetupCli(['clients', 'add', 'claude-code', '--yes'], io().s)).toBe(0);
      const after = io();
      expect(await runSetupCli(['clients'], after.s)).toBe(0);
      expect(after.all()).toMatch(/claude-code\s+Claude Code \(all your projects\): set up/);
      expect(after.all()).not.toContain('claude mcp add');
    });

    it('in a terminal a new entry is asked about (default yes); outside one it needs --yes and prints the command', async () => {
      const c = fakeClaude();
      const declined = io(['n'], true);
      expect(await runSetupCli(['clients', 'add', 'claude-code'], declined.s)).toBe(1);
      expect(c.calls).toHaveLength(0);
      const noTerminal = io();
      expect(await runSetupCli(['clients', 'add', 'claude-code'], noTerminal.s)).toBe(1);
      expect(noTerminal.all()).toContain('claude mcp add --scope user');
      const accepted = io([''], true);
      expect(await runSetupCli(['clients', 'add', 'claude-code'], accepted.s)).toBe(0);
      expect(ours(c.file)).toBeDefined();
    });

    it('replacing keeps the old entry\'s other settings (remove, then add-json); remove takes it out', async () => {
      const c = fakeClaude();
      writeFileSync(c.file, JSON.stringify({ mcpServers: { 'digital-ai-testing': { type: 'stdio', command: 'npx', args: ['x'], env: { MCP_DEBUG_MODE: 'true' }, timeout: 5 } } }));
      expect(await runSetupCli(['clients', 'add', 'claude-code', '--yes'], io().s)).toBe(0);
      expect(c.calls.map((a) => a[1])).toEqual(['remove', 'add-json']);
      expect(ours(c.file)).toMatchObject({ timeout: 5, env: { MCP_DEBUG_MODE: 'true', npm_config_yes: 'true' } });
      expect(await runSetupCli(['clients', 'remove', 'claude-code', '--yes'], io().s)).toBe(0);
      expect(ours(c.file)).toBeUndefined();
    });

    it('a failed add puts the previous entry back and never prints a key from the output', async () => {
      const c = fakeClaude('add');
      const old = { type: 'stdio', command: 'npx', args: ['x'], env: {} };
      writeFileSync(c.file, JSON.stringify({ mcpServers: { 'digital-ai-testing': old } }));
      const t = io();
      expect(await runSetupCli(['clients', 'add', 'claude-code', '--yes'], t.s)).toBe(1);
      expect(t.all()).toContain('The previous entry was put back');
      expect(t.all()).not.toContain('aut_1_secretInOutput');
      expect(ours(c.file)).toEqual(old);
    });

    it('warns about per-project entries that replace the user-scope one (local in ~/.claude.json, or a project .mcp.json)', async () => {
      const c = fakeClaude();
      const projA = join(home, 'projA');
      const projB = join(home, 'projB');
      const projC = join(home, 'projC');
      const projD = join(home, 'projD');
      const projE = join(home, 'projE');
      for (const p of [projA, projB, projC, projD, projE]) mkdirSync(p);
      const shared = JSON.stringify({ mcpServers: { dai: { command: 'npx', args: ['-y', 'digital-ai-testing-mcp@latest'] } } });
      for (const p of [projB, projD, projE]) writeFileSync(join(p, '.mcp.json'), shared);
      mkdirSync(join(projD, '.claude'));
      writeFileSync(join(projD, '.claude', 'settings.local.json'), JSON.stringify({ enabledMcpjsonServers: ['dai'] }));
      writeFileSync(c.file, JSON.stringify({
        projects: {
          [projA]: { mcpServers: { 'digital-ai-testing': { command: 'npx', args: ['x'], env: { DIGITAL_AI_ACCESS_KEY: 'aut_1_secretLocal' } } } },
          [projB]: { mcpServers: {} },
          [projC]: { mcpServers: { qel: { command: 'node', args: ['other-server.js'] } } }, // not ours
          [projD]: {},
          [projE]: { disabledMcpjsonServers: ['dai'] }, // turned off: overrides nothing
        },
      }));

      const list = io();
      expect(await runSetupCli(['clients'], list.s)).toBe(0);
      expect(list.out).toContain('  WARNING  3 Claude Code projects use their own server entry, not this setup');
      // One block per project: its folder on its own line, then aligned rows; the command alone on its line.
      const block = (project: string) => {
        const start = list.out.indexOf(`    ${project}`);
        expect(start).toBeGreaterThan(-1);
        const end = list.out.indexOf('', start);
        return list.out.slice(start + 1, end === -1 ? undefined : end);
      };
      expect(block(projA)).toEqual([
        '      Entry:  "digital-ai-testing" (with its own access key), local to this computer',
        '      Fix:    run',
        `        cd "${projA}" ; claude mcp remove "digital-ai-testing" -s local`,
      ]);
      expect(block(projB)).toEqual([
        '      Entry:  "dai"',
        `      File:   ${join(projB, '.mcp.json')}`,
        '      Note:   shared with the repository; Claude Code asks before using it',
        '      Fix:    remove "dai" from that file',
      ]);
      expect(block(projD)).toContain('      Note:   shared with the repository'); // approved: already in use
      expect(list.all()).not.toContain(projE);
      expect(list.all()).not.toContain('qel');
      expect(list.all()).not.toContain('aut_1_secretLocal');

      const add = io();
      expect(await runSetupCli(['clients', 'add', 'claude-code', '--yes'], add.s)).toBe(0);
      expect(add.all()).toContain('WARNING  3 Claude Code projects use their own server entry');
      expect(json(c.file).projects[projA].mcpServers['digital-ai-testing']).toBeDefined(); // only warned about, never removed

      const doctor = io();
      await runSetupCli(['doctor', '--offline'], doctor.s);
      expect(doctor.all()).toContain(`cd "${projA}" ; claude mcp remove`);

      // Removed → no warning.
      writeFileSync(c.file, JSON.stringify({ ...json(c.file), projects: { [projC]: { mcpServers: {} }, [projE]: { disabledMcpjsonServers: ['dai'] } } }));
      const clean = io();
      expect(await runSetupCli(['clients'], clean.s)).toBe(0);
      expect(clean.all()).not.toContain('WARNING');
    });

    it('"clients add" with no names includes Claude Code when the claude command exists; without it nothing is run', async () => {
      mkdirSync(join(home, '.cursor'));
      const c = fakeClaude();
      expect(await runSetupCli(['clients', 'add', '--yes'], io().s)).toBe(0);
      expect(ours(c.file)).toBeDefined();
      ctx.claudeCli = () => undefined;
      const t = io();
      expect(await runSetupCli(['clients', 'add', 'claude-code'], t.s)).toBe(1);
      expect(t.all()).toContain('the claude command was not found');
      expect(await runSetupCli(['clients', 'add', 'claude-code', '--config', join(home, 'x.json')], io().s)).toBe(2);
    });
  });

  it.runIf(process.platform === 'win32')('findClaudeCli: npm\'s claude.cmd wrapper → its claude.exe, run without a shell', () => {
    const bin = join(home, 'bin');
    const exe = join(bin, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    mkdirSync(dirname(exe), { recursive: true });
    writeFileSync(exe, '');
    writeFileSync(join(bin, 'claude.cmd'), '@ECHO off\r\nCALL :find_dp0\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n');
    const c = { ...ctx, platform: 'win32' as const, env: { PATH: `${join(home, 'nothing')};${bin}` } };
    expect(findClaudeCli(c)).toBeDefined();
    writeFileSync(join(bin, 'claude.cmd'), '@ECHO off\r\nnode something\r\n');
    expect(findClaudeCli(c)).toBeUndefined(); // a wrapper it cannot read is never run through a shell
    expect(findClaudeCli({ ...c, env: { PATH: dirname(exe) } })).toBeDefined(); // claude.exe directly on PATH
  });

  it('nothing installed: add says so', async () => {
    const t = io();
    expect(await runSetupCli(['clients', 'add'], t.s)).toBe(1);
    expect(t.all()).toContain('No AI clients were found');
  });
});

describe('warm start after writing client entries', () => {
  it('runs after clients add, reports the time and version — also when every entry was already right', async () => {
    mkdirSync(join(home, '.cursor'));
    const calls: string[] = [];
    ctx.warmStart = async (e) => {
      calls.push(e.args.join(' '));
      return { ok: true, ms: 3200, version: '9.9.9' };
    };
    const t = io();
    expect(await runSetupCli(['clients', 'add', 'cursor'], t.s)).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain(packageSpec(ctx.version));
    expect(t.all()).toContain('The server started in 3.2 s (version 9.9.9).');
    const again = io();
    expect(await runSetupCli(['clients', 'add', 'cursor'], again.s)).toBe(0);
    expect(calls).toHaveLength(2); // nothing written, but a new release still gets downloaded ahead of the clients
    expect(again.all()).toContain('already set up');
    expect(again.all()).not.toContain('Restart the AI clients');
  });

  it('a failed start is a note with what to do, not a setup failure', async () => {
    mkdirSync(join(home, '.cursor'));
    ctx.warmStart = async () => ({ ok: false, ms: 180000, error: 'no answer within 180 s' });
    const t = io();
    expect(await runSetupCli(['clients', 'add', 'cursor'], t.s)).toBe(0);
    expect(t.all()).toContain('The server did not start (no answer within 180 s, after 180.0 s)');
    expect(t.all()).toContain('reconnect the server there once more');
  });

  // The real warmStart, against tiny stand-in servers (no npx, no network).
  const server = (name: string, code: string) => {
    const f = join(home, name);
    writeFileSync(f, code);
    return { command: process.execPath, args: [f], env: {}, notes: [] };
  };

  it('times the first answer to initialize and reads the version', async () => {
    const e = server(
      'ok.cjs',
      `process.stdin.on('data', (d) => { const m = JSON.parse(String(d)); process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { serverInfo: { name: 'x', version: '1.2.3' } } }) + '\\n'); });`
    );
    const r = await warmStart(e, 20000);
    expect(r).toMatchObject({ ok: true, version: '1.2.3' });
    expect(r.ms).toBeLessThan(20000);
  });

  it('reports a server that exits, with its last error line', async () => {
    const r = await warmStart(server('dies.cjs', `console.error('FATAL: cannot start'); process.exit(3);`), 20000);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/exited \(code 3\): FATAL: cannot start/);
  });

  it('gives up after the limit on a server that never answers', async () => {
    const r = await warmStart(server('silent.cjs', `process.stdin.resume(); process.stdin.on('end', () => process.exit(0)); setInterval(() => {}, 1000);`), 1500);
    expect(r).toMatchObject({ ok: false, error: 'no answer within 2 s' });
  });
});
