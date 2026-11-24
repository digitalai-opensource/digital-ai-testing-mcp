/**
 * `digital-ai-testing-mcp setup …` — manages the local credential store (src/utils/credential-store.ts) from a terminal.
 * src/index.ts runs this instead of the server when the first argument is `setup`.
 *
 * The access key is typed at a hidden prompt, or piped with --key-stdin; it is never a command-line argument (those end
 * up in shell history and process lists) and is never printed. Every key is checked against the API before it is saved
 * unless --skip-check is given. Keys go to the OS keychain by default; --plain-file keeps one in profiles.json.
 *
 * All terminal I/O goes through SetupIO so tests can drive the command without a terminal.
 */
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline';
import { verifyCredential, type CredentialCheck } from '../api/access-level.js';
import { isKnownNotCloudAdmin, type AccessInfo } from '../utils/access-level.js';
import {
  deleteKeyFromKeychain,
  deleteStoreFiles,
  getKeychain,
  findRawProfileName,
  isStoreEnabled,
  KEYCHAIN_SERVICE,
  keychainAccount,
  PROFILE_NAME_RE,
  readStore,
  readReportDirSetting,
  readStoreFileRaw,
  restoreStoreBackup,
  saveKeyToKeychain,
  storePath,
  validUrl,
  writeStore,
  type RawStoreFile,
} from '../utils/credential-store.js';
import { accessSync, constants as fsConstants, existsSync, mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { getServerVersion } from '../utils/version.js';
import { getDeploymentMode, runningInContainer } from '../utils/deployment-mode.js';
import { installKind } from '../utils/update-check.js';
import { redact } from '../utils/remediation.js';
import { credentialEnvPresence } from '../utils/profile-loader.js';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import * as ui from './ui.js';
import {
  buildLaunchEntry,
  claudeCodeCommand,
  claudeCodeEntry,
  claudeCodeTarget,
  claudeCodeProjectOverrides,
  currentJsonEntry,
  mergedJsonEntry,
  clientStatus,
  defaultClientContext,
  entryEnv,
  entryProfiles,
  type EntryProfile,
  knownClients,
  manualClients,
  pasteSnippet,
  removeClientEntry,
  writeClientEntry,
  SERVER_ENTRY_NAME,
  setupCommand,
  type ClientContext,
  type ClientTarget,
  type LaunchEntry,
} from './clients.js';

export interface SetupIO {
  out(text: string): void;
  err(text: string): void;
  /** A visible answer. */
  ask(question: string): Promise<string>;
  /** A hidden answer (nothing is echoed). */
  askSecret(question: string): Promise<string>;
  /** Everything piped to stdin (for --key-stdin). */
  readStdin(): Promise<string>;
  /** stdin is a terminal — prompts are possible. */
  interactive: boolean;
  /** Credential check; tests replace it with a stub. */
  verify(url: string, key: string): Promise<CredentialCheck>;
  /** Where AI-client configuration files are looked for; tests point it at temp folders. */
  clients?: ClientContext;
}

const USAGE = `Manage the Digital.ai Testing connection profiles this MCP server can use.

Usage: digital-ai-testing-mcp setup [command] [options]

Commands:
  (none)              Add a profile, step by step (in a terminal)
  add [name]          Add a profile, or replace one with the same name
  list                Show the profiles and where their keys are kept
  default <name>      Make <name> the profile the server starts on
  remove <name>       Delete a profile (and its key in the OS keychain)
  test [name]         Check one profile, or all, against the API
  doctor              A report for support: install, profiles, keychain and AI clients (never a key)
  path                Show where the profiles file is
  reports [folder|off]  Show or set the folder finished reports are saved to (fast, no rewriting by the AI)
  repair              Restore the profiles file from its backup
  reset               Delete the profiles file, its backups and the keys it keeps in the OS keychain
  clients             Show which AI clients are set up to start this server
  clients add [client…]     Add the server to AI clients (every one installed, or the ones named)
  clients remove [client…]  Remove it from AI clients
  help                Show this help

Options for add:
  --url <url>         Your Digital.ai Testing URL, e.g. https://yourcompany.experitest.com
  --key-stdin         Read the access key from stdin (for scripts) instead of a hidden prompt
  --plain-file        Keep the key in the profiles file instead of the OS keychain
  --default           Make it the profile the server starts on
  --skip-check        Save without checking the key against the API
Options for clients add:
  --config <file>     The config file to edit, for ONE named client (Claude Desktop on Windows, when setup cannot tell)
Options for doctor:
  --offline           Skip checking each profile against the API
Options for every command:
  --yes, -y           Answer yes to confirmations (replace, remove, repair, reset)

The access key is in the Digital.ai Testing portal: click your name (top right) → Access Key.
Environment variables in an AI client's configuration (DIGITAL_AI_BASE_URL, DIGITAL_AI_ACCESS_KEY, DAI_PROFILE_*)
always take precedence over these profiles.`;

// Measured 2026-11-23 in Claude Desktop: without a folder the AI writes a 20 KB report out itself (~1 min, ~6k output
// tokens); with one the server saves it in seconds. Desktop's agent can only link a file in a folder added to the task.
const REPORT_DIR_WHY = 'Reports (create_report, render_report) are saved there in seconds instead of the AI writing each one out (about a minute and ~6,000 tokens per report).';
const REPORT_DIR_DESKTOP = 'Claude Desktop: also add this folder to a conversation ("Add folder") to get a link to each report in the chat.';

const RESTART = 'Restart your AI client, or reconnect the digital-ai-testing MCP server, to use the change.';
const PASTE_HINT = 'Ctrl+V does not paste in this window: right-click to paste, then press Enter.';

class SetupError extends Error {
  constructor(message: string, readonly code = 1) {
    super(message);
  }
}

// ─── Default terminal I/O ─────────────────────────────────────────────────────

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(ui.prompt(question), (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function askSecret(question: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) return ask(question);
  question = ui.prompt(question);
  process.stderr.write(question);
  return new Promise((resolve) => {
    let value = '';
    let pasteHintShown = false;
    const finish = () => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write('\n');
    };
    const onData = (chunk: Buffer | string) => {
      for (const ch of chunk.toString('utf8')) {
        if (ch === '\r' || ch === '\n') {
          finish();
          return resolve(value.trim());
        }
        if (ch === '\u0003') {
          finish();
          process.exit(130); // Ctrl+C
        }
        if (ch === '\u0016') {
          // Ctrl+V reaches a raw-mode prompt as a control character in the classic console window (Windows
          // PowerShell 5.1, cmd) — it does not paste there. Windows Terminal pastes it as text. Seen live 2026-11-19.
          if (!pasteHintShown) process.stderr.write(`\n${ui.yellow(PASTE_HINT)}\n${question}`);
          pasteHintShown = true;
        } else if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else if (ch >= ' ') value += ch;
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c)));
  return Buffer.concat(chunks).toString('utf8').trim();
}

export function terminalIO(): SetupIO {
  // Colors only when the output is a terminal: `setup doctor > report.txt` stays plain text.
  const color = ui.colorWanted(process.stdout);
  ui.setColor(color);
  // Word wrapping only together with color: without color a command cannot be told from prose, and a command must
  // never be broken across lines.
  ui.setWidth(color ? process.stdout.columns : 0);
  const show = (t: string) => t.split('\n').map(ui.wrap).join('\n') + '\n';
  return {
    out: (t) => void process.stdout.write(show(t)),
    err: (t) => void process.stderr.write(show(t)),
    ask,
    askSecret,
    readStdin,
    interactive: Boolean(process.stdin.isTTY),
    verify: verifyCredential,
    clients: defaultClientContext(),
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function confirm(io: SetupIO, yes: boolean, question: string, nonInteractiveHint: string): Promise<boolean> {
  if (yes) return true;
  if (!io.interactive) throw new SetupError(`${question.replace(/\s*\[y\/N\]\s*$/, '')} — not in a terminal, so nothing was changed. ${nonInteractiveHint}`, 2);
  return /^y(es)?$/i.test(await io.ask(question));
}

/** What to do about an unreadable profiles file: offer repair only when there is a backup to restore. */
function brokenFileFix(): string {
  return existsSync(`${storePath()}.bak`)
    ? `fix it in a text editor, or run "${setupCommand()} repair" to restore the last version setup saved`
    : `fix it in a text editor (there is no backup to restore), or start over with "${setupCommand()} reset"`;
}

const capital = (t: string) => t[0].toUpperCase() + t.slice(1);

function loadForEdit(): RawStoreFile {
  const raw = readStoreFileRaw();
  if (!raw.data) {
    throw new SetupError(`The profiles file ${storePath()} cannot be changed: ${raw.error}.\n${capital(brokenFileFix())}.`);
  }
  return raw.data;
}

function normalizeName(name: string): string {
  const n = name.trim().toLowerCase();
  if (!PROFILE_NAME_RE.test(n)) throw new SetupError(`"${name}" is not a valid profile name: use letters, digits, "_" and "-" (up to 64).`, 2);
  return n;
}

function suggestName(check: CredentialCheck | undefined): string {
  if (check?.ok && check.info.level === 'cloud-admin') return 'admin';
  const project = check?.ok ? check.info.projectName : undefined;
  const slug = project?.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
  return slug && PROFILE_NAME_RE.test(slug) ? slug : 'main';
}

const URL_HINT = 'Enter the address you open the Digital.ai Testing portal with, e.g. https://yourcompany.experitest.com';

/** What a person typed as the URL → a normalized http(s) URL, or null. "host.com" gets https://; spaces never pass. */
function parseUrlInput(typed: string): string | null {
  const t = typed.trim();
  if (!t || /\s/.test(t)) return null;
  return validUrl(/^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t}`);
}

/** A person-facing role line ("Project Admin of project "X""), not the agent-facing describeLevel wording. */
function roleLine(info: AccessInfo): string {
  const project = info.projectName ? ` of project "${info.projectName}"` : '';
  switch (info.level) {
    case 'cloud-admin':
      return 'Cloud Admin';
    case 'project-admin':
      return `Project Admin${project}`;
    case 'project-user':
      return `Project User${project}`;
    case 'project-limited':
      return `project-level access${project}`;
    default:
      return 'key accepted (access level not determined)';
  }
}

/** Profile names switch_environment treats as a Cloud Admin request (the exact name wins over the alias). */
const ADMIN_ALIAS_NAMES = ['admin', 'cloud', 'cloudadmin', 'cloud-admin', 'cloud_admin'];

function describeCheck(check: CredentialCheck, url: string): string {
  if (check.ok) return roleLine(check.info);
  switch (check.problem) {
    case 'rejected':
      return `the access key was refused (HTTP ${check.status}). Copy it again from the portal: your name (top right) → Access Key`;
    case 'unreachable':
      return `${url} could not be reached. Check the URL and your network or VPN`;
    case 'not-api':
      return `${url} answered${check.status ? ` (HTTP ${check.status})` : ''}, but not as the Digital.ai Testing API. Check the URL — it is the address you open the portal with`;
  }
}

function storeOffNote(io: SetupIO) {
  if (!isStoreEnabled()) io.err('Note: MCP_CREDENTIAL_STORE is set to off in this shell. A server started with that setting ignores these profiles.');
}

// ─── Commands ─────────────────────────────────────────────────────────────────

interface Flags {
  url?: string;
  'key-stdin'?: boolean;
  offline?: boolean;
  'plain-file'?: boolean;
  default?: boolean;
  'skip-check'?: boolean;
  config?: string;
  yes?: boolean;
}

async function cmdAdd(io: SetupIO, nameArg: string | undefined, flags: Flags) {
  const data = loadForEdit();
  storeOffNote(io);

  // In a terminal: numbered steps with space between them (feedback 2026-11-20: the output ran together and was hard to
  // read). Step 3 only when there are AI clients to offer.
  const guided = io.interactive && !flags['key-stdin'];
  const clientsToOffer = io.interactive && !flags.yes ? pendingClients(io) : undefined;
  const steps = clientsToOffer ? 3 : 2;
  if (guided) {
    io.out('');
    io.out(ui.bold('Digital.ai Testing MCP setup'));
    io.out('');
    io.out(ui.step(1, steps, 'Connect to Digital.ai Testing'));
    io.out(ui.gray('  The URL is the address you open the portal with. The access key is in the portal: your name (top right) → Access Key.'));
  }

  // URL
  let url: string | null;
  if (flags.url) {
    url = parseUrlInput(flags.url);
    if (!url) throw new SetupError(`"${flags.url}" is not a URL. ${URL_HINT}`, 2);
  } else {
    if (!io.interactive) throw new SetupError('No URL: pass --url when not running in a terminal.', 2);
    // In a terminal a typo is asked again (a few times) instead of ending the command.
    url = null;
    for (let attempt = 1; !url; attempt++) {
      const typed = await io.ask('Digital.ai Testing URL (e.g. https://yourcompany.experitest.com): ');
      url = parseUrlInput(typed);
      if (url) break;
      if (attempt === 3) throw new SetupError(`"${typed}" is not a URL. Nothing was saved. ${URL_HINT}`, 2);
      io.err(`"${typed}" is not a URL. ${URL_HINT}`);
    }
  }

  // Key
  let key: string;
  if (flags['key-stdin']) key = await io.readStdin();
  else if (io.interactive) {
    key = await io.askSecret('Access key (input hidden): ');
    for (let attempt = 1; !key && attempt < 3; attempt++) {
      io.err('No access key was entered. In a Windows PowerShell or Command Prompt window, Ctrl+V does not paste: right-click to paste, then press Enter.');
      key = await io.askSecret('Access key (input hidden): ');
    }
  } else throw new SetupError('No access key: pass --key-stdin and pipe the key in when not running in a terminal.', 2);
  if (!key) throw new SetupError('No access key was entered. Nothing was saved.', 2);

  // Check
  let check: CredentialCheck | undefined;
  if (!flags['skip-check']) {
    io.out(`Checking the key with ${url} …`);
    check = await io.verify(url, key);
    if (!check.ok) {
      throw new SetupError(`Not saved: ${describeCheck(check, url)}.` + (check.problem === 'unreachable' ? ' To save it anyway, add --skip-check.' : ''));
    }
    io.out(`${ui.green('OK')} — ${describeCheck(check, url)}.`);
  }

  if (guided) {
    io.out('');
    io.out(ui.step(2, steps, 'Save it as a profile'));
  }

  // Name
  let name = nameArg;
  if (!name) {
    const suggested = suggestName(check);
    name = io.interactive ? (await io.ask(`Profile name [${suggested}]: `)) || suggested : suggested;
  }
  name = normalizeName(name);
  const existing = findRawProfileName(data, name);
  if (existing && !(await confirm(io, !!flags.yes, `A profile named "${name}" exists. Replace it? [y/N] `, 'Add --yes to replace it.'))) {
    throw new SetupError('Nothing was changed.', 1);
  }
  const previous = existing ? data.profiles[existing] : undefined;
  if (existing) delete data.profiles[existing];

  // Key location
  let keyLocation: 'os' | 'file' = flags['plain-file'] ? 'file' : 'os';
  if (keyLocation === 'os') {
    const saved = saveKeyToKeychain(name, key);
    if (!saved.ok) {
      io.err(`The OS keychain could not store the key: ${saved.error}.`);
      const fallback = await confirm(
        io,
        false,
        'Keep the key in the profiles file instead (readable by your user account only)? [y/N] ',
        'Add --plain-file to keep the key in the profiles file.'
      );
      if (!fallback) throw new SetupError('Nothing was saved.', 1);
      keyLocation = 'file';
    }
  }
  data.profiles[name] = keyLocation === 'os' ? { url, keyStore: 'os' } : { url, key };

  // Default
  const currentDefault = typeof data.default === 'string' ? data.default.trim().toLowerCase() : undefined;
  const defaultExists = !!currentDefault && !!findRawProfileName(data, currentDefault);
  let makeDefault = !!flags.default || !defaultExists || currentDefault === name;
  if (!makeDefault && io.interactive && !flags.yes) {
    makeDefault = /^y(es)?$/i.test(await io.ask(`Make "${name}" the profile the server starts on (now "${currentDefault}")? [y/N] `));
  }
  if (makeDefault) data.default = name;

  const path = writeStore(data);
  // Moved from the keychain to the file: remove the old keychain copy — only now that the file holds the key.
  if (keyLocation === 'file' && previous?.keyStore === 'os') deleteKeyFromKeychain(name);

  // Read back through the same code the server uses — proves the key is retrievable where it was put.
  const back = readStore();
  if (!back.profiles[name]) {
    const why = back.skipped.find((s) => s.name === name)?.reason ?? back.error ?? 'unknown reason';
    throw new SetupError(`The profile was written to ${path}, but reading it back failed: ${why}.`);
  }
  // One short line, then aligned details: the long "key in … (service …, account …)" sentence was the hardest to read.
  io.out(`${ui.green('Saved')} profile "${name}" (${url}).`);
  io.out(
    `  Key:      ${keyLocation === 'os' ? `the OS keychain ${ui.gray(`(service "${KEYCHAIN_SERVICE}", account "${keychainAccount(name)}")`)}` : 'the profiles file'}`
  );
  io.out(`  File:     ${ui.gray(path)}`);
  io.out(
    `  Default:  ${makeDefault ? `yes — the server starts on "${name}"` : `no — the server still starts on "${currentDefault}"; switch with switch_environment("${name}")`}`
  );
  // A Cloud-Admin-sounding name on a project key: "switch to admin" would land here, not on a Cloud Admin profile.
  if (check?.ok && isKnownNotCloudAdmin(check.info.level) && ADMIN_ALIAS_NAMES.includes(name)) {
    io.out(
      ui.yellow(`Note: "${name}" holds a ${roleLine(check.info).split(' of ')[0]} key. switch_environment("${name}") always picks this `) +
        ui.yellow('profile; ask for "cloud admin" to reach a Cloud Admin profile.')
    );
  }
  io.out(ui.gray('  If an AI client\'s configuration sets DIGITAL_AI_BASE_URL / DIGITAL_AI_ACCESS_KEY, those still win — remove them to use these profiles.'));
  if (guided && !flags.yes) await askReportDir(io);
  if (clientsToOffer) {
    io.out('');
    io.out(ui.step(3, steps, 'Add the server to your AI clients'));
    await offerClients(io, clientsToOffer);
  }
  if (guided) io.out('');
  restartNote(io);
}

/**
 * "Restart your AI client" only when one runs this server: on a machine with none set up it read as a step to do
 * (Windows Sandbox run 2026-11-19). Without any, it points to "setup clients add" instead.
 */
function restartNote(io: SetupIO) {
  const ctx = io.clients ?? defaultClientContext();
  const entry = buildLaunchEntry(ctx);
  const claude = claudeCodeTarget(ctx);
  const setUp =
    knownClients(ctx).some((t) => t.detected && !t.choices && clientStatus(t, entry).hasEntry) ||
    (claude.detected && clientStatus(claude, claudeCodeEntry(entry, ctx.platform)).hasEntry);
  if (setUp) io.out(ui.bold(RESTART));
  else {
    io.out('No AI client runs the server yet. Add it with:');
    io.out(`  ${ui.command(`${setupCommand()} clients add`)}`);
  }
}

/** "~/x" → the home folder; a relative path is refused (the server's start folder is not the user's). */
function reportDirInput(typed: string): string | null {
  const t = typed.trim().replace(/^["']|["']$/g, '');
  if (!t) return null;
  const expanded = t === '~' || /^~[\\/]/.test(t) ? join(homedir(), t.slice(1)) : t;
  return isAbsolute(expanded) ? resolve(expanded) : null;
}

/** Creates the folder, checks it can be written, saves it as reportDir. Throws SetupError with the reason. */
function saveReportDir(folder: string): string {
  try {
    mkdirSync(folder, { recursive: true });
    accessSync(folder, fsConstants.W_OK);
  } catch (e) {
    throw new SetupError(`The folder ${folder} cannot be used: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}. Nothing was changed.`);
  }
  const data = loadForEdit();
  data.reportDir = folder;
  writeStore(data);
  return folder;
}

function reportDirSavedLines(io: SetupIO, folder: string) {
  io.out(`${ui.green('Saved')} the report folder: ${folder}`);
  io.out(ui.gray(`  ${REPORT_DIR_WHY}`));
  io.out(ui.gray(`  ${REPORT_DIR_DESKTOP}`));
  if (process.env.MCP_REPORT_DIR?.trim()) io.out(ui.yellow(`  MCP_REPORT_DIR is set here (${process.env.MCP_REPORT_DIR.trim()}); where a client sets it, it wins over this folder.`));
}

/** Step 2 of the guided add: offer a report folder when none is set (MCP_REPORT_DIR in this terminal is suggested). */
async function askReportDir(io: SetupIO) {
  const current = readReportDirSetting();
  if (current.dir || current.error) return;
  const suggested = process.env.MCP_REPORT_DIR?.trim() ? reportDirInput(process.env.MCP_REPORT_DIR) : null;
  io.out('');
  io.out(`Optional: a folder for reports. ${REPORT_DIR_WHY}`);
  for (let attempt = 1; attempt <= 3; attempt++) {
    const typed = await io.ask(suggested ? `Report folder [${suggested}] (type "skip" to skip): ` : 'Report folder (full path; Enter to skip): ');
    if (/^skip$/i.test(typed.trim()) || (!typed.trim() && !suggested)) {
      io.out(ui.gray(`  Skipped. Set one later with: ${setupCommand()} reports <folder>`));
      return;
    }
    const folder = typed.trim() ? reportDirInput(typed) : suggested;
    if (!folder) {
      io.err(`"${typed}" is not a full folder path (for example ${process.platform === 'win32' ? 'C:\\Users\\you\\Reports' : '~/Reports'}).`);
      continue;
    }
    try {
      reportDirSavedLines(io, saveReportDir(folder));
    } catch (e) {
      io.err((e as Error).message);
      continue;
    }
    return;
  }
  io.out(ui.gray(`  Skipped. Set one later with: ${setupCommand()} reports <folder>`));
}

function cmdReports(io: SetupIO, arg: string | undefined) {
  storeOffNote(io);
  if (!arg) {
    const current = readReportDirSetting();
    const env = process.env.MCP_REPORT_DIR?.trim();
    if (current.error) io.out(`${ui.red('The report folder setting cannot be used:')} ${current.error}.`);
    else if (current.dir) io.out(`Report folder: ${current.dir}`);
    else io.out(`No report folder is set. Set one with: ${ui.command(`${setupCommand()} reports <folder>`)}`);
    io.out(ui.gray(`  ${REPORT_DIR_WHY}`));
    io.out(ui.gray(`  ${REPORT_DIR_DESKTOP}`));
    if (env) io.out(ui.yellow(`  MCP_REPORT_DIR is set in this terminal (${env}); where a client's configuration sets it, it wins.`));
    return;
  }
  if (/^(off|none|clear)$/i.test(arg)) {
    const data = loadForEdit();
    if (data.reportDir === undefined) {
      io.out('No report folder was set.');
      return;
    }
    delete data.reportDir;
    writeStore(data);
    io.out(`${ui.green('Removed')} the report folder. Reports go to a temporary folder, and the AI writes them out where it cannot copy them.`);
    return;
  }
  const folder = reportDirInput(arg);
  if (!folder) throw new SetupError(`"${arg}" is not a full folder path. Nothing was changed.`, 2);
  reportDirSavedLines(io, saveReportDir(folder));
}

/**
 * A client entry about to be replaced sets MCP_REPORT_DIR: keep it as the report folder for every client (user request
 * 2026-11-23: "copy it if it's already been set"). Only when none is set; never fails the client step.
 */
function adoptEntryReportDir(io: SetupIO, t: ClientTarget) {
  const v = entryEnv(t).MCP_REPORT_DIR?.trim();
  if (!v || !isAbsolute(v)) return;
  const current = readReportDirSetting();
  if (current.dir || current.error) return;
  try {
    const data = loadForEdit();
    data.reportDir = v;
    writeStore(data);
    io.out(`${t.label}'s entry sets MCP_REPORT_DIR=${v}: saved it as the report folder for every AI client (${setupCommand()} reports to change it).`);
  } catch {
    // An unreadable profiles file: the profile import step already said how to fix it.
  }
}

function cmdList(io: SetupIO) {
  const path = storePath();
  storeOffNote(io);
  const raw = readStoreFileRaw();
  if (!raw.exists) {
    io.out(`No profiles yet (${path} does not exist). Add one with: ${ui.command(setupCommand())}`);
    return;
  }
  io.out(`${ui.bold('Profiles file:')} ${ui.gray(path)}`);
  if (!raw.data) {
    io.out(`${ui.red('It cannot be used:')} ${raw.error}. ${capital(brokenFileFix())}.`);
    return;
  }
  const store = readStore();
  const names = Object.keys(raw.data.profiles);
  if (names.length === 0) io.out(`No profiles in it. Add one with: ${ui.command(setupCommand())}`);
  for (const rawName of names) {
    const n = rawName.trim().toLowerCase();
    const ok = store.profiles[n];
    const isDefault = store.defaultProfile === n;
    const where = ok ? (ok.keyStore === 'os' ? 'key in the OS keychain' : 'key in this file') : '';
    const problem = store.skipped.find((s) => s.name === rawName || s.name === n)?.reason;
    io.out(
      `  ${ui.bold(rawName)}${isDefault ? ui.green(' (default)') : ''}: ${ok ? `${ok.url} ${ui.gray(`— ${where}`)}` : `${ui.red('NOT USABLE')} — ${problem ?? 'unknown reason'}`}`
    );
  }
  const defaultProblem = store.skipped.find((s) => s.name === '(default)');
  if (defaultProblem) io.out(`  ${ui.red('Default:')} ${defaultProblem.reason}. Fix with: ${ui.command(`${setupCommand()} default <name>`)}`);
}

function cmdDefault(io: SetupIO, nameArg: string | undefined) {
  if (!nameArg) throw new SetupError('Which profile? Usage: digital-ai-testing-mcp setup default <name>', 2);
  const data = loadForEdit();
  const name = normalizeName(nameArg);
  if (!findRawProfileName(data, name)) throw new SetupError(`There is no profile named "${name}". See: ${setupCommand()} list`);
  data.default = name;
  writeStore(data);
  const usable = readStore().profiles[name];
  io.out(`The server now starts on "${name}".`);
  if (!usable) io.err(`Warning: "${name}" is not usable at the moment — see: ${setupCommand()} list`);
  restartNote(io);
}

async function cmdRemove(io: SetupIO, nameArg: string | undefined, flags: Flags) {
  if (!nameArg) throw new SetupError('Which profile? Usage: digital-ai-testing-mcp setup remove <name>', 2);
  const data = loadForEdit();
  const name = normalizeName(nameArg);
  const existing = findRawProfileName(data, name);
  if (!existing) throw new SetupError(`There is no profile named "${name}". See: ${setupCommand()} list`);
  if (!(await confirm(io, !!flags.yes, `Remove profile "${name}"? [y/N] `, 'Add --yes to remove it.'))) throw new SetupError('Nothing was changed.', 1);

  const entry = data.profiles[existing];
  delete data.profiles[existing];
  const wasDefault = typeof data.default === 'string' && data.default.trim().toLowerCase() === name;
  if (wasDefault) delete data.default;
  writeStore(data);
  io.out(`Removed profile "${name}".`);
  // The raw file keeps broken entries (null, a string…) — removing one is how a user gets rid of it.
  if ((entry as { keyStore?: unknown } | null | undefined)?.keyStore === 'os') {
    const del = deleteKeyFromKeychain(name);
    if (!del.ok) io.err(`Its key could not be removed from the OS keychain: ${del.error}. Remove "${KEYCHAIN_SERVICE}" / "${keychainAccount(name)}" there by hand.`);
    else if (del.existed) io.out('Its key was removed from the OS keychain.');
  }
  if (wasDefault) {
    const left = Object.keys(data.profiles);
    io.out(
      left.length === 1
        ? `It was the default; the server now starts on the only profile left, "${left[0]}".`
        : left.length === 0
          ? 'It was the last profile.'
          : `It was the default. Choose another: ${setupCommand()} default <name> (${left.join(', ')})`
    );
  }
  restartNote(io);
}

/**
 * One report for a support ticket: install, deployment mode, credential variables in this terminal (names only),
 * the credential store (each profile checked against the API unless --offline), the OS keychain, and every AI client.
 * Everything goes through redact() as a safety net; no key is ever printed in the first place. Exit 1 when a check
 * failed, so scripts can use it.
 */
async function cmdDoctor(io: SetupIO, flags: Flags): Promise<boolean> {
  const lines: string[] = [];
  const say = (s = '') => lines.push(s);
  let problems = 0;

  say('Digital.ai Testing MCP — setup doctor (safe to share: it never contains an access key)');
  say(`Version ${getServerVersion()} · Node ${process.version} (${process.execPath}) · ${process.platform} ${process.arch} · install: ${installKind()}`);
  const modeVar = process.env.MCP_DEPLOYMENT_MODE?.trim();
  say(`Deployment mode: ${getDeploymentMode()} (MCP_DEPLOYMENT_MODE ${modeVar ? `= ${modeVar}` : `not set; ${runningInContainer() ? 'in a container' : 'not in a container'}`})`);

  say('');
  say('This terminal\'s environment (an AI client starts the server with ITS OWN, from its configuration):');
  const env = credentialEnvPresence();
  say(`  DIGITAL_AI_BASE_URL: ${env.baseUrl ?? 'not set'} · DIGITAL_AI_ACCESS_KEY: ${env.accessKeySet ? 'set' : 'not set'}`);
  say(`  DAI_PROFILE_* profiles: ${env.namedProfiles.length ? env.namedProfiles.join(', ') : 'none'}`);
  const settings = Object.keys(process.env).filter((k) => /^MCP_/.test(k) && !/(KEY|TOKEN|SECRET|PASSWORD)/i.test(k)).sort();
  say(`  MCP_* settings: ${settings.length ? settings.map((k) => `${k}=${process.env[k]}`).join(' ') : 'none'}`);

  say('');
  const store = readStore();
  const keychain = getKeychain();
  say(`Credential store: ${store.path}${store.enabled ? (store.exists ? '' : ' (no file yet)') : ' — turned off (MCP_CREDENTIAL_STORE)'}`);
  say(`  OS keychain: ${keychain.keychain ? 'available' : `NOT available — ${keychain.error}`}`);
  if (store.error) {
    say(`  PROBLEM: the file cannot be used — ${store.error}. Fix: ${brokenFileFix()}.`);
    problems++;
  }
  for (const [name, p] of Object.entries(store.profiles)) {
    const where = p.keyStore === 'os' ? 'key in the OS keychain' : 'key in the file';
    const isDefault = store.defaultProfile === name ? ' (default)' : '';
    if (flags.offline) {
      say(`  ${name}${isDefault}: ${p.url} — ${where}`);
      continue;
    }
    const check = await io.verify(p.url, p.key);
    if (!check.ok) problems++;
    say(`  ${name}${isDefault}: ${p.url} — ${where} — ${check.ok ? 'OK' : 'FAILED'}: ${describeCheck(check, p.url)}`);
  }
  for (const s of store.skipped) {
    say(`  PROBLEM ${s.name}: ${s.reason}`);
    problems++;
  }
  const reportDir = readReportDirSetting();
  say(`  Report folder: ${reportDir.dir ?? (reportDir.error ? `PROBLEM — ${reportDir.error}` : `not set (reports are written out by the AI where it cannot copy them; ${setupCommand()} reports <folder>)`)}`);
  if (reportDir.error) problems++;
  if (store.enabled && store.exists && !store.error && Object.keys(store.profiles).length > 1 && !store.defaultProfile) {
    say(`  PROBLEM: several profiles and no default — fix: ${setupCommand()} default <name>`);
    problems++;
  }

  say('');
  const ctx = io.clients ?? defaultClientContext();
  const entry = buildLaunchEntry(ctx);
  say('AI clients:');
  say(`  Entry setup writes: ${entry.command} ${entry.args.join(' ')}`);
  for (const n of entry.notes) say(`  Note: ${n}`);
  for (const t of knownClients(ctx)) {
    say(`  ${t.id.padEnd(22)} ${statusLine(t, entry)}${t.detected && !t.choices ? ` — ${t.file}` : ''}`);
  }
  say(`  ${'claude-code'.padEnd(22)} ${claudeStatusLine(ctx, entry, false)}${claudeCodeTarget(ctx).detected ? ` — ${claudeCodeTarget(ctx).file} (user scope)` : ''}`);
  for (const l of overrideLines(ctx)) say(l);
  say('');
  say(problems ? `${problems} problem${problems === 1 ? '' : 's'} found (marked PROBLEM or FAILED above).` : 'No problems found.');

  for (const l of lines) io.out(redact(l));
  return problems === 0;
}

async function cmdTest(io: SetupIO, nameArg: string | undefined) {
  const store = readStore();
  if (store.error) throw new SetupError(`The profiles file ${store.path} cannot be used: ${store.error}.`);
  const wanted = nameArg ? normalizeName(nameArg) : undefined;
  const names = wanted ? [wanted] : Object.keys(store.profiles);
  if (names.length === 0 && store.skipped.length === 0) {
    io.out(`No profiles to check. Add one with: ${ui.command(setupCommand())}`);
    return;
  }
  let failed = 0;
  for (const n of names) {
    const p = store.profiles[n];
    if (!p) {
      const reason = store.skipped.find((s) => s.name.toLowerCase() === n)?.reason;
      if (!reason && wanted) throw new SetupError(`There is no profile named "${n}". See: ${setupCommand()} list`);
      io.out(`  ${ui.bold(n)}: ${ui.red('NOT USABLE')} — ${reason}`);
      failed++;
      continue;
    }
    const check = await io.verify(p.url, p.key);
    io.out(`  ${ui.bold(n)}: ${check.ok ? ui.green('OK') : ui.red('FAILED')} — ${describeCheck(check, p.url)}`);
    if (!check.ok) failed++;
  }
  if (!wanted) {
    for (const s of store.skipped.filter((s) => s.name !== '(default)')) {
      io.out(`  ${ui.bold(s.name)}: ${ui.red('NOT USABLE')} — ${s.reason}`);
      failed++;
    }
  }
  if (failed > 0) throw new SetupError(`${failed} profile${failed === 1 ? '' : 's'} failed.`, 1);
}

function cmdPath(io: SetupIO) {
  const path = storePath();
  io.out(path);
  if (!existsSync(path)) io.err('(The file does not exist yet.)');
}

async function cmdRepair(io: SetupIO, flags: Flags) {
  const path = storePath();
  if (!existsSync(`${path}.bak`)) throw new SetupError(`There is no backup to restore (${path}.bak).`);
  if (!(await confirm(io, !!flags.yes, `Replace ${path} with its backup? [y/N] `, 'Add --yes to restore it.'))) throw new SetupError('Nothing was changed.', 1);
  const r = restoreStoreBackup();
  if (!r.ok) throw new SetupError(`Not restored: ${r.error}.`);
  io.out(`Restored the profiles file from its backup.${r.keptAs ? ` The replaced file is kept as ${r.keptAs}.` : ''}`);
  io.out(`Keys in the OS keychain are not affected. Check the result with: ${setupCommand()} list`);
  restartNote(io);
}

async function cmdReset(io: SetupIO, flags: Flags) {
  const raw = readStoreFileRaw();
  const path = storePath();
  if (!raw.exists && !existsSync(`${path}.bak`)) {
    io.out('There is nothing to reset.');
    return;
  }
  if (!(await confirm(io, !!flags.yes, 'Delete every profile, the profiles file and its backups, and the keys it keeps in the OS keychain? [y/N] ', 'Add --yes to reset.'))) {
    throw new SetupError('Nothing was changed.', 1);
  }
  const keychainNames = raw.data
    ? Object.entries(raw.data.profiles).filter(([, p]) => p?.keyStore === 'os').map(([n]) => n.trim().toLowerCase())
    : [];
  for (const n of keychainNames) {
    const del = deleteKeyFromKeychain(n);
    if (!del.ok) io.err(`The key of "${n}" could not be removed from the OS keychain: ${del.error}. Remove "${KEYCHAIN_SERVICE}" / "${keychainAccount(n)}" there by hand.`);
  }
  const removed = deleteStoreFiles();
  io.out(`Removed ${removed.length} file${removed.length === 1 ? '' : 's'}${keychainNames.length ? ` and ${keychainNames.length} OS keychain entr${keychainNames.length === 1 ? 'y' : 'ies'}` : ''}.`);
  if (!raw.data && raw.exists) io.err('The profiles file could not be read, so keys it kept in the OS keychain (if any) were not removed.');
  restartNote(io);
}

// ─── AI clients ───────────────────────────────────────────────────────────────

const RESTART_CLIENTS = 'Restart the AI clients you changed (or reconnect the server in them) to use the change.';

function describeEntry(io: SetupIO, entry: LaunchEntry) {
  io.out(`${ui.bold(`The "${SERVER_ENTRY_NAME}" entry setup writes`)} ${ui.gray('(no access key in it — the server reads the credential store)')}`);
  io.out(ui.gray(`  ${entry.command} ${entry.args.join(' ')}`));
  for (const n of entry.notes) io.out(ui.gray(`  Note: ${n}`));
}

/** "path (modified 2026-11-17 18:50)" for each candidate file, or "path (no file yet)". */
function describeChoices(files: string[]): string {
  return files
    .map((f) => {
      try {
        return `${f} (modified ${statSync(f).mtime.toISOString().slice(0, 16).replace('T', ' ')})`;
      } catch {
        return `${f} (no file yet)`;
      }
    })
    .join('; ');
}

const CHOOSE_HINT = (t: ClientTarget) =>
  `Claude Desktop keeps its config in different places on Windows, and setup cannot tell which one this install reads. ` +
  `Candidates: ${describeChoices(t.choices ?? [])}. Pick it with: ${setupCommand()} clients add ${t.id} --config "<file>"`;

/** The client's state, colored by meaning: green = set up, yellow = needs attention, gray = not installed. */
function statusLine(t: ClientTarget, entry: LaunchEntry): string {
  if (!t.detected) return ui.gray('not installed');
  if (t.choices) return `${ui.yellow('installed')} — ${CHOOSE_HINT(t)}`;
  const s = clientStatus(t, entry);
  const others = s.otherNames.length ? ` It also starts this server as "${s.otherNames.join('", "')}" — remove that entry to avoid two copies.` : '';
  if (s.unreadable) return `${ui.yellow('not changed by setup')} — ${s.unreadable}. "setup clients add ${t.id}" prints the entry to paste.${others}`;
  if (!s.hasEntry) return `${ui.yellow('installed, not set up')}${others}`;
  if (s.entryHasKeys) return `${ui.yellow('set up with its own access key in the entry')} (that key wins over the credential store)${others}`;
  return (s.upToDate ? ui.green('set up') : `${ui.yellow('set up with a different launch command')} ("setup clients add" updates it)`) + others;
}

/** Claude Code's user-scope status ("claude command not found" instead of "not installed": it may be installed elsewhere). */
function claudeStatusLine(ctx: ClientContext, entry: LaunchEntry, commandBelow = true): string {
  const t = claudeCodeTarget(ctx);
  if (!t.detected) {
    return commandBelow
      ? ui.gray('not installed (the claude command was not found) — if you use it, run the command below in a terminal where it works')
      : ui.gray(`not installed (the claude command was not found). If you use it, "${setupCommand()} clients" prints the command to run`);
  }
  return statusLine(t, claudeCodeEntry(entry, ctx.platform));
}

/**
 * Claude Code projects whose own entry replaces the user-scope one (claudeCodeProjectOverrides), each with how to
 * remove it. Empty when there are none. A warning, not a doctor PROBLEM: an override can be deliberate (a source
 * checkout, a project-specific key).
 */
function overrideLines(ctx: ClientContext): string[] {
  const found = claudeCodeProjectOverrides(ctx);
  if (found.length === 0) return [];
  const n = new Set(found.map((o) => o.project.toLowerCase())).size;
  // A short headline, then one block per project with aligned rows (feedback 2026-11-20: one long sentence per
  // project, wrapped by the terminal, was hard to read).
  const lines = [
    '',
    `  ${ui.bold(ui.yellow('WARNING'))}  ${ui.bold(`${n} Claude Code project${n === 1 ? ' uses its' : 's use their'} own server entry, not this setup`)}`,
    ui.gray('  A per-project entry wins over the "all your projects" one.'),
    ui.gray('  Remove it unless the project needs its own.'),
  ];
  for (const o of found) {
    const keys = o.holdsKeys ? ui.yellow(' (with its own access key)') : '';
    lines.push('');
    lines.push(`    ${ui.bold(o.project)}`);
    if (o.scope === 'local') {
      lines.push(`      Entry:  "${o.name}"${keys}, local to this computer`);
      lines.push('      Fix:    run');
      lines.push(`        ${ui.command(`cd "${o.project}" ; claude mcp remove "${o.name}" -s local`)}`);
    } else {
      lines.push(`      Entry:  "${o.name}"${keys}`);
      lines.push(`      File:   ${ui.gray(o.file ?? '')}`);
      lines.push(`      Note:   ${ui.gray(`shared with the repository${o.approved ? '' : '; Claude Code asks before using it'}`)}`);
      lines.push(`      Fix:    remove "${o.name}" from that file`);
    }
  }
  return lines;
}

function cmdClientsList(io: SetupIO, ctx: ClientContext) {
  const entry = buildLaunchEntry(ctx);
  io.out(ui.bold('AI clients on this computer'));
  for (const t of knownClients(ctx)) {
    const row = `  ${t.id.padEnd(22)} ${t.label}: ${statusLine(t, entry)}`;
    io.out(t.detected ? row : ui.gray(ui.stripStyle(row))); // a client that is not installed is background
  }
  io.out(`  ${'claude-code'.padEnd(22)} Claude Code (all your projects): ${claudeStatusLine(ctx, entry)}`);
  for (const l of overrideLines(ctx)) io.out(l);
  io.out('');
  io.out(ui.bold('Set up by hand'));
  for (const m of manualClients()) io.out(ui.gray(`  ${m.id.padEnd(22)} ${m.label}: ${m.how}`));
  io.out('');
  describeEntry(io, entry);
  // The command only when there is something to do: after "set up" it read as a step still open (2026-11-19).
  const claude = claudeCodeTarget(ctx);
  const done = claude.detected && (() => {
    const s = clientStatus(claude, claudeCodeEntry(entry, ctx.platform));
    return s.hasEntry && s.upToDate && !s.entryHasKeys && !s.unreadable;
  })();
  if (done) return;
  io.out('');
  io.out(`Claude Code — "${setupCommand()} clients add claude-code" runs this for you, or run it once in a terminal:`);
  io.out(`  ${ui.command(claudeCodeCommand(entry, ctx.platform))}`);
}

/** The named clients, or every installed one when none is named. */
function pickTargets(ctx: ClientContext, ids: string[], config?: string): ClientTarget[] {
  const known = knownClients(ctx);
  if (config !== undefined) {
    // --config names the file for ONE client: it must be that client's file name, in a folder that exists.
    if (ids.length !== 1) throw new SetupError('--config needs exactly one client, e.g. setup clients add claude-desktop --config "<file>"', 2);
    const t = known.find((k) => k.id === ids[0].toLowerCase());
    if (!t) throw new SetupError(`Unknown client "${ids[0]}". Known: ${known.map((k) => k.id).join(', ')}.`, 2);
    const wanted = basename(t.file);
    if (basename(config) !== wanted) throw new SetupError(`--config must point to a file named ${wanted} (got ${config}).`, 2);
    if (!existsSync(dirname(config))) throw new SetupError(`The folder of ${config} does not exist.`, 2);
    return [{ ...t, file: config, detected: true, choices: undefined }];
  }
  if (ids.length === 0) return known.filter((t) => t.detected);
  return ids.map((id) => {
    const t = known.find((k) => k.id === id.toLowerCase());
    if (t) return t;
    const manual = manualClients().find((m) => m.id === id.toLowerCase());
    if (manual) throw new SetupError(`${manual.label}: ${manual.how} See: ${setupCommand()} clients`, 2);
    throw new SetupError(`Unknown client "${id}". Known: ${known.map((k) => k.id).join(', ')}.`, 2);
  });
}

/**
 * An entry about to be replaced holds its own profiles (URL + key variables). The new entry has none, so any profile the
 * credential store does not already hold (same URL and key, any name) would be lost. Offers to import those into the
 * store — each key checked first, keys to the OS keychain, never printed. Returns the profiles still missing afterwards.
 */
async function importEntryProfiles(io: SetupIO, t: ClientTarget, yes: boolean): Promise<string[]> {
  const found = entryProfiles(t);
  if (found.length === 0) return [];
  const store = readStore();
  const held = Object.values(store.profiles);
  const missing = found.filter((p) => !(p.url && p.key && held.some((h) => h.url.replace(/\/+$/, '') === p.url && h.key === p.key)));
  if (missing.length === 0) {
    io.out(`${t.label}'s entry holds ${found.length === 1 ? 'a profile' : `${found.length} profiles`} the credential store already has.`);
    return [];
  }
  const label = (p: EntryProfile) => (p.name === 'default' ? 'its default connection (DIGITAL_AI_BASE_URL / DIGITAL_AI_ACCESS_KEY)' : `"${p.name}"`);
  io.out(`${t.label}'s entry holds ${missing.length === 1 ? 'a profile' : `${missing.length} profiles`} the credential store does not have: ${missing.map(label).join(', ')}.`);
  io.out(`  The new entry reads only the credential store, so ${t.label} would lose ${missing.length === 1 ? 'it' : 'them'}.`);
  const raw = readStoreFileRaw();
  if (raw.exists && !raw.data) {
    io.out(`  They cannot be imported: the profiles file ${storePath()} is unreadable (${raw.error}). ${capital(brokenFileFix())}.`);
    return missing.map((p) => p.name);
  }
  const doImport =
    yes || (io.interactive && !/^n(o)?$/i.test(await io.ask('Import them into the credential store (each key is checked first; keys go to the OS keychain)? [Y/n] ')));
  if (!doImport) {
    io.out('  Not imported. To add them yourself:');
    for (const p of missing) io.out(`    ${setupCommand()} add ${p.name === 'default' ? '<name>' : p.name}${p.url ? ` --url ${p.url}` : ''}`);
    return missing.map((p) => p.name);
  }

  const data = loadForEdit();
  const notImported: string[] = [];
  const imported: string[] = [];
  let importedDefault: string | undefined;
  for (const p of missing) {
    const url = p.url ? validUrl(p.url) : null;
    if (!url || !p.key) {
      io.out(`  ${label(p)}: not imported — the entry has ${!p.key ? 'no access key' : p.url ? `an invalid URL (${p.url})` : 'no URL'} for it.`);
      notImported.push(p.name);
      continue;
    }
    const check = await io.verify(url, p.key);
    if (!check.ok) {
      io.out(`  ${label(p)}: not imported — ${describeCheck(check, url)}.`);
      notImported.push(p.name);
      continue;
    }
    // The env default has no name of its own in the store: name it after its role ("admin", the project), else "default".
    let name = p.name;
    if (p.name === 'default') {
      const suggested = suggestName(check);
      name = findRawProfileName(data, suggested) ? 'default' : suggested;
    }
    if (!PROFILE_NAME_RE.test(name)) {
      io.out(`  ${label(p)}: not imported — "${name}" is not a valid profile name. Add it with: ${setupCommand()} add <name> --url ${url}`);
      notImported.push(p.name);
      continue;
    }
    if (findRawProfileName(data, name)) {
      io.out(
        `  ${label(p)}: not imported — the credential store already has a profile named "${name}" with a different URL or key. ` +
          `Kept the store's. To keep both: ${setupCommand()} add <other name> --url ${url}`
      );
      notImported.push(p.name);
      continue;
    }
    const saved = saveKeyToKeychain(name, p.key);
    if (!saved.ok) {
      io.out(`  ${label(p)}: not imported — the OS keychain could not store the key (${saved.error}). Add it with: ${setupCommand()} add ${name} --url ${url} --plain-file`);
      notImported.push(p.name);
      continue;
    }
    data.profiles[name] = { url, keyStore: 'os' };
    imported.push(name);
    if (p.name === 'default') importedDefault = name;
    io.out(`  ${label(p)} → profile "${name}" (${roleLine(check.info)}).`);
  }
  if (imported.length === 0) return notImported;

  // The old entry started on its default connection: keep that, unless the store already has a usable default.
  const currentDefault = typeof data.default === 'string' ? data.default.trim().toLowerCase() : undefined;
  const defaultExists = !!currentDefault && !!findRawProfileName(data, currentDefault);
  const startOn = importedDefault ?? (defaultExists ? undefined : imported[0]);
  if (startOn && !defaultExists) data.default = startOn;
  writeStore(data);

  const back = readStore();
  for (const name of imported) {
    if (!back.profiles[name]) {
      const why = back.skipped.find((s) => s.name === name)?.reason ?? back.error ?? 'unknown reason';
      io.out(`  "${name}" was written to ${storePath()}, but reading it back failed: ${why}.`);
      notImported.push(name);
    }
  }
  io.out(`Imported ${imported.length} profile${imported.length === 1 ? '' : 's'} into ${storePath()}.`);
  if (importedDefault && defaultExists && currentDefault !== importedDefault) {
    io.out(`  The server still starts on "${currentDefault}" (the store's default). To start on the entry's old default instead: ${setupCommand()} default ${importedDefault}`);
  } else if (back.defaultProfile) {
    io.out(`  The server starts on "${back.defaultProfile}".`);
  }
  return notImported;
}

/** Adds or updates the entry in each target. Returns how many files changed, and how many were left unchanged and need attention. */
async function addToClients(io: SetupIO, ctx: ClientContext, targets: ClientTarget[], yes: boolean): Promise<{ changed: number; attention: number }> {
  const entry = buildLaunchEntry(ctx);
  let attention = 0;
  let changed = 0;
  for (const t of targets) {
    if (t.choices) {
      io.out(`${t.label}: ${ui.yellow('not changed')} — ${CHOOSE_HINT(t)}`);
      attention++;
      continue;
    }
    const s = clientStatus(t, entry);
    if (s.unreadable) {
      io.out(`${t.label}: ${ui.yellow('not changed')} — ${s.unreadable}. Add this "${SERVER_ENTRY_NAME}" entry to ${t.file} by hand (replace the one there, if any):`);
      io.out(pasteSnippet(t.format, entry));
      attention++;
      continue;
    }
    if (s.upToDate) {
      io.out(`${t.label}: ${ui.green('already set up')}.`);
      continue;
    }
    // Claude Desktop on Windows: always show the exact file and get a yes for it (its location varies by install).
    if (t.id === 'claude-desktop' && ctx.platform === 'win32' && !yes) {
      const ok = io.interactive && /^y(es)?$/i.test(await io.ask(`Edit Claude Desktop's config file ${t.file}? [y/N] `));
      if (!ok) {
        io.out(`${t.label}: ${ui.yellow('not changed')}${io.interactive ? '' : ` — add --yes to edit ${t.file}`}.`);
        attention++;
        continue;
      }
    }
    if (s.hasEntry) {
      adoptEntryReportDir(io, t);
      const lost = s.entryHasKeys ? await importEntryProfiles(io, t, yes) : [];
      const saved = s.entryHasKeys && entryProfiles(t).some((p) => p.url && p.key);
      const question = lost.length
        ? `Replace ${t.label}'s entry anyway? It would lose: ${lost.map((n) => (n === 'default' ? 'its default connection' : `"${n}"`)).join(', ')}. [y/N] `
        : saved
          ? `The profiles in ${t.label}'s entry are in the credential store now. Replace the entry with one that uses the credential store? [y/N] `
          : s.entryHasKeys
            ? `${t.label} already has a "${SERVER_ENTRY_NAME}" entry with its own access key. Replace it with one that uses the credential store? [y/N] `
            : `${t.label} already has a "${SERVER_ENTRY_NAME}" entry with a different launch command. Replace it? [y/N] `;
      const replace = yes || (io.interactive && /^y(es)?$/i.test(await io.ask(question)));
      if (!replace) {
        io.out(`${t.label}: ${ui.yellow('not changed')}${io.interactive ? '' : ' — add --yes to replace its existing entry'}.`);
        attention++;
        continue;
      }
    }
    const r = writeClientEntry(t, entry);
    if (!r.ok) {
      io.err(`${t.label}: ${ui.red('not changed')} — ${r.error}`);
      attention++;
      continue;
    }
    changed++;
    io.out(`${t.label}: ${ui.green(s.hasEntry ? 'updated' : 'added')} ${ui.gray(`(${t.file}${r.backup ? `; previous version kept as ${r.backup}` : ''})`)}.`);
    for (const n of s.otherNames) io.out(`  It also starts this server as "${n}" — remove that entry in ${t.file} to avoid two copies.`);
    if (s.envFile) io.out(`  The entry also loads variables from ${s.envFile} (kept). If that file sets DIGITAL_AI_* or DAI_PROFILE_* keys, they still win over the credential store — remove them there.`);
    // Windows only: there Claude Desktop's config has several possible locations (see CLAUDE.md). macOS has one, and the
    // note read as noise there (Mac run 2026-11-19).
    if (t.id === 'claude-desktop' && ctx.platform === 'win32') {
      io.out(
        '  To confirm Claude Desktop reads this file: quit it completely (also from the system tray), start it again, ' +
          `and check that "${SERVER_ENTRY_NAME}" appears and is running in its MCP settings (Settings → Developer). If it does not appear, ` +
          `this install reads another file: ${r.backup ? `put back ${r.backup}, then ` : ''}run "${setupCommand()} clients add claude-desktop --config <file>" with the file it uses.`
      );
    }
  }
  return { changed, attention };
}

/**
 * Claude Code, user scope (every project): runs `claude mcp add-json --scope user` itself when the claude command is
 * found — the CLI is Claude Code's own way to change its settings, so a running session does not overwrite the change
 * (verified 2026-11-18: entries added that way survived ~15 min of a running session). An existing entry is handled like
 * the other clients: its profiles are offered for import and its other settings kept; replacing needs a yes.
 * `explicit`: Claude Code was named, so "not found" or a decline counts as not changed. `approved`: the user already said
 * yes to adding (guided setup), so a NEW entry is not asked about again.
 */
async function addToClaudeCode(io: SetupIO, ctx: ClientContext, yes: boolean, explicit: boolean, approved = false): Promise<{ changed: number; attention: number }> {
  const entry = buildLaunchEntry(ctx);
  const cmd = claudeCodeCommand(entry, ctx.platform);
  const unchanged = { changed: 0, attention: explicit ? 1 : 0 };
  const cli = ctx.claudeCli?.();
  if (!cli) {
    if (explicit) io.out(`Claude Code: the claude command was not found. Run this once in a terminal where it works:\n  ${ui.command(cmd)}`);
    return unchanged;
  }
  const t = claudeCodeTarget(ctx);
  const ce = claudeCodeEntry(entry, ctx.platform);
  const s = clientStatus(t, ce);
  if (s.unreadable) {
    io.out(`Claude Code: ${ui.yellow('not changed')} — ${t.file} could not be read (${s.unreadable}). Run this once in a terminal:\n  ${ui.command(cmd)}`);
    return { changed: 0, attention: 1 };
  }
  if (s.upToDate) {
    io.out(`Claude Code: ${ui.green('already set up')} (all your projects).`);
    return { changed: 0, attention: 0 };
  }
  if (s.hasEntry) adoptEntryReportDir(io, t);
  const lost = s.hasEntry && s.entryHasKeys ? await importEntryProfiles(io, t, yes) : [];
  const saved = s.entryHasKeys && entryProfiles(t).some((p) => p.url && p.key);
  const where = `"${SERVER_ENTRY_NAME}" entry for all your projects`;
  const question = !s.hasEntry
    ? `Add the server to Claude Code for all your projects (runs "claude mcp add-json --scope user ${SERVER_ENTRY_NAME} …")? [Y/n] `
    : lost.length
      ? `Replace Claude Code's ${where} anyway? It would lose: ${lost.map((n) => (n === 'default' ? 'its default connection' : `"${n}"`)).join(', ')}. [y/N] `
      : saved
        ? `The profiles in Claude Code's ${where} are in the credential store now. Replace the entry with one that uses the credential store? [y/N] `
        : s.entryHasKeys
          ? `Claude Code already has a ${where} with its own access key. Replace it with one that uses the credential store? [y/N] `
          : `Claude Code already has a ${where} with a different launch command. Replace it? [y/N] `;
  let go = yes || (approved && !s.hasEntry);
  if (!go) {
    if (!io.interactive) {
      io.out(`Claude Code: ${ui.yellow('not changed')} — add --yes to ${s.hasEntry ? 'replace' : 'add'} it, or run this once in a terminal:\n  ${ui.command(cmd)}`);
      return { changed: 0, attention: 1 };
    }
    const a = await io.ask(question);
    go = s.hasEntry ? /^y(es)?$/i.test(a) : !/^n(o)?$/i.test(a);
  }
  if (!go) {
    io.out(`Claude Code: ${ui.yellow('not changed')}. To add it later: ${ui.command(`${setupCommand()} clients add claude-code`)}`);
    return s.hasEntry ? { changed: 0, attention: 1 } : unchanged;
  }

  const old = s.hasEntry ? currentJsonEntry(t) : undefined;
  const json = mergedJsonEntry('mcpServers', ce, old);
  if (!('type' in json)) json.type = 'stdio';
  const firstLine = (o: string) => redact(o.split(/\r?\n/).find((l) => l.trim()) ?? 'no output');
  if (s.hasEntry) {
    const r = cli.run(['mcp', 'remove', SERVER_ENTRY_NAME, '-s', 'user']);
    if (!r.ok) {
      io.err(`Claude Code: not changed — "claude mcp remove" failed: ${firstLine(r.output)}`);
      return { changed: 0, attention: 1 };
    }
  }
  const r = cli.run(['mcp', 'add-json', '--scope', 'user', SERVER_ENTRY_NAME, JSON.stringify(json)]);
  if (!r.ok) {
    // Put the old entry back, so a failed add never leaves Claude Code without the server.
    const restored = old !== undefined && cli.run(['mcp', 'add-json', '--scope', 'user', SERVER_ENTRY_NAME, JSON.stringify(old)]).ok;
    io.err(
      `Claude Code: not changed — "claude mcp add-json" failed: ${firstLine(r.output)}.` +
        (old !== undefined ? (restored ? ' The previous entry was put back.' : ' The previous entry could NOT be put back.') : '') +
        ` Run this once in a terminal instead:\n  ${ui.command(cmd)}`
    );
    return { changed: 0, attention: 1 };
  }
  io.out(`Claude Code: ${ui.green(s.hasEntry ? 'updated' : 'added')} for all your projects ${ui.gray(`(claude mcp add-json --scope user; ${t.file})`)}.`);
  if (!clientStatus(t, ce).upToDate) io.out(`  Note: reading ${t.file} back did not show the new entry yet — check with: claude mcp get ${SERVER_ENTRY_NAME}`);
  io.out(
    ui.gray(
      `  A project whose .mcp.json defines "${SERVER_ENTRY_NAME}" keeps using that one. Claude Code sessions already running ` +
        'pick up the change after a restart (or /mcp → reconnect).'
    )
  );
  return { changed: 1, attention: 0 };
}

interface PendingClients {
  ctx: ClientContext;
  entry: LaunchEntry;
  targets: ClientTarget[];
  claude: boolean;
}

/** The installed clients that are not set up yet (undefined when there are none) — what a guided `setup` offers. */
function pendingClients(io: SetupIO): PendingClients | undefined {
  const ctx = io.clients ?? defaultClientContext();
  const entry = buildLaunchEntry(ctx);
  const targets = knownClients(ctx).filter((t) => t.detected && !clientStatus(t, entry).upToDate);
  const claudeT = claudeCodeTarget(ctx);
  const claude = claudeT.detected && !clientStatus(claudeT, claudeCodeEntry(entry, ctx.platform)).upToDate;
  return targets.length || claude ? { ctx, entry, targets, claude } : undefined;
}

/** After a guided `setup`: offer the installed clients that are not set up yet. */
async function offerClients(io: SetupIO, p: PendingClients) {
  const { ctx, entry, targets, claude } = p;
  const labels = [...targets.map((t) => t.label), ...(claude ? ['Claude Code'] : [])];
  io.out(`  Found on this computer: ${labels.join(', ')}`);
  const answer = await io.ask('Add the server to them? [Y/n] ');
  if (/^n(o)?$/i.test(answer)) {
    io.out('Not added. To add it later:');
    io.out(`  ${ui.command(`${setupCommand()} clients add`)}`);
    return;
  }
  const res = await addToClients(io, ctx, targets, false);
  const cc = claude ? await addToClaudeCode(io, ctx, false, false, true) : { changed: 0 };
  if (res.changed + cc.changed > 0) await warmNote(io, ctx, entry);
}

/**
 * After a client entry was written: start the server once the way the clients will, so the package is downloaded
 * now rather than during a client's first start (Claude Code gives up after 30 s — see warmStart in clients.ts).
 */
async function warmNote(io: SetupIO, ctx: ClientContext, entry: LaunchEntry) {
  if (!ctx.warmStart) return;
  io.out('');
  io.out('Starting the server once, as your AI clients will (the first run downloads it)…');
  const r = await ctx.warmStart(entry);
  const secs = (r.ms / 1000).toFixed(1);
  if (r.ok) io.out(`  The server ${ui.green('started')} in ${secs} s${r.version ? ` (version ${r.version})` : ''}.`);
  else {
    io.out(
      `  The server ${ui.yellow('did not start')} (${r.error}, after ${secs} s). If an AI client reports a timeout, reconnect the server ` +
        `there once more. "${setupCommand()} doctor" checks the rest.`
    );
  }
}

async function cmdClients(io: SetupIO, sub: string | undefined, ids: string[], flags: Flags) {
  const ctx = io.clients ?? defaultClientContext();
  if (sub === undefined || sub === 'list') {
    if (ids.length) throw new SetupError(`Unexpected argument: ${ids[0]}`, 2);
    cmdClientsList(io, ctx);
    return;
  }
  const isClaude = (id: string) => id.toLowerCase() === 'claude-code';
  const namedClaude = ids.some(isClaude);
  const otherIds = ids.filter((id) => !isClaude(id));
  if (namedClaude && flags.config !== undefined) throw new SetupError('--config does not apply to Claude Code: setup changes it with the claude command.', 2);
  if (sub === 'add') {
    const targets = namedClaude && otherIds.length === 0 ? [] : pickTargets(ctx, otherIds, flags.config);
    // Claude Code: when named, or with "every installed client" (no names, no --config).
    const withClaude = namedClaude || (ids.length === 0 && flags.config === undefined && claudeCodeTarget(ctx).detected);
    if (targets.length === 0 && !withClaude) {
      throw new SetupError(`No AI clients were found on this machine. Name one: ${setupCommand()} clients add <client> (list: setup clients)`, 1);
    }
    describeEntry(io, buildLaunchEntry(ctx));
    const res = await addToClients(io, ctx, targets, !!flags.yes);
    const cc = withClaude ? await addToClaudeCode(io, ctx, !!flags.yes, namedClaude) : { changed: 0, attention: 0 };
    const changed = res.changed + cc.changed;
    const attention = res.attention + cc.attention;
    for (const l of overrideLines(ctx)) io.out(l); // starts with its own blank line
    // Always, not only after a change: run after a release with every entry already right, it downloads the new
    // version before a client's first start needs it (README Troubleshooting).
    if (attention === 0 || changed > 0) await warmNote(io, ctx, buildLaunchEntry(ctx));
    if (changed > 0) io.out(RESTART_CLIENTS);
    if (attention > 0) throw new SetupError(`${attention} client${attention === 1 ? ' was' : 's were'} not changed (see above).`, 1);
    return;
  }
  if (sub === 'remove') {
    const entry = buildLaunchEntry(ctx);
    const picked = namedClaude && otherIds.length === 0 ? [] : pickTargets(ctx, otherIds, flags.config);
    const claude = claudeCodeTarget(ctx);
    const cli = ctx.claudeCli?.();
    const claudeHas = (namedClaude || (ids.length === 0 && flags.config === undefined)) && !!cli && clientStatus(claude, claudeCodeEntry(entry, ctx.platform)).hasEntry;
    if (namedClaude && !cli) io.out(`Claude Code: the claude command was not found. Remove it by hand: claude mcp remove ${SERVER_ENTRY_NAME} -s user`);
    for (const t of picked.filter((p) => p.choices && ids.length > 0)) io.out(`${t.label}: not changed — ${CHOOSE_HINT(t).replace('setup clients add', 'setup clients remove')}`);
    const targets = picked.filter((t) => !t.choices && clientStatus(t, entry).hasEntry);
    const names = [...targets.map((t) => `${t.label} (${t.file})`), ...(claudeHas ? ['Claude Code (all your projects)'] : [])].join(', ');
    if (targets.length === 0 && !claudeHas) {
      io.out(`No AI client has a "${SERVER_ENTRY_NAME}" entry to remove.`);
      return;
    }
    if (!(await confirm(io, !!flags.yes, `Remove the "${SERVER_ENTRY_NAME}" entry from ${names}? [y/N] `, 'Add --yes to remove it.'))) {
      throw new SetupError('Nothing was changed.', 1);
    }
    let removed = 0;
    for (const t of targets) {
      const r = removeClientEntry(t);
      if (!r.ok) io.err(`${t.label}: ${ui.red('not changed')} — ${r.error}`);
      else {
        removed++;
        io.out(`${t.label}: removed${r.backup ? ` (previous version kept as ${r.backup})` : ''}.`);
      }
    }
    if (claudeHas && cli) {
      const r = cli.run(['mcp', 'remove', SERVER_ENTRY_NAME, '-s', 'user']);
      if (r.ok) {
        removed++;
        io.out('Claude Code: removed (all your projects).');
      } else io.err(`Claude Code: not changed — "claude mcp remove" failed: ${redact(r.output.split(/\r?\n/)[0] ?? '')}`);
    }
    if (removed > 0) io.out(RESTART_CLIENTS);
    return;
  }
  throw new SetupError(`Unknown clients command: ${sub}. Use: setup clients | setup clients add [client…] | setup clients remove [client…]`, 2);
}

// ─── Entry point ──────────────────────────────────────────────────────────────

/** Runs `setup` with the arguments after it. Returns the process exit code: 0 done, 1 failed, 2 usage error. */
export async function runSetupCli(argv: string[], io: SetupIO = terminalIO()): Promise<number> {
  try {
    let parsed;
    try {
      parsed = parseArgs({
        args: argv,
        allowPositionals: true,
        strict: true,
        options: {
          url: { type: 'string' },
          'key-stdin': { type: 'boolean' },
          'plain-file': { type: 'boolean' },
          default: { type: 'boolean' },
          'skip-check': { type: 'boolean' },
          config: { type: 'string' },
          offline: { type: 'boolean' },
          yes: { type: 'boolean', short: 'y' },
          help: { type: 'boolean', short: 'h' },
        },
      });
    } catch (e) {
      throw new SetupError(`${(e as Error).message}\n\n${USAGE}`, 2);
    }
    const [command, name, ...extra] = parsed.positionals;
    if (command === 'clients' && !parsed.values.help) {
      await cmdClients(io, name, extra, parsed.values as Flags);
      return 0;
    }
    const flags = parsed.values as Flags & { help?: boolean };
    if (flags.help || command === 'help') {
      io.out(USAGE);
      return 0;
    }
    if (extra.length > 0) throw new SetupError(`Unexpected argument: ${extra[0]}\n\n${USAGE}`, 2);

    switch (command) {
      case 'reports':
        cmdReports(io, name);
        break;
      case undefined:
        if (!io.interactive) {
          io.out(USAGE);
          return 2;
        }
        await cmdAdd(io, undefined, flags);
        break;
      case 'add':
        await cmdAdd(io, name, flags);
        break;
      case 'list':
        cmdList(io);
        break;
      case 'default':
        cmdDefault(io, name);
        break;
      case 'remove':
        await cmdRemove(io, name, flags);
        break;
      case 'test':
        await cmdTest(io, name);
        break;
      case 'doctor':
        if (!(await cmdDoctor(io, flags))) return 1;
        break;
      case 'path':
        cmdPath(io);
        break;
      case 'repair':
        await cmdRepair(io, flags);
        break;
      case 'reset':
        await cmdReset(io, flags);
        break;
      default:
        throw new SetupError(`Unknown command: ${command}\n\n${USAGE}`, 2);
    }
    return 0;
  } catch (e) {
    if (e instanceof SetupError) {
      const [first, ...rest] = e.message.split('\n');
      io.err([ui.red(first), ...rest].join('\n'));
      return e.code;
    }
    io.err(ui.red(`Unexpected error: ${(e as Error).message}`));
    return 1;
  }
}
