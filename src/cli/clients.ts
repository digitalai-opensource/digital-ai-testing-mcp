/**
 * AI-client configuration for `setup clients` — finds the AI clients on this machine and adds, replaces or removes the
 * server's entry in each one's configuration file. The entry never contains a key: the server reads credentials from
 * the credential store (or from whatever the user sets in the client themselves).
 *
 * The launch command (verified on Windows 2026-11-17, fnm-installed Node 22, PATH stripped to the system folder):
 *   - plain `npx` fails twice when the client does not pass the user's PATH (Xcode's agents, macOS GUI apps, apps started
 *     outside a shell that sets up a Node version manager): the client cannot find npx, and npx's second step cannot
 *     find `node` ('"node" is not recognized');
 *   - `<absolute node> <npm's npx-cli.js> -y digital-ai-testing-mcp@latest` with PATH = Node's folder + the system
 *     folder starts the server; so does the same with fnm's stable `aliases/default` folder.
 * So the entry runs Node by absolute path, keeps `@latest` (a new release arrives at the next start) and sets its own
 * PATH. The server starts no other programs, so that PATH is enough. A version-specific Node path (nvm, volta, fnm
 * without an alias) is used as is, with a note to run `setup clients` again after switching Node versions.
 *
 * Everything here takes a ClientContext so tests run against temp folders; nothing reads the real home folder directly.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { getServerVersion, PACKAGE_NAME, packageSpec } from '../utils/version.js';
import { installKind, type InstallKind } from '../utils/update-check.js';

export const SERVER_ENTRY_NAME = 'digital-ai-testing';
// The entry starts packageSpec(version): @latest, or @next when setup itself is a prerelease (see utils/version.ts).
export { PACKAGE_NAME, packageSpec };

/**
 * How to run setup again from THIS install, for the hints setup prints. A bare `digital-ai-testing-mcp setup` can start
 * a different, older global install (seen live 2026-11-18: an old global copy answered with its pre-setup FATAL
 * error) — so a setup started through npx names npx, and a source checkout names its own entry point.
 */
export function setupCommand(kind: InstallKind = installKind(), version: string | undefined = getServerVersion()): string {
  if (kind === 'npx') return `npx -y ${packageSpec(version)} setup`;
  if (kind === 'source') return 'node dist/index.js setup';
  return `${PACKAGE_NAME} setup`;
}
const BACKUP_SUFFIX = '.digital-ai-testing.bak';

export interface ClientContext {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  home: string;
  /** process.execPath — the Node.js running setup. */
  execPath: string;
  /** The version of the running setup (package.json) — a prerelease selects the `next` channel. */
  version?: string;
  exists(path: string): boolean;
  /** Folder listing (default readdirSync); tests fake it to check Windows layouts on any OS. */
  listDir?(path: string): string[];
  /** Resolves links (default realpathSync; undefined on failure) — follows fnm's per-terminal link to the real Node. */
  realPath?(path: string): string | undefined;
}

export function defaultClientContext(): ClientContext {
  return {
    platform: process.platform,
    env: process.env,
    home: homedir(),
    execPath: process.execPath,
    exists: existsSync,
    version: getServerVersion(),
    realPath: (p) => {
      try {
        return realpathSync(p);
      } catch {
        return undefined;
      }
    },
  };
}

// ─── The launch command ───────────────────────────────────────────────────────

export interface LaunchEntry {
  command: string;
  args: string[];
  env: Record<string, string>;
  /** Things the user should know about this entry (version-specific Node path, npx not found). */
  notes: string[];
}

function pathJoin(ctx: ClientContext, ...parts: string[]): string {
  // Build paths for the TARGET platform, not the host (tests build Windows paths on Linux CI and vice versa).
  const sep = ctx.platform === 'win32' ? '\\' : '/';
  return parts
    .join(sep)
    .replace(/[\\/]+/g, sep)
    .replace(ctx.platform === 'win32' ? /\\[^\\]+\\\.\.(?=\\|$)/g : /\/[^/]+\/\.\.(?=\/|$)/g, '');
}

function parentDir(ctx: ClientContext, p: string): string {
  const sep = ctx.platform === 'win32' ? '\\' : '/';
  const i = p.replace(/[\\/]+$/, '').lastIndexOf(sep);
  return i > 0 ? p.slice(0, i) : p;
}

const FNM_MULTISHELL_RE = /[\\/]fnm_multishells[\\/][^\\/]+(?:[\\/]bin)?$/i;

/** Where fnm keeps its versions and aliases: FNM_DIR, else fnm's default folders for the platform. */
function fnmDirCandidates(ctx: ClientContext): string[] {
  const e = ctx.env;
  const list = [e.FNM_DIR?.trim()];
  if (ctx.platform === 'win32') list.push(e.APPDATA && pathJoin(ctx, e.APPDATA, 'fnm'), pathJoin(ctx, ctx.home, 'AppData', 'Roaming', 'fnm'));
  else list.push(e.XDG_DATA_HOME && pathJoin(ctx, e.XDG_DATA_HOME, 'fnm'), pathJoin(ctx, ctx.home, '.local', 'share', 'fnm'), pathJoin(ctx, ctx.home, 'Library', 'Application Support', 'fnm'));
  list.push(pathJoin(ctx, ctx.home, '.fnm'));
  return [...new Set(list.filter((d): d is string => !!d))];
}

function fnmAlias(ctx: ClientContext, fnmDir: string): string | undefined {
  const win = ctx.platform === 'win32';
  const alias = pathJoin(ctx, fnmDir, 'aliases', 'default', ...(win ? [] : ['bin']));
  return ctx.exists(pathJoin(ctx, alias, win ? 'node.exe' : 'node')) ? alias : undefined;
}

/** The folder holding the node binary, swapped for a version manager's stable alias when one exists. */
export function stableNodeDir(ctx: ClientContext): { dir: string; versionSpecific: boolean; temporary?: boolean } {
  const dir = parentDir(ctx, ctx.execPath);

  // fnm's per-terminal link (<state dir>/fnm_multishells/<id>[/bin]) — set up by `fnm env` in every shell and deleted
  // later, so it must never reach a client's config (seen live 2026-11-18: npx from an fnm shell ran node from there).
  if (FNM_MULTISHELL_RE.test(dir)) {
    for (const fnmDir of fnmDirCandidates(ctx)) {
      const alias = fnmAlias(ctx, fnmDir);
      if (alias) return { dir: alias, versionSpecific: false };
    }
    const real = ctx.realPath?.(dir);
    if (real && !FNM_MULTISHELL_RE.test(real)) {
      return stableNodeDir({ ...ctx, execPath: pathJoin(ctx, real, ctx.platform === 'win32' ? 'node.exe' : 'node') });
    }
    return { dir, versionSpecific: true, temporary: true };
  }

  // fnm: <fnm dir>/node-versions/<v>/installation[/bin] → <fnm dir>/aliases/default[/bin]
  const fnm = /^(.*[\\/])node-versions[\\/][^\\/]+[\\/]installation(?:[\\/]bin)?$/.exec(dir);
  if (fnm) {
    const alias = fnmAlias(ctx, fnm[1]);
    if (alias) return { dir: alias, versionSpecific: false };
    return { dir, versionSpecific: true };
  }
  // nvm (~/.nvm/versions/node/<v>/bin), volta (…/volta/tools/image/node/<v>[/bin]), nvm-windows (…\nvm\v<x>) — no stable
  // folder that also holds npm, so the versioned one is used.
  const versioned = /[\\/]\.nvm[\\/]versions[\\/]|[\\/]volta[\\/]tools[\\/]image[\\/]node[\\/]|[\\/]nvm[\\/]v\d/i.test(dir);
  return { dir, versionSpecific: versioned };
}

/** System folders the server's PATH keeps (npx's helpers live there). */
function systemPath(ctx: ClientContext): string[] {
  if (ctx.platform === 'win32') return [pathJoin(ctx, ctx.env.SystemRoot?.trim() || 'C:\\Windows', 'System32')];
  return ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];
}

export function buildLaunchEntry(ctx: ClientContext): LaunchEntry {
  const win = ctx.platform === 'win32';
  const notes: string[] = [];
  const spec = packageSpec(ctx.version);
  if (spec.endsWith('@next')) {
    notes.push(
      `This is a beta (${ctx.version}), so the entry starts the beta channel (${spec}) and updates with each beta. ` +
        `Once a release includes setup, "npx -y ${PACKAGE_NAME}@latest setup clients add --yes" moves the entries back to releases.`
    );
  }
  const { dir, versionSpecific, temporary } = stableNodeDir(ctx);
  const node = pathJoin(ctx, dir, win ? 'node.exe' : 'node');
  const npxCli = win ? pathJoin(ctx, dir, 'node_modules', 'npm', 'bin', 'npx-cli.js') : pathJoin(ctx, dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js');
  const env: Record<string, string> = { PATH: [dir, ...systemPath(ctx)].join(win ? ';' : ':'), MCP_DEPLOYMENT_MODE: 'local' };

  if (temporary) {
    notes.push(
      `Node.js is running from fnm's per-terminal link (${dir}), which fnm deletes later, and no fnm default was found. ` +
        `Run "fnm default <version>", then "${setupCommand()} clients add" again.`
    );
  } else if (versionSpecific) {
    notes.push(`Node.js is at a version-specific path (${dir}). After switching Node versions, run "${setupCommand()} clients add" again.`);
  }
  if (!ctx.exists(npxCli)) {
    // Unusual layout: fall back to plain npx and rely on the client's PATH.
    notes.push(`npm's npx was not found next to Node.js (${npxCli}); the entry starts "npx" from the client's PATH instead.`);
    return win
      ? { command: 'cmd', args: ['/c', 'npx', '-y', spec], env: { MCP_DEPLOYMENT_MODE: 'local' }, notes }
      : { command: 'npx', args: ['-y', spec], env: { MCP_DEPLOYMENT_MODE: 'local' }, notes };
  }
  return { command: node, args: [npxCli, '-y', spec], env, notes };
}

// ─── Clients ──────────────────────────────────────────────────────────────────

export type ClientFormat = 'mcpServers' | 'vscode' | 'opencode' | 'codex-toml';

export interface ClientTarget {
  id: string;
  label: string;
  format: ClientFormat;
  /** The configuration file the entry goes in. */
  file: string;
  /** Present when the client is installed (its own folder exists), whether or not the file does. */
  detected: boolean;
  /**
   * Set when setup cannot tell which file the client reads (Claude Desktop on Windows with several config files, or
   * none yet): nothing is written until the user names one with --config. Lists the candidate files.
   */
  choices?: string[];
}

/** Clients the user configures by hand (shown by `setup clients`, never written). */
export interface ManualClient {
  id: string;
  label: string;
  how: string;
}

function appData(ctx: ClientContext): string {
  return ctx.env.APPDATA?.trim() || pathJoin(ctx, ctx.home, 'AppData', 'Roaming');
}

/**
 * Claude Desktop's folders on Windows, newest layout first (found on a real install 2026-11-17):
 *   %LOCALAPPDATA%\Claude-Data\claude_<package id>\ — where current versions keep settings and the config file (the
 *       folder's own README.txt says so, and that "older files of Claude's may also be left in %APPDATA%\Claude");
 *   %LOCALAPPDATA%\Packages\Claude_<id>\LocalCache\Roaming\Claude — the Store package's virtualised AppData (empty there);
 *   %APPDATA%\Claude — older versions and the documented path.
 */
function claudeDesktopDirs(ctx: ClientContext): string[] {
  if (ctx.platform === 'darwin') return [pathJoin(ctx, ctx.home, 'Library', 'Application Support', 'Claude')];
  if (ctx.platform !== 'win32') return [];
  const local = ctx.env.LOCALAPPDATA?.trim() || pathJoin(ctx, ctx.home, 'AppData', 'Local');
  const dirs: string[] = [];
  const dataRoot = pathJoin(ctx, local, 'Claude-Data');
  for (const d of listDir(ctx, dataRoot)) if (/^claude_/i.test(d)) dirs.push(pathJoin(ctx, dataRoot, d));
  const packages = pathJoin(ctx, local, 'Packages');
  for (const p of listDir(ctx, packages)) {
    if (/^Claude_/i.test(p)) dirs.push(pathJoin(ctx, packages, p, 'LocalCache', 'Roaming', 'Claude'));
    // A variant reported for some installs: Anthropic.Claude_<id>\LocalCache\Local\Claude.
    if (/^Anthropic\.Claude_/i.test(p)) dirs.push(pathJoin(ctx, packages, p, 'LocalCache', 'Local', 'Claude'));
  }
  dirs.push(pathJoin(ctx, appData(ctx), 'Claude'));
  return dirs;
}

export const CLAUDE_DESKTOP_FILE = 'claude_desktop_config.json';

/**
 * Claude Desktop's target. macOS has one documented folder. On Windows the location differs by install type and
 * version — and the app's own "Edit Config" button has been reported to open a different file than the MSIX build reads
 * (community bug reports, 2026) — so the file is chosen only when EXACTLY ONE candidate folder holds a config file.
 * Several files, or none yet: `choices` lists them and nothing is written until the user picks one with --config.
 */
function claudeDesktopTarget(ctx: ClientContext): ClientTarget | undefined {
  const dirs = claudeDesktopDirs(ctx);
  if (dirs.length === 0) return undefined;
  const base = { id: 'claude-desktop', label: 'Claude Desktop', format: 'mcpServers' as const };
  const files = dirs.map((d) => pathJoin(ctx, d, CLAUDE_DESKTOP_FILE));
  if (ctx.platform !== 'win32') return { ...base, file: files[0], detected: ctx.exists(dirs[0]) };
  const withFile = files.filter((f) => ctx.exists(f));
  if (withFile.length === 1) return { ...base, file: withFile[0], detected: true };
  const existingDirs = dirs.filter((d) => ctx.exists(d));
  const choices = withFile.length > 1 ? withFile : existingDirs.map((d) => pathJoin(ctx, d, CLAUDE_DESKTOP_FILE));
  return { ...base, file: choices[0] ?? files[0], detected: existingDirs.length > 0, choices };
}

function listDir(ctx: ClientContext, dir: string): string[] {
  try {
    return (ctx.listDir ?? readdirSync)(dir);
  } catch {
    return [];
  }
}

function vscodeUserDir(ctx: ClientContext, product: 'Code' | 'Code - Insiders'): string {
  if (ctx.platform === 'win32') return pathJoin(ctx, appData(ctx), product, 'User');
  if (ctx.platform === 'darwin') return pathJoin(ctx, ctx.home, 'Library', 'Application Support', product, 'User');
  return pathJoin(ctx, ctx.env.XDG_CONFIG_HOME?.trim() || pathJoin(ctx, ctx.home, '.config'), product, 'User');
}

/** Every client whose configuration file setup can edit, in display order. */
export function knownClients(ctx: ClientContext): ClientTarget[] {
  const t = (id: string, label: string, format: ClientFormat, dir: string, file: string): ClientTarget => ({
    id,
    label,
    format,
    file: pathJoin(ctx, dir, file),
    detected: ctx.exists(dir),
  });
  const out: ClientTarget[] = [];
  const desktop = claudeDesktopTarget(ctx);
  if (desktop) out.push(desktop);
  out.push(t('vscode', 'VS Code (GitHub Copilot agent mode)', 'vscode', vscodeUserDir(ctx, 'Code'), 'mcp.json'));
  out.push(t('vscode-insiders', 'VS Code Insiders', 'vscode', vscodeUserDir(ctx, 'Code - Insiders'), 'mcp.json'));
  out.push(t('cursor', 'Cursor', 'mcpServers', pathJoin(ctx, ctx.home, '.cursor'), 'mcp.json'));
  out.push(t('windsurf', 'Windsurf', 'mcpServers', pathJoin(ctx, ctx.home, '.codeium', 'windsurf'), 'mcp_config.json'));
  out.push(t('codex', 'OpenAI Codex (CLI, IDE extension, ChatGPT desktop)', 'codex-toml', ctx.env.CODEX_HOME?.trim() || pathJoin(ctx, ctx.home, '.codex'), 'config.toml'));
  out.push(t('opencode', 'OpenCode', 'opencode', pathJoin(ctx, ctx.env.XDG_CONFIG_HOME?.trim() || pathJoin(ctx, ctx.home, '.config'), 'opencode'), 'opencode.json'));
  out.push(t('gemini-cli', 'Gemini CLI', 'mcpServers', pathJoin(ctx, ctx.home, '.gemini'), 'settings.json'));
  return out;
}

/** Clients setup does not edit (yet) — listed with what to do instead. */
export function manualClients(): ManualClient[] {
  return [
    {
      id: 'claude-code',
      label: 'Claude Code (terminal, VS Code and JetBrains/Android Studio extensions)',
      how: 'Claude Code rewrites its own settings file while it runs, so setup prints a "claude mcp add" command for you to run instead (see below).',
    },
    {
      id: 'xcode',
      label: 'Xcode 26.3+ (Claude Agent, Codex)',
      how: 'Not edited yet: the location of Xcode\'s agent settings is not verified. Use the same entry in Xcode\'s agent MCP settings.',
    },
    {
      id: 'android-studio-gemini',
      label: 'Gemini in Android Studio',
      how: 'Accepts only HTTP MCP servers, so it cannot start this server. Use Claude Code\'s JetBrains plugin in Android Studio instead.',
    },
  ];
}

/**
 * The `claude mcp add` command for Claude Code (printed, not run). On Windows every path uses forward slashes: Claude
 * Code strips backslashes when it saves a server entry, and the entry was verified to start with forward slashes in
 * the command, the script path and PATH (2026-11-17).
 */
export function claudeCodeCommand(entry: LaunchEntry, platform: NodeJS.Platform): string {
  const win = platform === 'win32';
  const q = (raw: string) => {
    const s = win ? raw.replace(/\\/g, '/') : raw;
    return win ? `"${s.replace(/"/g, '\\"')}"` : `'${s.replace(/'/g, `'\\''`)}'`;
  };
  const envFlags = Object.entries(entry.env).map(([k, v]) => `-e ${q(`${k}=${v}`)}`);
  return ['claude mcp add --scope user', ...envFlags, SERVER_ENTRY_NAME, '--', q(entry.command), ...entry.args.map(q)].join(' ');
}

// ─── Reading and editing configuration files ──────────────────────────────────

export interface EntryStatus {
  /** The file exists. */
  fileExists: boolean;
  /** The file could not be parsed (JSON with comments, invalid JSON/TOML) — setup will not edit it. */
  unreadable?: string;
  /** An entry named SERVER_ENTRY_NAME exists. */
  hasEntry: boolean;
  /** That entry sets an access key itself (it then wins over the credential store). */
  entryHasKeys: boolean;
  /** That entry is exactly what setup would write now. */
  upToDate: boolean;
  /** Other entries that start this package under another name. */
  otherNames: string[];
}

const KEY_VAR_RE = /^(DIGITAL_AI_ACCESS_KEY|DAI_PROFILE_.+_KEY)$/;
const RUNS_PACKAGE_RE = /digital-ai-testing-mcp/;

type Json = Record<string, unknown>;

function containerKey(format: ClientFormat): 'mcpServers' | 'servers' | 'mcp' {
  return format === 'vscode' ? 'servers' : format === 'opencode' ? 'mcp' : 'mcpServers';
}

/** The entry object in this client's format. */
export function entryFor(format: ClientFormat, e: LaunchEntry): Json {
  switch (format) {
    case 'vscode':
      return { type: 'stdio', command: e.command, args: e.args, env: e.env };
    case 'opencode':
      return { type: 'local', command: [e.command, ...e.args], environment: e.env, enabled: true };
    default:
      return { command: e.command, args: e.args, env: e.env };
  }
}

function readJson(file: string): { data?: Json; error?: string; exists: boolean } {
  if (!existsSync(file)) return { exists: false, data: {} };
  const text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  if (!text.trim()) return { exists: true, data: {} };
  try {
    const data = JSON.parse(text);
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { exists: true, error: 'it is not a JSON object' };
    return { exists: true, data: data as Json };
  } catch {
    // Comments or trailing commas (JSONC): rewriting would drop the user's comments, so it is left alone.
    return { exists: true, error: 'it contains comments or is not valid JSON, and setup does not rewrite such files' };
  }
}

function envOf(format: ClientFormat, entry: unknown): Record<string, unknown> {
  if (!entry || typeof entry !== 'object') return {};
  const e = entry as Json;
  const env = format === 'opencode' ? e.environment : e.env;
  return env && typeof env === 'object' ? (env as Record<string, unknown>) : {};
}

function jsonStatus(target: ClientTarget, wanted: Json): EntryStatus {
  const r = readJson(target.file);
  if (r.error) return { fileExists: r.exists, unreadable: r.error, hasEntry: false, entryHasKeys: false, upToDate: false, otherNames: [] };
  const container = (r.data?.[containerKey(target.format)] ?? {}) as Json;
  const entry = container[SERVER_ENTRY_NAME];
  const otherNames = Object.entries(container)
    .filter(([name, e]) => name !== SERVER_ENTRY_NAME && RUNS_PACKAGE_RE.test(JSON.stringify(e)))
    .map(([name]) => name);
  return {
    fileExists: r.exists,
    hasEntry: entry !== undefined,
    entryHasKeys: Object.keys(envOf(target.format, entry)).some((k) => KEY_VAR_RE.test(k)),
    upToDate: entry !== undefined && JSON.stringify(entry) === JSON.stringify(wanted),
    otherNames,
  };
}

// Codex: TOML. Setup only ever touches its own [mcp_servers.digital-ai-testing] table (and its .env sub-table).

const CODEX_HEADER_RE = new RegExp(`^\\[mcp_servers\\.(?:"${SERVER_ENTRY_NAME}"|${SERVER_ENTRY_NAME})(?:\\.env)?\\]\\s*$`);

function tomlString(s: string): string {
  return JSON.stringify(s); // a JSON string is a valid TOML basic string for paths and simple values
}

export function codexBlock(e: LaunchEntry): string {
  const envPairs = Object.entries(e.env).map(([k, v]) => `${k} = ${tomlString(v)}`);
  return [
    `[mcp_servers.${SERVER_ENTRY_NAME}]`,
    `command = ${tomlString(e.command)}`,
    `args = [${e.args.map(tomlString).join(', ')}]`,
    '',
    `[mcp_servers.${SERVER_ENTRY_NAME}.env]`,
    ...envPairs,
  ].join('\n');
}

/** Splits a TOML file into our tables (header + body lines) and everything else, keeping order. */
function splitCodex(text: string): { before: string[]; ours: string[]; after: string[] } {
  const lines = text.split(/\r?\n/);
  const before: string[] = [];
  const ours: string[] = [];
  const after: string[] = [];
  let state: 'before' | 'ours' | 'after' = 'before';
  for (const line of lines) {
    const isHeader = /^\s*\[/.test(line);
    if (isHeader && CODEX_HEADER_RE.test(line.trim())) {
      // Our table (or its .env sub-table), even if another table sits between them: all of it is replaced together.
      ours.push(line);
      state = 'ours';
      continue;
    }
    if (isHeader && state === 'ours') state = 'after';
    (state === 'before' ? before : state === 'ours' ? ours : after).push(line);
  }
  return { before, ours, after };
}

function codexStatus(target: ClientTarget, block: string): EntryStatus {
  if (!existsSync(target.file)) return { fileExists: false, hasEntry: false, entryHasKeys: false, upToDate: false, otherNames: [] };
  const text = readFileSync(target.file, 'utf8');
  const { ours } = splitCodex(text);
  const oursText = ours.join('\n').trim();
  const otherNames = [...text.matchAll(/^\[mcp_servers\.("?)([^\].]+)\1\]\s*$/gm)]
    .map((m) => m[2])
    .filter((n) => n !== SERVER_ENTRY_NAME)
    .filter((n) => {
      const start = text.indexOf(`[mcp_servers.${n}]`);
      const next = text.indexOf('\n[', start + 1);
      return RUNS_PACKAGE_RE.test(text.slice(start, next === -1 ? undefined : next));
    });
  return {
    fileExists: true,
    hasEntry: ours.length > 0,
    entryHasKeys: /^\s*(DIGITAL_AI_ACCESS_KEY|DAI_PROFILE_\w+_KEY)\s*=/m.test(oursText),
    upToDate: oursText === block.trim(),
    otherNames,
  };
}

export function clientStatus(target: ClientTarget, e: LaunchEntry): EntryStatus {
  return target.format === 'codex-toml' ? codexStatus(target, codexBlock(e)) : jsonStatus(target, entryFor(target.format, e));
}

function backup(file: string): string | undefined {
  if (!existsSync(file)) return undefined;
  const b = file + BACKUP_SUFFIX;
  copyFileSync(file, b);
  return b;
}

export interface EditResult {
  ok: boolean;
  /** The backup made before the change, when the file existed. */
  backup?: string;
  error?: string;
}

/** Adds or replaces the entry. Leaves every other entry and setting untouched. */
export function writeClientEntry(target: ClientTarget, e: LaunchEntry): EditResult {
  try {
    if (target.format === 'codex-toml') {
      const text = existsSync(target.file) ? readFileSync(target.file, 'utf8') : '';
      const { before, after } = splitCodex(text);
      const head = before.join('\n').replace(/\s+$/, '');
      const tail = after.join('\n').replace(/^\s+/, '').replace(/\s+$/, '');
      const body = [head, codexBlock(e), tail].filter((s) => s).join('\n\n') + '\n';
      const b = backup(target.file);
      mkdirSync(dirname(target.file), { recursive: true });
      writeFileSync(target.file, body, 'utf8');
      return { ok: true, backup: b };
    }
    const r = readJson(target.file);
    if (r.error || !r.data) return { ok: false, error: `${target.file}: ${r.error}` };
    const key = containerKey(target.format);
    const container = (r.data[key] && typeof r.data[key] === 'object' ? r.data[key] : {}) as Json;
    container[SERVER_ENTRY_NAME] = entryFor(target.format, e);
    r.data[key] = container;
    const b = backup(target.file);
    mkdirSync(dirname(target.file), { recursive: true });
    writeFileSync(target.file, JSON.stringify(r.data, null, 2) + '\n', 'utf8');
    return { ok: true, backup: b };
  } catch (err) {
    return { ok: false, error: `${target.file}: ${(err as Error).message}` };
  }
}

/** Removes the entry (and nothing else). `removed` is false when there was none. */
export function removeClientEntry(target: ClientTarget): EditResult & { removed?: boolean } {
  try {
    if (!existsSync(target.file)) return { ok: true, removed: false };
    if (target.format === 'codex-toml') {
      const text = readFileSync(target.file, 'utf8');
      const { before, ours, after } = splitCodex(text);
      if (ours.length === 0) return { ok: true, removed: false };
      const b = backup(target.file);
      const body = [before.join('\n').replace(/\s+$/, ''), after.join('\n').replace(/^\s+/, '').replace(/\s+$/, '')].filter((s) => s).join('\n\n');
      writeFileSync(target.file, body ? body + '\n' : '', 'utf8');
      return { ok: true, removed: true, backup: b };
    }
    const r = readJson(target.file);
    if (r.error || !r.data) return { ok: false, error: `${target.file}: ${r.error}` };
    const container = r.data[containerKey(target.format)] as Json | undefined;
    if (!container || !(SERVER_ENTRY_NAME in container)) return { ok: true, removed: false };
    delete container[SERVER_ENTRY_NAME];
    const b = backup(target.file);
    writeFileSync(target.file, JSON.stringify(r.data, null, 2) + '\n', 'utf8');
    return { ok: true, removed: true, backup: b };
  } catch (err) {
    return { ok: false, error: `${target.file}: ${(err as Error).message}` };
  }
}

/** The entry as JSON for a person to paste (Xcode, a JSONC file setup will not rewrite). */
export function pasteSnippet(format: ClientFormat, e: LaunchEntry): string {
  return JSON.stringify({ [containerKey(format)]: { [SERVER_ENTRY_NAME]: entryFor(format, e) } }, null, 2);
}
