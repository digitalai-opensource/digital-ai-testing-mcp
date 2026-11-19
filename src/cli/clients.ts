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
import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { getServerVersion, npxCommand, PACKAGE_NAME, packageSpec } from '../utils/version.js';
import { installKind, type InstallKind } from '../utils/update-check.js';

export const SERVER_ENTRY_NAME = 'digital-ai-testing';
// The entry starts packageSpec(version): @latest, or @next when setup itself is a prerelease (see utils/version.ts).
export { PACKAGE_NAME, packageSpec };

/**
 * How to run setup again from THIS install, for the hints setup prints. A bare `digital-ai-testing-mcp setup` can start
 * a different, older global install (seen live 2026-11-18: an old global copy answered with its pre-setup FATAL
 * error) — so a setup started through npx names npx, and a source checkout names its own entry point.
 */
export function setupCommand(
  kind: InstallKind = installKind(),
  version: string | undefined = getServerVersion(),
  platform: NodeJS.Platform = process.platform
): string {
  if (kind === 'npx') return `${npxCommand(platform)} -y ${packageSpec(version)} setup`;
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
  /** The claude command (Claude Code), when installed — default findClaudeCli; tests fake it. */
  claudeCli?(): ClaudeCli | undefined;
}

export function defaultClientContext(): ClientContext {
  return {
    platform: process.platform,
    env: process.env,
    home: homedir(),
    execPath: process.execPath,
    exists: existsSync,
    version: getServerVersion(),
    claudeCli() {
      return findClaudeCli(this);
    },
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
        `Once a release includes setup, "${npxCommand(ctx.platform)} -y ${PACKAGE_NAME}@latest setup clients add --yes" moves the entries back to releases.`
    );
  }
  const { dir, versionSpecific, temporary } = stableNodeDir(ctx);
  const node = pathJoin(ctx, dir, win ? 'node.exe' : 'node');
  const npxCli = win ? pathJoin(ctx, dir, 'node_modules', 'npm', 'bin', 'npx-cli.js') : pathJoin(ctx, dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js');
  const env: Record<string, string> = { PATH: [dir, ...systemPath(ctx)].join(win ? ';' : ':'), MCP_DEPLOYMENT_MODE: 'local' };

  if (temporary) {
    notes.push(
      `Node.js is running from fnm's per-terminal link (${dir}), which fnm deletes later, and no fnm default was found. ` +
        `Run "fnm default <version>", then "${setupCommand(undefined, undefined, ctx.platform)} clients add" again.`
    );
  } else if (versionSpecific) {
    notes.push(`Node.js is at a version-specific path (${dir}). After switching Node versions, run "${setupCommand(undefined, undefined, ctx.platform)} clients add" again.`);
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
 *
 * Claude Code's option parser (verified with 2.1.326, 2026-11-18): `-e KEY=value` takes EVERY following argument as
 * another variable — it swallowed the server name ("missing required argument 'name'") and, with the name first, the
 * command after `--`; and an argument such as npx's `-y` after `--` is still rejected ("unknown option '-y'"). So each
 * variable is one `--env=KEY=value` argument, and npx's -y becomes `npm_config_yes=true` (npm reads its config from
 * npm_config_* variables). The resulting command was added and showed "Connected".
 */
export function claudeCodeCommand(entry: LaunchEntry, platform: NodeJS.Platform): string {
  const win = platform === 'win32';
  const q = (s: string) => (win ? `"${s.replace(/"/g, '\\"')}"` : `'${s.replace(/'/g, `'\\''`)}'`);
  const e = claudeCodeEntry(entry, platform);
  const envFlags = Object.entries(e.env).map(([k, v]) => q(`--env=${k}=${v}`));
  return ['claude mcp add --scope user', ...envFlags, SERVER_ENTRY_NAME, '--', q(e.command), ...e.args.map(q)].join(' ');
}

/** The entry as Claude Code stores it: forward slashes on Windows, npx's -y as npm_config_yes (see claudeCodeCommand). */
export function claudeCodeEntry(entry: LaunchEntry, platform: NodeJS.Platform): LaunchEntry {
  const fwd = (s: string) => (platform === 'win32' ? s.replace(/\\/g, '/') : s);
  const args = entry.args.filter((a) => a !== '-y');
  const env: Record<string, string> = args.length !== entry.args.length ? { npm_config_yes: 'true' } : {};
  for (const [k, v] of Object.entries(entry.env)) env[k] = fwd(v);
  return { command: fwd(entry.command), args: args.map(fwd), env, notes: entry.notes };
}

/**
 * Claude Code's USER-scope servers (every project) — the top-level "mcpServers" of ~/.claude.json, or of
 * $CLAUDE_CONFIG_DIR/.claude.json. Setup only READS this file (status, the profiles an old entry holds); changes go
 * through the claude command (`claude mcp add-json` / `remove`), because Claude Code rewrites the file while it runs.
 */
export function claudeCodeTarget(ctx: ClientContext): ClientTarget {
  const dir = ctx.env.CLAUDE_CONFIG_DIR?.trim() || ctx.home;
  return {
    id: 'claude-code',
    label: 'Claude Code',
    format: 'mcpServers',
    file: pathJoin(ctx, dir, '.claude.json'),
    detected: !!ctx.claudeCli?.(),
  };
}

/** Our entry in a JSON client file as it is now (undefined when there is none or the file cannot be read). */
export function currentJsonEntry(target: ClientTarget): unknown {
  const r = readJson(target.file);
  return ((r.data?.[containerKey(target.format)] ?? {}) as Json)[SERVER_ENTRY_NAME];
}

export interface ClaudeCli {
  /** Runs `claude <args>` without a shell (no quoting to get wrong). ok = exit code 0. */
  run(args: string[]): { ok: boolean; output: string };
}

/**
 * The claude command on PATH, run without a shell. Windows: claude.exe (the native installer), else npm's claude.cmd
 * wrapper, whose target (`"%dp0%\…\claude.exe"`, or a .js run with this Node) is read from the file — Node refuses to
 * start a .cmd without a shell. Elsewhere: the `claude` file on PATH.
 */
export function findClaudeCli(ctx: ClientContext): ClaudeCli | undefined {
  const win = ctx.platform === 'win32';
  const dirs = (ctx.env.PATH ?? ctx.env.Path ?? '').split(win ? ';' : ':').filter((d) => d.trim());
  const runner = (file: string, prefix: string[] = []): ClaudeCli => ({
    run: (args) => {
      const r = spawnSync(file, [...prefix, ...args], { encoding: 'utf8', timeout: 120_000, windowsHide: true });
      return { ok: r.status === 0, output: `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? r.error.message : ''}`.trim() };
    },
  });
  for (const dir of dirs) {
    if (!win) {
      const f = pathJoin(ctx, dir, 'claude');
      if (ctx.exists(f)) return runner(f);
      continue;
    }
    const exe = pathJoin(ctx, dir, 'claude.exe');
    if (ctx.exists(exe)) return runner(exe);
    const cmd = pathJoin(ctx, dir, 'claude.cmd');
    if (!ctx.exists(cmd)) continue;
    try {
      const m = /"%dp0%\\([^"]+\.(exe|js))"/i.exec(readFileSync(cmd, 'utf8'));
      if (!m) continue;
      const target = pathJoin(ctx, dir, ...m[1].split('\\'));
      if (!ctx.exists(target)) continue;
      return m[2].toLowerCase() === 'exe' ? runner(target) : runner(ctx.execPath, [target]);
    } catch {
      continue;
    }
  }
  return undefined;
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
  /** VS Code: the entry loads variables from this file (kept on replace; keys in it still win over the store). */
  envFile?: string;
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

/** JSON with object keys sorted — an entry another program rewrote (Claude Code puts "type" first) still compares equal. */
function stableJson(v: unknown): string {
  return JSON.stringify(v, (_k, val) =>
    val && typeof val === 'object' && !Array.isArray(val) ? Object.fromEntries(Object.entries(val as Json).sort(([a], [b]) => a.localeCompare(b))) : val
  );
}

function jsonStatus(target: ClientTarget, e: LaunchEntry): EntryStatus {
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
    upToDate: entry !== undefined && stableJson(entry) === stableJson(mergedJsonEntry(target.format, e, entry)),
    otherNames,
    envFile: entry && typeof entry === 'object' && typeof (entry as Json).envFile === 'string' ? ((entry as Json).envFile as string) : undefined,
  };
}

// Codex: TOML. Setup only ever touches its own [mcp_servers.digital-ai-testing] table (and its .env sub-table).

const CODEX_HEADER_RE = new RegExp(`^\\[mcp_servers\\.(?:"${SERVER_ENTRY_NAME}"|${SERVER_ENTRY_NAME})(?:\\.env)?\\]\\s*$`);

function tomlString(s: string): string {
  return JSON.stringify(s); // a JSON string is a valid TOML basic string for paths and simple values
}

/** Lines of an existing Codex entry that setup keeps: other keys of the main table, non-credential env variables. */
interface CodexKept {
  main: string[];
  env: string[];
}

export function codexBlock(e: LaunchEntry, kept: CodexKept = { main: [], env: [] }): string {
  const envPairs = Object.entries(e.env).map(([k, v]) => `${k} = ${tomlString(v)}`);
  return [
    `[mcp_servers.${SERVER_ENTRY_NAME}]`,
    `command = ${tomlString(e.command)}`,
    `args = [${e.args.map(tomlString).join(', ')}]`,
    ...kept.main,
    '',
    `[mcp_servers.${SERVER_ENTRY_NAME}.env]`,
    ...envPairs,
    ...kept.env,
  ].join('\n');
}

/** Variables that hold a connection (URL or key): the ones the credential store replaces. */
const CREDENTIAL_VAR_RE = /^(DIGITAL_AI_BASE_URL|DIGITAL_AI_ACCESS_KEY|DAI_PROFILE_.+_(URL|KEY))$/;

/**
 * The key = value statements of our tables, each with its continuation lines (a multi-line array or """ string),
 * so a kept setting is copied whole. Comments and blank lines are not kept.
 */
function codexKept(ours: string[], e: LaunchEntry): CodexKept {
  const kept: CodexKept = { main: [], env: [] };
  let section: 'main' | 'env' | undefined;
  let current: { key: string; lines: string[]; section: 'main' | 'env' } | undefined;
  let depth = 0;
  let inTriple = false;
  const flush = () => {
    if (!current) return;
    const text = current.lines.join('\n');
    if (current.section === 'main' && !['command', 'args', 'env'].includes(current.key)) kept.main.push(text);
    if (current.section === 'env' && !CREDENTIAL_VAR_RE.test(current.key) && !(current.key in e.env)) kept.env.push(text);
    current = undefined;
  };
  for (const line of ours) {
    if (current && (depth > 0 || inTriple)) {
      current.lines.push(line);
    } else {
      flush();
      const h = line.trim();
      if (CODEX_HEADER_RE.test(h)) {
        section = h.endsWith('.env]') ? 'env' : 'main';
        continue;
      }
      const m = /^\s*("([^"]+)"|[A-Za-z0-9_-]+)\s*=/.exec(line);
      if (!m || !section) continue;
      current = { key: m[2] ?? m[1], lines: [line.trim()], section };
      depth = 0;
      inTriple = false;
    }
    // Track open arrays / inline tables and """ strings (brackets inside ordinary strings are ignored).
    const triples = line.match(/"""|'''/g)?.length ?? 0;
    if (triples % 2 === 1) inTriple = !inTriple;
    if (triples === 0 && !inTriple) {
      const stripped = line.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""');
      depth = Math.max(0, depth + (stripped.match(/[[{]/g)?.length ?? 0) - (stripped.match(/[\]}]/g)?.length ?? 0));
    }
  }
  flush();
  return kept;
}

/**
 * Our entry as it will be written over `old`: setup's command, arguments and variables, plus everything else the old
 * entry had (other fields such as "disabled" or "timeout", and variables that are not credentials, e.g. MCP_DEBUG_MODE
 * or MCP_TOOLSETS). Credential variables and PATH are setup's to decide.
 */
export function mergedJsonEntry(format: ClientFormat, e: LaunchEntry, old: unknown): Json {
  const fresh = entryFor(format, e);
  if (!old || typeof old !== 'object' || Array.isArray(old)) return fresh;
  const envKey = format === 'opencode' ? 'environment' : 'env';
  const env: Json = { ...(fresh[envKey] as Json) };
  for (const [k, v] of Object.entries(envOf(format, old))) {
    if (!(k in env) && k !== 'PATH' && !CREDENTIAL_VAR_RE.test(k)) env[k] = v;
  }
  const out: Json = { ...fresh, [envKey]: env };
  for (const [k, v] of Object.entries(old as Json)) if (!(k in out)) out[k] = v;
  return out;
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

function codexStatus(target: ClientTarget, e: LaunchEntry): EntryStatus {
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
    upToDate: oursText === codexBlock(e, codexKept(ours, e)).trim(),
    otherNames,
  };
}

/** A connection profile written into a client's existing entry (environment variables). */
export interface EntryProfile {
  /** The name the server gives it: "default" for DIGITAL_AI_BASE_URL/ACCESS_KEY, else DAI_PROFILE_<NAME> lowercased. */
  name: string;
  url?: string;
  key?: string;
}

/** The credential variables of our entry, as strings (JSON env/environment, or Codex's .env table). */
function entryEnv(target: ClientTarget): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(target.file)) return out;
  if (target.format === 'codex-toml') {
    const { ours } = splitCodex(readFileSync(target.file, 'utf8'));
    for (const line of ours) {
      const m = /^\s*([A-Za-z0-9_]+)\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*$/.exec(line);
      if (!m) continue;
      try {
        out[m[1]] = m[2].startsWith("'") ? m[2].slice(1, -1) : (JSON.parse(m[2]) as string);
      } catch {
        // an escape TOML allows but JSON does not: leave that variable out
      }
    }
    return out;
  }
  const r = readJson(target.file);
  const container = (r.data?.[containerKey(target.format)] ?? {}) as Json;
  for (const [k, v] of Object.entries(envOf(target.format, container[SERVER_ENTRY_NAME]))) if (typeof v === 'string') out[k] = v;
  return out;
}

/**
 * The profiles our existing entry defines, read the way the server reads its environment. A profile with only a URL or
 * only a key is returned too (incomplete), so the caller can say so. Keys are returned for importing — never print them.
 */
export function entryProfiles(target: ClientTarget): EntryProfile[] {
  const env = entryEnv(target);
  const clean = (v: string | undefined) => v?.trim() || undefined;
  const out: EntryProfile[] = [];
  const defUrl = clean(env.DIGITAL_AI_BASE_URL);
  const defKey = clean(env.DIGITAL_AI_ACCESS_KEY);
  if (defUrl || defKey) out.push({ name: 'default', url: defUrl?.replace(/\/+$/, ''), key: defKey });
  const names = new Set<string>();
  for (const k of Object.keys(env)) {
    const m = /^DAI_PROFILE_(.+)_(URL|KEY)$/.exec(k);
    if (m) names.add(m[1]);
  }
  for (const raw of names) {
    const url = clean(env[`DAI_PROFILE_${raw}_URL`]);
    out.push({ name: raw.toLowerCase(), url: url?.replace(/\/+$/, ''), key: clean(env[`DAI_PROFILE_${raw}_KEY`]) });
  }
  return out;
}

export function clientStatus(target: ClientTarget, e: LaunchEntry): EntryStatus {
  return target.format === 'codex-toml' ? codexStatus(target, e) : jsonStatus(target, e);
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
      const { before, ours, after } = splitCodex(text);
      const head = before.join('\n').replace(/\s+$/, '');
      const tail = after.join('\n').replace(/^\s+/, '').replace(/\s+$/, '');
      const body = [head, codexBlock(e, codexKept(ours, e)), tail].filter((s) => s).join('\n\n') + '\n';
      const b = backup(target.file);
      mkdirSync(dirname(target.file), { recursive: true });
      writeFileSync(target.file, body, 'utf8');
      return { ok: true, backup: b };
    }
    const r = readJson(target.file);
    if (r.error || !r.data) return { ok: false, error: `${target.file}: ${r.error}` };
    const key = containerKey(target.format);
    const container = (r.data[key] && typeof r.data[key] === 'object' ? r.data[key] : {}) as Json;
    container[SERVER_ENTRY_NAME] = mergedJsonEntry(target.format, e, container[SERVER_ENTRY_NAME]);
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
