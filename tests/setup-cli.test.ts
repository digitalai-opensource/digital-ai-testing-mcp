/**
 * `digital-ai-testing-mcp setup` (src/cli/setup.ts). Commands run in-process with a scripted SetupIO, a fake keychain
 * and a temp store folder; the credential check is stubbed, except in the verifyCredential cases (local stub API) and
 * the two child-process cases, which start the real entry point the way `npx … setup` does. No test touches the real
 * OS keychain or a real tenant.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { runSetupCli, type SetupIO } from '../src/cli/setup.js';
import { verifyCredential, type CredentialCheck } from '../src/api/access-level.js';
import { clearAccessInfoCache } from '../src/utils/access-level.js';
import { keychainAccount, setKeychainForTests, type Keychain } from '../src/utils/credential-store.js';
import { startStubApi, accountInfo, reply } from './helpers/offline.js';

const KEY = 'aut_1_setupCliTestKey';
const KEY2 = 'aut_1_setupCliSecondKey';
const URL_A = 'https://tenant.example.com';

const CLOUD_ADMIN: CredentialCheck = { ok: true, info: { level: 'cloud-admin', role: 'Admin', source: 'role' } };
const PROJECT_USER: CredentialCheck = { ok: true, info: { level: 'project-user', role: 'User', projectName: 'Mobile QA', source: 'role' } };

function fakeKeychain(): Keychain & { entries: Record<string, string> } {
  const entries: Record<string, string> = {};
  return {
    entries,
    get: (a) => entries[a] ?? null,
    set: (a, s) => void (entries[a] = s),
    delete: (a) => {
      const had = a in entries;
      delete entries[a];
      return had;
    },
  };
}

interface Script {
  answers?: string[];
  secrets?: string[];
  stdin?: string;
  interactive?: boolean;
  verify?: (url: string, key: string) => Promise<CredentialCheck>;
}

function scripted(s: Script = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const asked: string[] = [];
  const answers = [...(s.answers ?? [])];
  const secrets = [...(s.secrets ?? [])];
  const verifyCalls: string[] = [];
  const io: SetupIO = {
    out: (t) => void out.push(t),
    err: (t) => void err.push(t),
    ask: async (q) => {
      asked.push(q);
      if (answers.length === 0) throw new Error(`unexpected question: ${q}`);
      return answers.shift()!;
    },
    askSecret: async (q) => {
      asked.push(q);
      return secrets.shift() ?? '';
    },
    readStdin: async () => s.stdin ?? '',
    interactive: s.interactive ?? false,
    verify: async (url, key) => {
      verifyCalls.push(url);
      return (s.verify ?? (async () => CLOUD_ADMIN))(url, key);
    },
    // An empty home: no AI client is "installed", so `add` never offers to edit a real configuration file.
    clients: { platform: process.platform, env: {}, home: join(dir, 'home'), execPath: process.execPath, exists: existsSync },
  };
  return { io, out, err, asked, verifyCalls, all: () => [...out, ...err].join('\n') };
}

let dir: string;
let kc: ReturnType<typeof fakeKeychain>;
const saved: Record<string, string | undefined> = {};
// The store sits at its DEFAULT location (APPDATA / XDG_CONFIG_HOME pointed at a temp folder), as for a customer, so
// keychain accounts are plain profile names. The MCP_CREDENTIAL_STORE_DIR naming has its own test.
const storeFile = () => join(dir, 'digital-ai-testing', 'profiles.json');
const readFile = () => JSON.parse(readFileSync(storeFile(), 'utf8'));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dai-setup-cli-'));
  for (const k of ['MCP_CREDENTIAL_STORE', 'MCP_CREDENTIAL_STORE_DIR', 'APPDATA', 'XDG_CONFIG_HOME']) saved[k] = process.env[k];
  process.env.MCP_CREDENTIAL_STORE = 'on';
  delete process.env.MCP_CREDENTIAL_STORE_DIR;
  process.env.APPDATA = dir;
  process.env.XDG_CONFIG_HOME = dir;
  mkdirSync(dirname(storeFile()), { recursive: true });
  kc = fakeKeychain();
  setKeychainForTests(kc);
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  setKeychainForTests(undefined);
  rmSync(dir, { recursive: true, force: true });
});

const add = (args: string[], s: Script = {}) => {
  const t = scripted({ stdin: KEY, ...s });
  return runSetupCli(['add', ...args], t.io).then((code) => ({ code, ...t }));
};

describe('setup add', () => {
  it('saves the key in the OS keychain by default, makes the first profile the default, never prints the key', async () => {
    const r = await add(['--url', URL_A, '--key-stdin']);
    expect(r.code).toBe(0);
    expect(readFile()).toEqual({ version: 1, profiles: { admin: { url: URL_A, keyStore: 'os' } }, default: 'admin' });
    expect(kc.entries).toEqual({ admin: KEY });
    expect(r.all()).toContain('key in the OS keychain (service "digital-ai-testing-mcp", account "admin")');
    expect(r.all()).toContain('The server starts on "admin"');
    expect(r.all()).not.toContain(KEY);
  });

  it('--plain-file keeps the key in the file and nothing in the keychain', async () => {
    const r = await add(['team', '--url', URL_A + '/', '--key-stdin', '--plain-file']);
    expect(r.code).toBe(0);
    expect(readFile().profiles).toEqual({ team: { url: URL_A, key: KEY } });
    expect(kc.entries).toEqual({});
  });

  it('interactive: adds https://, hides the key, suggests a name from the project', async () => {
    const r = await add([], { interactive: true, stdin: undefined, answers: ['tenant.example.com', ''], secrets: [KEY], verify: async () => PROJECT_USER });
    expect(r.code).toBe(0);
    expect(r.asked).toEqual([
      'Digital.ai Testing URL (e.g. https://yourcompany.experitest.com): ',
      'Access key (input hidden): ',
      'Profile name [mobile-qa]: ',
    ]);
    expect(readFile()).toMatchObject({ default: 'mobile-qa', profiles: { 'mobile-qa': { url: URL_A, keyStore: 'os' } } });
    expect(r.out).toContain('OK — Project User of project "Mobile QA".');
  });

  it('words the role for a person, and flags a Cloud-Admin-sounding name on a project key', async () => {
    const admin = await add(['team', '--url', URL_A, '--key-stdin']);
    expect(admin.out).toContain('OK — Cloud Admin.');

    const PROJECT_ADMIN: CredentialCheck = { ok: true, info: { level: 'project-admin', role: 'ProjectAdmin', projectName: 'DAIMCP POC', source: 'role' } };
    const misnamed = await add(['admin', '--url', URL_A, '--key-stdin'], { verify: async () => PROJECT_ADMIN });
    expect(misnamed.code).toBe(0); // a notice, not a refusal
    expect(misnamed.out).toContain('OK — Project Admin of project "DAIMCP POC".');
    expect(misnamed.out).toContain(
      'Note: "admin" holds a Project Admin key. switch_environment("admin") always picks this profile; ask for "cloud admin" to reach a Cloud Admin profile.'
    );

    const fine = await add(['cloud', '--url', URL_A, '--key-stdin']); // a real Cloud Admin key: no note
    expect(fine.all()).not.toContain('Note:');
    const projectNamed = await add(['qa', '--url', URL_A, '--key-stdin'], { verify: async () => PROJECT_ADMIN });
    expect(projectNamed.all()).not.toContain('Note:');
  });

  it('interactive: a URL typo is shown as typed and asked again; three misses end without saving', async () => {
    const retried = await add([], {
      interactive: true,
      stdin: undefined,
      answers: ['node dist/index.js setup remove admin', 'tenant.example.com', ''],
      secrets: [KEY],
    });
    expect(retried.code).toBe(0);
    expect(retried.err[0]).toBe(
      '"node dist/index.js setup remove admin" is not a URL. Enter the address you open the Digital.ai Testing portal with, e.g. https://yourcompany.experitest.com'
    );
    expect(readFile().profiles.admin.url).toBe(URL_A);

    rmSync(storeFile());
    const gaveUp = await add([], { interactive: true, stdin: undefined, answers: ['a b', 'ftp://x', 'c d'] });
    expect(gaveUp.code).toBe(2);
    expect(gaveUp.err.at(-1)).toMatch(/^"c d" is not a URL\. Nothing was saved\./);
    expect(existsSync(storeFile())).toBe(false);
  });

  it('a second profile asks before changing the default', async () => {
    await add(['first', '--url', URL_A, '--key-stdin']);
    const r = await add(['second', '--url', URL_A], { interactive: true, secrets: [KEY2], answers: ['n'] });
    expect(r.code).toBe(0);
    expect(r.asked.at(-1)).toBe('Make "second" the profile the server starts on (now "first")? [y/N] ');
    expect(readFile().default).toBe('first');
    expect(r.all()).toContain('The server still starts on "first"; switch with switch_environment("second")');
    expect((await add(['third', '--url', URL_A, '--key-stdin', '--default'])).code).toBe(0);
    expect(readFile().default).toBe('third');
  });

  it('replacing a profile needs confirmation; --yes replaces it', async () => {
    await add(['team', '--url', URL_A, '--key-stdin']);
    const refused = await add(['TEAM', '--url', 'https://other.example.com', '--key-stdin']);
    expect(refused.code).toBe(2);
    expect(refused.all()).toContain('Add --yes to replace it');
    expect(readFile().profiles.team.url).toBe(URL_A);
    const replaced = await add(['team', '--url', 'https://other.example.com', '--key-stdin', '--yes'], { stdin: KEY2 });
    expect(replaced.code).toBe(0);
    expect(readFile().profiles).toEqual({ team: { url: 'https://other.example.com', keyStore: 'os' } });
    expect(kc.entries.team).toBe(KEY2);
  });

  it('moving a key from the keychain to the file removes the keychain copy', async () => {
    await add(['team', '--url', URL_A, '--key-stdin']);
    expect(kc.entries.team).toBe(KEY);
    await add(['team', '--url', URL_A, '--key-stdin', '--plain-file', '--yes']);
    expect(readFile().profiles.team).toEqual({ url: URL_A, key: KEY });
    expect(kc.entries).toEqual({});
  });

  it('no usable keychain: refuses outside a terminal, offers the file in one', async () => {
    setKeychainForTests(null);
    const refused = await add(['team', '--url', URL_A, '--key-stdin']);
    expect(refused.code).toBe(2);
    expect(refused.all()).toContain('The OS keychain could not store the key');
    expect(refused.all()).toContain('Add --plain-file');
    expect(existsSync(storeFile())).toBe(false);
    const accepted = await add(['team', '--url', URL_A], { interactive: true, secrets: [KEY], answers: ['y'] });
    expect(accepted.code).toBe(0);
    expect(readFile().profiles.team).toEqual({ url: URL_A, key: KEY });
  });

  it('a refused key or an unreachable host saves nothing; --skip-check saves without checking', async () => {
    const rejected = await add(['team', '--url', URL_A, '--key-stdin'], { verify: async () => ({ ok: false, problem: 'rejected', status: 401 }) });
    expect(rejected.code).toBe(1);
    expect(rejected.all()).toContain('Not saved: the access key was refused (HTTP 401)');
    const unreachable = await add(['team', '--url', URL_A, '--key-stdin'], { verify: async () => ({ ok: false, problem: 'unreachable' }) });
    expect(unreachable.all()).toContain('To save it anyway, add --skip-check');
    expect(existsSync(storeFile())).toBe(false);
    expect(kc.entries).toEqual({});
    const skipped = await add(['team', '--url', URL_A, '--key-stdin', '--skip-check']);
    expect(skipped.code).toBe(0);
    expect(skipped.verifyCalls).toEqual([]);
  });

  it('usage errors exit 2 and change nothing', async () => {
    expect((await add(['team', '--key-stdin'])).code).toBe(2); // no URL outside a terminal
    expect((await add(['team', '--url', URL_A])).code).toBe(2); // no key outside a terminal
    expect((await add(['bad name!', '--url', URL_A, '--key-stdin'])).code).toBe(2);
    expect((await add(['team', '--url', 'ftp://x', '--key-stdin'])).code).toBe(2);
    expect((await add(['team', '--url', URL_A, '--key', KEY])).code).toBe(2); // a key is never an argument
    expect(existsSync(storeFile())).toBe(false);
  });

  it('never writes over a file it cannot read; points at a fix that can work', async () => {
    writeFileSync(storeFile(), `{"profiles": {"x": {"key": ${KEY}}}}`);
    const r = await add(['team', '--url', URL_A, '--key-stdin']);
    expect(r.code).toBe(1);
    expect(r.all()).toContain('cannot be changed: the file is not valid JSON');
    expect(r.all()).toMatch(/no backup to restore\), or start over with ".* reset"/); // no .bak: repair could not help
    expect(r.all()).not.toContain(KEY);
    expect(readFileSync(storeFile(), 'utf8')).toContain(KEY); // untouched
  });

  it('keeps entries it does not manage (broken profiles, unknown fields)', async () => {
    writeFileSync(storeFile(), JSON.stringify({ version: 1, note: 'mine', profiles: { broken: { url: 'nope' } } }));
    expect((await add(['team', '--url', URL_A, '--key-stdin'])).code).toBe(0);
    expect(readFile()).toMatchObject({ note: 'mine', profiles: { broken: { url: 'nope' }, team: { keyStore: 'os' } } });
  });
});

describe('setup list / default / remove / test / path', () => {
  it('list shows each profile, where its key is, the default, and what is broken', async () => {
    await add(['admin', '--url', URL_A, '--key-stdin']);
    await add(['qa', '--url', URL_A, '--key-stdin', '--plain-file']);
    const f = readFile();
    f.profiles.ghost = { url: URL_A, keyStore: 'os' };
    writeFileSync(storeFile(), JSON.stringify(f));
    const t = scripted();
    expect(await runSetupCli(['list'], t.io)).toBe(0);
    expect(t.out).toEqual([
      `Profiles file: ${storeFile()}`,
      `  admin (default): ${URL_A} — key in the OS keychain`,
      `  qa: ${URL_A} — key in this file`,
      '  ghost: NOT USABLE — its key is in the OS keychain, but there is no entry for it (service "digital-ai-testing-mcp", account "ghost")',
    ]);
    expect(t.all()).not.toContain(KEY);
  });

  it('list with no file says how to start', async () => {
    const t = scripted();
    expect(await runSetupCli(['list'], t.io)).toBe(0);
    expect(t.all()).toContain('No profiles yet');
  });

  it('default switches the starting profile; an unknown name fails', async () => {
    await add(['a', '--url', URL_A, '--key-stdin']);
    await add(['b', '--url', URL_A, '--key-stdin']);
    const t = scripted();
    expect(await runSetupCli(['default', 'B'], t.io)).toBe(0);
    expect(readFile().default).toBe('b');
    expect(await runSetupCli(['default', 'zzz'], scripted().io)).toBe(1);
  });

  it('remove needs confirmation, deletes the keychain entry, and explains the default afterwards', async () => {
    await add(['a', '--url', URL_A, '--key-stdin']);
    await add(['b', '--url', URL_A, '--key-stdin']);
    expect(await runSetupCli(['remove', 'a'], scripted().io)).toBe(2);
    expect(readFile().profiles.a).toBeDefined();
    const t = scripted();
    expect(await runSetupCli(['remove', 'a', '--yes'], t.io)).toBe(0);
    expect(readFile()).toEqual({ version: 1, profiles: { b: { url: URL_A, keyStore: 'os' } } });
    expect(kc.entries).toEqual({ b: KEY });
    expect(t.all()).toContain('It was the default; the server now starts on the only profile left, "b"');
  });

  it('test checks every profile and fails when one fails', async () => {
    await add(['good', '--url', URL_A, '--key-stdin']);
    await add(['bad', '--url', 'https://bad.example.com', '--key-stdin', '--skip-check']);
    const t = scripted({ verify: async (url) => (url.includes('bad') ? { ok: false, problem: 'rejected', status: 401 } : CLOUD_ADMIN) });
    expect(await runSetupCli(['test'], t.io)).toBe(1);
    expect(t.out.join('\n')).toMatch(/good: OK — /);
    expect(t.out.join('\n')).toContain('bad: FAILED — the access key was refused (HTTP 401)');
    expect(t.err).toEqual(['1 profile failed.']);
    expect(await runSetupCli(['test', 'good'], scripted().io)).toBe(0);
  });

  it('path prints the file location', async () => {
    const t = scripted();
    expect(await runSetupCli(['path'], t.io)).toBe(0);
    expect(t.out).toEqual([storeFile()]);
  });
});

describe('setup doctor', () => {
  const ENV_KEY = 'aut_1_doctorEnvKeyValue';
  afterEach(() => {
    delete process.env.DIGITAL_AI_ACCESS_KEY;
    delete process.env.DIGITAL_AI_BASE_URL;
  });

  it('reports install, environment (names only), store profiles with their check, and AI clients — never a key', async () => {
    await add(['admin', '--url', URL_A, '--key-stdin']); // keychain
    await add(['qa', '--url', URL_A, '--key-stdin', '--plain-file'], { stdin: KEY2 }); // file
    process.env.DIGITAL_AI_BASE_URL = 'https://env.example.com';
    process.env.DIGITAL_AI_ACCESS_KEY = ENV_KEY;
    const t = scripted();
    expect(await runSetupCli(['doctor'], t.io)).toBe(0);
    const text = t.all();
    expect(text).toMatch(/^Digital\.ai Testing MCP — setup doctor/);
    expect(text).toMatch(/Deployment mode: (local|docker)/);
    expect(text).toContain('DIGITAL_AI_BASE_URL: https://env.example.com · DIGITAL_AI_ACCESS_KEY: set');
    expect(text).toContain('OS keychain: available');
    expect(text).toMatch(/admin \(default\): https:\/\/tenant\.example\.com — key in the OS keychain — OK: Cloud Admin/);
    expect(text).toMatch(/qa: https:\/\/tenant\.example\.com — key in the file — OK/);
    expect(text).toContain('AI clients:');
    expect(text).toContain('No problems found.');
    for (const secret of [KEY, KEY2, ENV_KEY]) expect(text).not.toContain(secret);
    expect(t.verifyCalls).toEqual([URL_A, URL_A]);
  });

  it('marks failures and broken profiles, exits 1; --offline makes no API call', async () => {
    await add(['admin', '--url', URL_A, '--key-stdin']);
    const f = readFile();
    f.profiles.ghost = { url: URL_A, keyStore: 'os' };
    writeFileSync(storeFile(), JSON.stringify(f));
    const t = scripted({ verify: async () => ({ ok: false, problem: 'rejected', status: 401 }) });
    expect(await runSetupCli(['doctor'], t.io)).toBe(1);
    expect(t.all()).toContain('FAILED: the access key was refused (HTTP 401)');
    expect(t.all()).toContain('PROBLEM ghost: its key is in the OS keychain, but there is no entry for it');
    expect(t.all()).toContain('2 problems found');
    const offline = scripted();
    await runSetupCli(['doctor', '--offline'], offline.io);
    expect(offline.verifyCalls).toEqual([]);
  });
});

describe('setup repair / reset', () => {
  it('repair restores the backup and keeps the broken file', async () => {
    expect(await runSetupCli(['repair', '--yes'], scripted().io)).toBe(1); // no backup yet
    await add(['a', '--url', URL_A, '--key-stdin']);
    await add(['b', '--url', URL_A, '--key-stdin']); // the .bak holds the last saved version (a + b)
    writeFileSync(storeFile(), '{broken');
    expect(await runSetupCli(['repair'], scripted().io)).toBe(2); // needs confirmation
    const t = scripted();
    expect(await runSetupCli(['repair', '--yes'], t.io)).toBe(0);
    expect(Object.keys(readFile().profiles)).toEqual(['a', 'b']); // the hand edit is undone, the latest change kept
    expect(readFileSync(`${storeFile()}.before-repair`, 'utf8')).toBe('{broken');
  });

  it('a file broken after ONE save can be repaired (live 2026-11-18: there was no backup until the second save)', async () => {
    await add(['a', '--url', URL_A, '--key-stdin']);
    writeFileSync(storeFile(), readFileSync(storeFile(), 'utf8') + '{ broken\n');
    const list = scripted();
    await runSetupCli(['list'], list.io);
    expect(list.all()).toMatch(/repair" to restore the last version setup saved/);
    expect(await runSetupCli(['repair', '--yes'], scripted().io)).toBe(0);
    expect(Object.keys(readFile().profiles)).toEqual(['a']);
  });

  it('a broken file with no backup: the hint offers reset, not a repair that cannot work', async () => {
    mkdirSync(dirname(storeFile()), { recursive: true });
    writeFileSync(storeFile(), '{ hand-made and broken');
    const list = scripted();
    await runSetupCli(['list'], list.io);
    expect(list.all()).toMatch(/there is no backup to restore\), or start over with ".* reset"/);
    expect(list.all()).not.toMatch(/repair/);
    const remove = scripted();
    expect(await runSetupCli(['remove', 'a'], remove.io)).not.toBe(0);
    expect(remove.all()).toMatch(/start over with ".* reset"/);
  });

  it('a store moved with MCP_CREDENTIAL_STORE_DIR keeps its keys apart from the default store\'s, same profile names', async () => {
    await add(['admin', '--url', URL_A, '--key-stdin']); // the default store: account "admin"
    const other = mkdtempSync(join(tmpdir(), 'dai-setup-other-'));
    try {
      process.env.MCP_CREDENTIAL_STORE_DIR = other;
      const t = await add(['admin', '--url', URL_A, '--key-stdin'], { stdin: 'aut_1_other-store-key' });
      expect(t.code).toBe(0);
      const moved = Object.keys(kc.entries).find((a) => a !== 'admin')!;
      expect(moved).toMatch(/^admin@.+dai-setup-other-/i);
      expect(kc.entries.admin).toBe(KEY); // the real key is untouched
      expect(t.all()).toContain(`account "${moved}"`);
      expect(await runSetupCli(['remove', 'admin', '--yes'], scripted().io)).toBe(0);
      expect(kc.entries).toEqual({ admin: KEY }); // removing the test profile left the real key alone
      // the same folder given as the default location's own path is NOT an override
      process.env.MCP_CREDENTIAL_STORE_DIR = `${dirname(storeFile())}${process.platform === 'win32' ? '\\' : '/'}`;
      expect(keychainAccount('admin')).toBe('admin');
    } finally {
      delete process.env.MCP_CREDENTIAL_STORE_DIR;
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('reset removes the files and the keychain entries they point to', async () => {
    await add(['a', '--url', URL_A, '--key-stdin']);
    await add(['b', '--url', URL_A, '--key-stdin', '--plain-file']);
    kc.entries.unrelated = 'keep-me';
    const t = scripted();
    expect(await runSetupCli(['reset', '--yes'], t.io)).toBe(0);
    expect(existsSync(storeFile())).toBe(false);
    expect(existsSync(`${storeFile()}.bak`)).toBe(false);
    expect(kc.entries).toEqual({ unrelated: 'keep-me' });
    expect(t.all()).toContain('Removed 2 files and 1 OS keychain entry');
  });
});

describe('setup usage', () => {
  it('help, unknown commands and no command outside a terminal', async () => {
    const help = scripted();
    expect(await runSetupCli(['help'], help.io)).toBe(0);
    expect(help.all()).toContain('Usage: digital-ai-testing-mcp setup');
    expect(await runSetupCli(['frobnicate'], scripted().io)).toBe(2);
    expect(await runSetupCli([], scripted().io)).toBe(2);
  });
});

describe('verifyCredential (stub API)', () => {
  it('tells accepted, refused, not-the-API and unreachable apart', async () => {
    clearAccessInfoCache();
    const api = await startStubApi(
      (req) => {
        if (req.headers['x-api-key'] === 'aut_1_refused' || req.headers.authorization === 'Bearer aut_1_refused') return reply(401, { message: 'Unauthorized' });
        if (req.path === '/api/v1/users/my-account-info') return accountInfo('ProjectAdmin', 'Mobile QA');
        return undefined;
      },
      { noResetClient: true }
    );
    const html = await startStubApi(() => reply(200, '<html>login</html>'), { noResetClient: true });
    try {
      const ok = await verifyCredential(api.baseUrl, 'aut_1_good');
      expect(ok).toMatchObject({ ok: true, info: { level: 'project-admin', projectName: 'Mobile QA' } });
      expect(await verifyCredential(api.baseUrl, 'aut_1_refused')).toEqual({ ok: false, problem: 'rejected', status: 401 });
      expect(await verifyCredential(html.baseUrl, 'aut_1_good')).toEqual({ ok: false, problem: 'not-api', status: 200 });
      expect(await verifyCredential('http://127.0.0.1:9', 'aut_1_good')).toEqual({ ok: false, problem: 'unreachable' });
    } finally {
      await api.close();
      await html.close();
    }
  });
});

// ─── The real entry point, as `npx digital-ai-testing-mcp setup …` runs it ─────

const ENTRY = resolve(__dirname, '..', 'src', 'index.ts');
const TSX_LOADER = import.meta.resolve('tsx');

function runEntry(args: string[], stdin: string, env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const childEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(DIGITAL_AI_|DAI_PROFILE_|MCP_)/.test(k)) childEnv[k] = v;
    const child = spawn(process.execPath, ['--import', TSX_LOADER, ENTRY, ...args], { cwd: dir, env: { ...childEnv, MCP_UPDATE_CHECK: 'false', ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => done({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

describe('setup through the entry point (child process)', () => {
  it('runs the command and exits instead of starting the server', async () => {
    const r = await runEntry(['setup', 'path'], '', { MCP_CREDENTIAL_STORE_DIR: dirname(storeFile()) });
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe(storeFile());
    expect(r.stderr).not.toContain('starting...');
  }, 60_000);

  it('add with a piped key checks it against the API and saves it (plain file — no real keychain in tests)', async () => {
    const api = await startStubApi((req) => (req.path === '/api/v1/users/my-account-info' ? accountInfo('Admin', 'Default') : undefined), { noResetClient: true });
    try {
      const r = await runEntry(['setup', 'add', 'ci', '--url', api.baseUrl, '--key-stdin', '--plain-file'], KEY + '\n', { MCP_CREDENTIAL_STORE_DIR: dirname(storeFile()) });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('Saved profile "ci"');
      expect(r.stdout + r.stderr).not.toContain(KEY);
      expect(readFile()).toEqual({ version: 1, profiles: { ci: { url: api.baseUrl, key: KEY } }, default: 'ci' });
      expect(api.requests.some((q) => q.path === '/api/v1/users/my-account-info')).toBe(true);
    } finally {
      await api.close();
    }
  }, 60_000);
});
