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
  readStoreFileRaw,
  restoreStoreBackup,
  saveKeyToKeychain,
  storePath,
  validUrl,
  writeStore,
  type RawStoreFile,
} from '../utils/credential-store.js';
import { existsSync, statSync } from 'node:fs';
import { getServerVersion } from '../utils/version.js';
import { getDeploymentMode, runningInContainer } from '../utils/deployment-mode.js';
import { installKind } from '../utils/update-check.js';
import { redact } from '../utils/remediation.js';
import { credentialEnvPresence } from '../utils/profile-loader.js';
import { basename, dirname } from 'node:path';
import {
  buildLaunchEntry,
  claudeCodeCommand,
  clientStatus,
  defaultClientContext,
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

const RESTART = 'Restart your AI client, or reconnect the digital-ai-testing MCP server, to use the change.';

class SetupError extends Error {
  constructor(message: string, readonly code = 1) {
    super(message);
  }
}

// ─── Default terminal I/O ─────────────────────────────────────────────────────

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function askSecret(question: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) return ask(question);
  process.stderr.write(question);
  return new Promise((resolve) => {
    let value = '';
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
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
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
  return {
    out: (t) => void process.stdout.write(t + '\n'),
    err: (t) => void process.stderr.write(t + '\n'),
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
  else if (io.interactive) key = await io.askSecret('Access key (input hidden): ');
  else throw new SetupError('No access key: pass --key-stdin and pipe the key in when not running in a terminal.', 2);
  if (!key) throw new SetupError('No access key was entered.', 2);

  // Check
  let check: CredentialCheck | undefined;
  if (!flags['skip-check']) {
    io.out(`Checking the key with ${url} …`);
    check = await io.verify(url, key);
    if (!check.ok) {
      throw new SetupError(`Not saved: ${describeCheck(check, url)}.` + (check.problem === 'unreachable' ? ' To save it anyway, add --skip-check.' : ''));
    }
    io.out(`OK — ${describeCheck(check, url)}.`);
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
  io.out(
    `Saved profile "${name}" (${url}) — key in ${keyLocation === 'os' ? `the OS keychain (service "${KEYCHAIN_SERVICE}", account "${keychainAccount(name)}")` : 'the profiles file'}.`
  );
  io.out(makeDefault ? `The server starts on "${name}".` : `The server still starts on "${currentDefault}"; switch with switch_environment("${name}").`);
  // A Cloud-Admin-sounding name on a project key: "switch to admin" would land here, not on a Cloud Admin profile.
  if (check?.ok && isKnownNotCloudAdmin(check.info.level) && ADMIN_ALIAS_NAMES.includes(name)) {
    io.out(
      `Note: "${name}" holds a ${roleLine(check.info).split(' of ')[0]} key. switch_environment("${name}") always picks this ` +
        'profile; ask for "cloud admin" to reach a Cloud Admin profile.'
    );
  }
  io.out(`Profiles file: ${path}`);
  io.out('If your AI client\'s configuration sets DIGITAL_AI_BASE_URL / DIGITAL_AI_ACCESS_KEY, those still win — remove them to use these profiles.');
  if (io.interactive && !flags.yes) await offerClients(io);
  else io.out(`To add the server to your AI clients: ${setupCommand()} clients add`);
  io.out(RESTART);
}

function cmdList(io: SetupIO) {
  const path = storePath();
  storeOffNote(io);
  const raw = readStoreFileRaw();
  if (!raw.exists) {
    io.out(`No profiles yet (${path} does not exist). Add one with: ${setupCommand()}`);
    return;
  }
  io.out(`Profiles file: ${path}`);
  if (!raw.data) {
    io.out(`It cannot be used: ${raw.error}. ${capital(brokenFileFix())}.`);
    return;
  }
  const store = readStore();
  const names = Object.keys(raw.data.profiles);
  if (names.length === 0) io.out(`No profiles in it. Add one with: ${setupCommand()}`);
  for (const rawName of names) {
    const n = rawName.trim().toLowerCase();
    const ok = store.profiles[n];
    const isDefault = store.defaultProfile === n;
    const where = ok ? (ok.keyStore === 'os' ? 'key in the OS keychain' : 'key in this file') : '';
    const problem = store.skipped.find((s) => s.name === rawName || s.name === n)?.reason;
    io.out(`  ${rawName}${isDefault ? ' (default)' : ''}: ${ok ? `${ok.url} — ${where}` : `NOT USABLE — ${problem ?? 'unknown reason'}`}`);
  }
  const defaultProblem = store.skipped.find((s) => s.name === '(default)');
  if (defaultProblem) io.out(`  Default: ${defaultProblem.reason}. Fix with: ${setupCommand()} default <name>`);
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
  io.out(RESTART);
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
  if (entry.keyStore === 'os') {
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
  io.out(RESTART);
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
    io.out(`No profiles to check. Add one with: ${setupCommand()}`);
    return;
  }
  let failed = 0;
  for (const n of names) {
    const p = store.profiles[n];
    if (!p) {
      const reason = store.skipped.find((s) => s.name.toLowerCase() === n)?.reason;
      if (!reason && wanted) throw new SetupError(`There is no profile named "${n}". See: ${setupCommand()} list`);
      io.out(`  ${n}: NOT USABLE — ${reason}`);
      failed++;
      continue;
    }
    const check = await io.verify(p.url, p.key);
    io.out(`  ${n}: ${check.ok ? 'OK' : 'FAILED'} — ${describeCheck(check, p.url)}`);
    if (!check.ok) failed++;
  }
  if (!wanted) {
    for (const s of store.skipped.filter((s) => s.name !== '(default)')) {
      io.out(`  ${s.name}: NOT USABLE — ${s.reason}`);
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
  io.out(RESTART);
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
  io.out(RESTART);
}

// ─── AI clients ───────────────────────────────────────────────────────────────

const RESTART_CLIENTS = 'Restart the AI clients you changed (or reconnect the server in them) to use the change.';

function describeEntry(io: SetupIO, entry: LaunchEntry) {
  io.out(`Entry "${SERVER_ENTRY_NAME}" (no access key in it — the server reads the credential store):`);
  io.out(`  ${entry.command} ${entry.args.join(' ')}`);
  for (const n of entry.notes) io.out(`  Note: ${n}`);
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

function statusLine(t: ClientTarget, entry: LaunchEntry): string {
  if (!t.detected) return 'not installed';
  if (t.choices) return `installed — ${CHOOSE_HINT(t)}`;
  const s = clientStatus(t, entry);
  const others = s.otherNames.length ? ` It also starts this server as "${s.otherNames.join('", "')}" — remove that entry to avoid two copies.` : '';
  if (s.unreadable) return `not changed by setup — ${s.unreadable}. "setup clients add ${t.id}" prints the entry to paste.${others}`;
  if (!s.hasEntry) return `installed, not set up${others}`;
  if (s.entryHasKeys) return `set up with its own access key in the entry (that key wins over the credential store)${others}`;
  return (s.upToDate ? 'set up' : 'set up with a different launch command ("setup clients add" updates it)') + others;
}

function cmdClientsList(io: SetupIO, ctx: ClientContext) {
  const entry = buildLaunchEntry(ctx);
  describeEntry(io, entry);
  io.out('');
  for (const t of knownClients(ctx)) io.out(`  ${t.id.padEnd(22)} ${t.label}: ${statusLine(t, entry)}`);
  io.out('');
  io.out('Set up by hand:');
  for (const m of manualClients()) io.out(`  ${m.id.padEnd(22)} ${m.label}: ${m.how}`);
  io.out('');
  io.out('Claude Code — run once in a terminal:');
  io.out(`  ${claudeCodeCommand(entry, ctx.platform)}`);
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

/** Adds or updates the entry in each target. Returns how many were left unchanged and need attention. */
async function addToClients(io: SetupIO, ctx: ClientContext, targets: ClientTarget[], yes: boolean): Promise<number> {
  const entry = buildLaunchEntry(ctx);
  let attention = 0;
  for (const t of targets) {
    if (t.choices) {
      io.out(`${t.label}: not changed — ${CHOOSE_HINT(t)}`);
      attention++;
      continue;
    }
    const s = clientStatus(t, entry);
    if (s.unreadable) {
      io.out(`${t.label}: not changed — ${s.unreadable}. Add this to ${t.file} by hand:`);
      io.out(pasteSnippet(t.format, entry));
      attention++;
      continue;
    }
    if (s.upToDate) {
      io.out(`${t.label}: already set up.`);
      continue;
    }
    // Claude Desktop on Windows: always show the exact file and get a yes for it (its location varies by install).
    if (t.id === 'claude-desktop' && ctx.platform === 'win32' && !yes) {
      const ok = io.interactive && /^y(es)?$/i.test(await io.ask(`Edit Claude Desktop's config file ${t.file}? [y/N] `));
      if (!ok) {
        io.out(`${t.label}: not changed${io.interactive ? '' : ` — add --yes to edit ${t.file}`}.`);
        attention++;
        continue;
      }
    }
    if (s.hasEntry) {
      const lost = s.entryHasKeys ? await importEntryProfiles(io, t, yes) : [];
      const question = lost.length
        ? `Replace ${t.label}'s entry anyway? It would lose: ${lost.join(', ')}. [y/N] `
        : s.entryHasKeys
          ? `${t.label} already has a "${SERVER_ENTRY_NAME}" entry with its own access key. Replace it with one that uses the credential store? [y/N] `
          : `${t.label} already has a "${SERVER_ENTRY_NAME}" entry with a different launch command. Replace it? [y/N] `;
      const replace = yes || (io.interactive && /^y(es)?$/i.test(await io.ask(question)));
      if (!replace) {
        io.out(`${t.label}: not changed${io.interactive ? '' : ' — add --yes to replace its existing entry'}.`);
        attention++;
        continue;
      }
    }
    const r = writeClientEntry(t, entry);
    if (!r.ok) {
      io.err(`${t.label}: not changed — ${r.error}`);
      attention++;
      continue;
    }
    io.out(`${t.label}: ${s.hasEntry ? 'updated' : 'added'} (${t.file}${r.backup ? `; previous version kept as ${r.backup}` : ''}).`);
    for (const n of s.otherNames) io.out(`  It also starts this server as "${n}" — remove that entry in ${t.file} to avoid two copies.`);
    if (t.id === 'claude-desktop') {
      io.out(
        '  To confirm Claude Desktop reads this file: quit it completely (also from the system tray / menu bar), start it again, ' +
          `and check that "${SERVER_ENTRY_NAME}" appears and is running in its MCP settings (Settings → Developer). If it does not appear, ` +
          `this install reads another file: ${r.backup ? `put back ${r.backup}, then ` : ''}run "${setupCommand()} clients add claude-desktop --config <file>" with the file it uses.`
      );
    }
  }
  return attention;
}

/** After a guided `setup`: offer the installed clients that are not set up yet. */
async function offerClients(io: SetupIO) {
  const ctx = io.clients ?? defaultClientContext();
  const entry = buildLaunchEntry(ctx);
  const pending = knownClients(ctx).filter((t) => t.detected && !clientStatus(t, entry).upToDate);
  if (pending.length === 0) return;
  const answer = await io.ask(`Add the server to your AI clients too (${pending.map((t) => t.label).join(', ')})? [Y/n] `);
  if (/^n(o)?$/i.test(answer)) {
    io.out(`Later: ${setupCommand()} clients add`);
    return;
  }
  await addToClients(io, ctx, pending, false);
  io.out(`Claude Code: run this once in a terminal: ${claudeCodeCommand(entry, ctx.platform)}`);
}

async function cmdClients(io: SetupIO, sub: string | undefined, ids: string[], flags: Flags) {
  const ctx = io.clients ?? defaultClientContext();
  if (sub === undefined || sub === 'list') {
    if (ids.length) throw new SetupError(`Unexpected argument: ${ids[0]}`, 2);
    cmdClientsList(io, ctx);
    return;
  }
  if (sub === 'add') {
    const targets = pickTargets(ctx, ids, flags.config);
    if (targets.length === 0) {
      throw new SetupError(`No AI clients were found on this machine. Name one: ${setupCommand()} clients add <client> (list: setup clients)`, 1);
    }
    describeEntry(io, buildLaunchEntry(ctx));
    const attention = await addToClients(io, ctx, targets, !!flags.yes);
    io.out(RESTART_CLIENTS);
    if (attention > 0) throw new SetupError(`${attention} client${attention === 1 ? ' was' : 's were'} not changed (see above).`, 1);
    return;
  }
  if (sub === 'remove') {
    const entry = buildLaunchEntry(ctx);
    const picked = pickTargets(ctx, ids, flags.config);
    for (const t of picked.filter((p) => p.choices && ids.length > 0)) io.out(`${t.label}: not changed — ${CHOOSE_HINT(t).replace('setup clients add', 'setup clients remove')}`);
    const targets = picked.filter((t) => !t.choices && clientStatus(t, entry).hasEntry);
    const names = targets.map((t) => `${t.label} (${t.file})`).join(', ');
    if (targets.length === 0) {
      io.out(`No AI client has a "${SERVER_ENTRY_NAME}" entry to remove.`);
      return;
    }
    if (!(await confirm(io, !!flags.yes, `Remove the "${SERVER_ENTRY_NAME}" entry from ${names}? [y/N] `, 'Add --yes to remove it.'))) {
      throw new SetupError('Nothing was changed.', 1);
    }
    for (const t of targets) {
      const r = removeClientEntry(t);
      if (!r.ok) io.err(`${t.label}: not changed — ${r.error}`);
      else io.out(`${t.label}: removed${r.backup ? ` (previous version kept as ${r.backup})` : ''}.`);
    }
    io.out(RESTART_CLIENTS);
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
      io.err(e.message);
      return e.code;
    }
    io.err(`Unexpected error: ${(e as Error).message}`);
    return 1;
  }
}
