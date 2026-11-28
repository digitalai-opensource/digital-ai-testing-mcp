/**
 * Local credential store (src/utils/credential-store.ts) and how profile-loader.ts / client.ts use it.
 *
 * vitest.config.ts turns the store off for every test; the cases here turn it on against a temp folder, so a
 * developer's own profiles.json is never read.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  deleteKeyFromKeychain,
  getKeychain,
  isStoreEnabled,
  jsonErrorPosition,
  KEYCHAIN_SERVICE,
  keychainAccount,
  keychainLoadError,
  keychainLookup,
  saveKeyToKeychain,
  setKeychainForTests,
  type Keychain,
  parseStore,
  readStore,
  storeDir,
  writeStore,
  STORE_FILE_NAME,
} from '../src/utils/credential-store.js';
import {
  describeStartingProfile,
  getProfileCredentials,
  getStartingProfile,
  getStoreStatus,
  listProfiles,
  resetProfilesForTests,
  startupCredentialProblem,
  loneAccessKeyNote,
} from '../src/utils/profile-loader.js';
import { getActiveAccessKey, getActiveProfileName, getActiveUrl } from '../src/api/client.js';
import { registerMetaTools } from '../src/tools/meta-tools.js';
import { startStubApi, accountInfo, connectTools } from './helpers/offline.js';

const KEY_A = 'aut_1_storeTestKeyAlpha';
const KEY_B = 'aut_1_storeTestKeyBravo';
const KEY_ENV = 'aut_1_envTestKey';

describe('store location and switch', () => {
  it('keychain account: the profile name at the default location, "<name>@<folder>" when the store is moved', () => {
    const win = { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' };
    expect(keychainAccount('admin', win, 'win32')).toBe('admin');
    expect(keychainAccount('admin', { ...win, MCP_CREDENTIAL_STORE_DIR: '  ' }, 'win32')).toBe('admin');
    // the default folder named explicitly (any case, trailing slash) is not a move
    expect(keychainAccount('admin', { ...win, MCP_CREDENTIAL_STORE_DIR: 'c:\\users\\U\\AppData\\Roaming\\Digital-AI-Testing\\' }, 'win32')).toBe('admin');
    expect(keychainAccount('admin', { ...win, MCP_CREDENTIAL_STORE_DIR: 'D:\\Temp\\dai-store-test' }, 'win32')).toBe('admin@d:\\temp\\dai-store-test');
    const posixEnv = { XDG_CONFIG_HOME: '/home/u/.config' };
    expect(keychainAccount('qa', posixEnv, 'linux')).toBe('qa');
    expect(keychainAccount('qa', { ...posixEnv, MCP_CREDENTIAL_STORE_DIR: '/tmp/Store/' }, 'linux')).toBe('qa@/tmp/Store');
  });

  it('uses %APPDATA% on Windows and XDG / ~/.config elsewhere; MCP_CREDENTIAL_STORE_DIR overrides', () => {
    expect(storeDir({ APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, 'win32')).toBe(join('C:\\Users\\u\\AppData\\Roaming', 'digital-ai-testing'));
    expect(storeDir({ XDG_CONFIG_HOME: '/home/u/.cfg' }, 'linux')).toBe(join('/home/u/.cfg', 'digital-ai-testing'));
    expect(storeDir({}, 'darwin')).toMatch(/[\\/]\.config[\\/]digital-ai-testing$/);
    expect(storeDir({ MCP_CREDENTIAL_STORE_DIR: '/x/y', APPDATA: 'C:\\a' }, 'win32')).toBe('/x/y');
  });
  it('MCP_CREDENTIAL_STORE=off|false|0|no disables it; anything else (or unset) leaves it on', () => {
    for (const v of ['off', 'OFF', 'false', '0', 'no']) expect(isStoreEnabled({ MCP_CREDENTIAL_STORE: v })).toBe(false);
    for (const v of [undefined, '', 'on', 'true']) expect(isStoreEnabled({ MCP_CREDENTIAL_STORE: v })).toBe(true);
  });
});

describe('parseStore', () => {
  it('accepts valid profiles, lowercases names and trims trailing slashes', () => {
    const r = parseStore({ version: 1, default: 'Admin', profiles: { Admin: { url: 'https://t.example.com/', key: KEY_A } } }, 'p');
    expect(r.error).toBeUndefined();
    expect(r.profiles).toEqual({ admin: { url: 'https://t.example.com', key: KEY_A, keyStore: 'file' } });
    expect(r.defaultProfile).toBe('admin');
    expect(r.skipped).toEqual([]);
  });
  it('skips bad profiles with a reason and keeps the good ones', () => {
    const r = parseStore(
      {
        profiles: {
          good: { url: 'https://t.example.com', key: KEY_A },
          'bad name!': { url: 'https://t.example.com', key: KEY_B },
          nokey: { url: 'https://t.example.com' },
          badurl: { url: 'ftp://t.example.com', key: KEY_B },
          GOOD: { url: 'https://t.example.com', key: KEY_B },
        },
      },
      'p'
    );
    expect(Object.keys(r.profiles)).toEqual(['good']);
    expect(r.skipped.map((s) => s.name)).toEqual(['bad name!', 'nokey', 'badurl', 'GOOD']);
    expect(JSON.stringify(r.skipped)).not.toContain(KEY_B);
  });
  it('a default that names no usable profile is reported, not guessed', () => {
    const r = parseStore({ default: 'nokey', profiles: { nokey: { url: 'https://t.example.com' } } }, 'p');
    expect(r.defaultProfile).toBeUndefined();
    expect(r.skipped).toContainEqual({ name: '(default)', reason: '"default" names "nokey", which is not a usable profile' });
  });
  it('rejects the whole file for a wrong shape or a newer format', () => {
    expect(parseStore([], 'p').error).toBe('the file is not a JSON object');
    expect(parseStore({ version: 1 }, 'p').error).toBe('the file has no "profiles" object');
    expect(parseStore({ version: 2, profiles: {} }, 'p').error).toContain('format version 2');
  });
});

describe('keychainLoadError', () => {
  const napi = new Error('Cannot find native binding. npm has a bug related to optional dependencies (https://github.com/npm/cli/issues/4828).');
  it("Windows without the Visual C++ runtime: names it and links Microsoft's installer, not the npm bug", () => {
    const msg = keychainLoadError(napi, 'win32', () => false);
    expect(msg).toContain('Microsoft Visual C++ runtime');
    expect(msg).toContain('https://aka.ms/vs/17/release/vc_redist.x64.exe');
    expect(msg).not.toContain('npm has a bug');
  });
  it("anything else keeps the library's own reason", () => {
    expect(keychainLoadError(napi, 'win32', () => true)).toMatch(/^the OS keychain library could not be loaded \(Cannot find native binding/);
    expect(keychainLoadError(napi, 'linux', () => false)).toMatch(/^the OS keychain library could not be loaded/);
  });
});

describe('jsonErrorPosition', () => {
  it('reports a line and column, never the quoted input', () => {
    const text = `{"profiles": {"x": {"key": "${KEY_A}"\n "url": 1}}}`;
    let err: unknown;
    try {
      JSON.parse(text);
    } catch (e) {
      err = e;
    }
    expect(jsonErrorPosition(err, text)).toMatch(/^ \(line 2, column \d+\)$/);
    // V8 quotes the input for an unexpected token — that message must not reach the result.
    const leaky = `{"a": ${KEY_A}}`;
    try {
      JSON.parse(leaky);
    } catch (e) {
      expect((e as Error).message).toContain('aut_1_');
      expect(jsonErrorPosition(e, leaky)).not.toContain('aut_1_');
    }
  });
});

describe('readStore / writeStore', () => {
  let dir: string;
  const env = () => ({ MCP_CREDENTIAL_STORE_DIR: dir });
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'dai-store-'))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('no file → exists:false, no error', () => {
    expect(readStore(env())).toMatchObject({ enabled: true, exists: false, profiles: {}, skipped: [] });
  });
  it('off → enabled:false, the file is not read', () => {
    writeFileSync(join(dir, STORE_FILE_NAME), '{not json');
    expect(readStore({ ...env(), MCP_CREDENTIAL_STORE: 'off' })).toMatchObject({ enabled: false, exists: false });
  });
  it('invalid JSON is an error naming the position, never the content', () => {
    writeFileSync(join(dir, STORE_FILE_NAME), `{"profiles": {"a": {"url": "https://t.example.com", "key": ${KEY_A}}}}`);
    const r = readStore(env());
    expect(r.error).toMatch(/^the file is not valid JSON/);
    expect(r.error).not.toContain('aut_1_');
  });
  it('a UTF-8 BOM (Notepad) is accepted', () => {
    writeFileSync(join(dir, STORE_FILE_NAME), '\uFEFF' + JSON.stringify({ profiles: { a: { url: 'https://t.example.com', key: KEY_A } } }));
    expect(readStore(env()).profiles.a?.key).toBe(KEY_A);
  });
  it('writes atomically, stamps the version, keeps a copy of what it wrote as .bak (from the first save)', () => {
    const path = writeStore({ version: 0, default: 'a', profiles: { a: { url: 'https://t.example.com', key: KEY_A } } }, env());
    expect(JSON.parse(readFileSync(path, 'utf8')).version).toBe(1);
    expect(readFileSync(`${path}.bak`, 'utf8')).toBe(readFileSync(path, 'utf8'));
    writeStore({ version: 1, default: 'b', profiles: { b: { url: 'https://t.example.com', key: KEY_B } } }, env());
    expect(readStore(env())).toMatchObject({ defaultProfile: 'b', profiles: { b: { key: KEY_B } } });
    expect(JSON.parse(readFileSync(`${path}.bak`, 'utf8')).default).toBe('b');
    if (process.platform !== 'win32') {
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(`${path}.bak`).mode & 0o777).toBe(0o600);
    }
  });
});

describe('profile-loader with the store', () => {
  let dir: string;
  const saved: Record<string, string | undefined> = {};
  const VARS = ['MCP_CREDENTIAL_STORE', 'MCP_CREDENTIAL_STORE_DIR', 'DIGITAL_AI_BASE_URL', 'DIGITAL_AI_ACCESS_KEY'];

  function store(content: object | string) {
    writeFileSync(join(dir, STORE_FILE_NAME), typeof content === 'string' ? content : JSON.stringify(content));
    resetProfilesForTests();
  }
  const twoProfiles = (extra: object = {}) => ({
    profiles: { alpha: { url: 'https://alpha.example.com', key: KEY_A }, bravo: { url: 'https://bravo.example.com', key: KEY_B } },
    ...extra,
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dai-loader-'));
    for (const k of [...VARS, ...Object.keys(process.env).filter((k) => k.startsWith('DAI_PROFILE_'))]) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    process.env.MCP_CREDENTIAL_STORE = 'on';
    process.env.MCP_CREDENTIAL_STORE_DIR = dir;
    resetProfilesForTests();
  });
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (k.startsWith('DAI_PROFILE_')) delete process.env[k];
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetProfilesForTests();
    rmSync(dir, { recursive: true, force: true });
  });

  it('store only: starts on the store default, lists sources, and client.ts uses it before the first call', () => {
    store(twoProfiles({ default: 'bravo' }));
    expect(startupCredentialProblem()).toBeNull();
    expect(describeStartingProfile()).toEqual({ name: 'bravo', url: 'https://bravo.example.com', source: 'store' });
    expect(listProfiles().map((p) => `${p.name}:${p.source}`).sort()).toEqual(['alpha:store', 'bravo:store']);
    expect(getActiveProfileName()).toBe('bravo');
    expect(getActiveUrl()).toBe('https://bravo.example.com');
    expect(getActiveAccessKey()).toBe(KEY_B);
  });

  it('environment default wins and starts the session; store profiles are added beside it', () => {
    process.env.DIGITAL_AI_BASE_URL = 'https://env.example.com/';
    process.env.DIGITAL_AI_ACCESS_KEY = KEY_ENV;
    store(twoProfiles({ default: 'bravo' }));
    expect(getStartingProfile()).toMatchObject({ name: 'default', url: 'https://env.example.com', source: 'env' });
    expect(listProfiles().map((p) => `${p.name}:${p.source}`).sort()).toEqual(['alpha:store', 'bravo:store', 'default:env']);
    expect(getActiveAccessKey()).toBe(KEY_ENV);
  });

  it('a name defined by both: the environment wins and the store entry is reported as shadowed', () => {
    process.env.DAI_PROFILE_ALPHA_URL = 'https://env-alpha.example.com';
    process.env.DAI_PROFILE_ALPHA_KEY = KEY_ENV;
    store(twoProfiles({ default: 'bravo' }));
    expect(getProfileCredentials('alpha')).toEqual({ url: 'https://env-alpha.example.com', key: KEY_ENV });
    expect(getStoreStatus().shadowed).toEqual(['alpha']);
  });

  it('a store default shadowed by the environment starts on the environment version', () => {
    process.env.DAI_PROFILE_ALPHA_URL = 'https://env-alpha.example.com';
    process.env.DAI_PROFILE_ALPHA_KEY = KEY_ENV;
    store(twoProfiles({ default: 'alpha' }));
    expect(getStartingProfile()).toMatchObject({ name: 'alpha', url: 'https://env-alpha.example.com', source: 'env' });
  });

  it('only one default variable set: reports it instead of falling back to the store', () => {
    process.env.DIGITAL_AI_BASE_URL = 'https://env.example.com';
    store(twoProfiles({ default: 'bravo' }));
    expect(startupCredentialProblem()).toEqual({ missing: ['DIGITAL_AI_ACCESS_KEY'] });
  });

  it('only DIGITAL_AI_ACCESS_KEY set (the generated tests\' variable): the store starts the session, with a note', () => {
    process.env.DIGITAL_AI_ACCESS_KEY = KEY_ENV;
    store(twoProfiles({ default: 'bravo' }));
    expect(startupCredentialProblem()).toBeNull();
    expect(getStartingProfile()).toMatchObject({ name: 'bravo', source: 'store' });
    expect(getActiveAccessKey()).toBe(KEY_B);
    expect(loneAccessKeyNote()).toMatch(/without DIGITAL_AI_BASE_URL[\s\S]*saved profile "bravo"/);
    expect(loneAccessKeyNote()).not.toContain(KEY_ENV);
  });

  it('only DIGITAL_AI_ACCESS_KEY set and no usable store profile: setup mode names the URL', () => {
    process.env.DIGITAL_AI_ACCESS_KEY = KEY_ENV;
    store(twoProfiles({}));
    expect(startupCredentialProblem()).toEqual({ missing: ['DIGITAL_AI_BASE_URL'] });
    expect(loneAccessKeyNote()).toBeUndefined();
  });

  it('one store profile and no "default": starts on it', () => {
    store({ profiles: { solo: { url: 'https://solo.example.com', key: KEY_A } } });
    expect(describeStartingProfile()?.name).toBe('solo');
  });

  it('several store profiles and no "default": setup mode says so', () => {
    store(twoProfiles());
    const p = startupCredentialProblem();
    expect(p?.missing).toEqual(['DIGITAL_AI_BASE_URL', 'DIGITAL_AI_ACCESS_KEY']);
    expect(p?.storeNote).toContain('has profiles (alpha, bravo) but no usable "default"');
  });

  it('a "default" naming a broken profile never falls through to another one', () => {
    store({ default: 'broken', profiles: { broken: { url: 'https://x.example.com' }, good: { url: 'https://g.example.com', key: KEY_A } } });
    expect(getStartingProfile()).toBeUndefined();
    const note = startupCredentialProblem()?.storeNote ?? '';
    expect(note).toContain('Skipped: broken — "key" is missing or empty');
    expect(note).not.toContain(KEY_A);
  });

  it('an unusable file: setup mode names the problem; environment profiles still load', () => {
    process.env.DAI_PROFILE_QA_URL = 'https://qa.example.com';
    process.env.DAI_PROFILE_QA_KEY = KEY_ENV;
    store(`{"profiles": {"alpha": {"url": "https://a.example.com", "key": ${KEY_A}}}}`);
    expect(startupCredentialProblem()?.storeNote).toMatch(/could not be used: the file is not valid JSON/);
    expect(startupCredentialProblem()?.storeNote).not.toContain('aut_1_');
    expect(listProfiles().map((p) => p.name)).toEqual(['qa']);
  });

  it('MCP_CREDENTIAL_STORE=off ignores the file entirely', () => {
    process.env.MCP_CREDENTIAL_STORE = 'off';
    store(twoProfiles({ default: 'bravo' }));
    expect(listProfiles()).toEqual([]);
    expect(startupCredentialProblem()).toEqual({ missing: ['DIGITAL_AI_BASE_URL', 'DIGITAL_AI_ACCESS_KEY'], storeNote: undefined });
  });
});

// ─── OS keychain ("keyStore": "os") ───────────────────────────────────────────
// A fake keychain stands in for the OS one: tests never read or write a real entry.

function fakeKeychain(entries: Record<string, string> = {}, opts: { throwOnGet?: string } = {}): Keychain & { entries: Record<string, string> } {
  return {
    entries,
    get(account) {
      if (opts.throwOnGet) throw new Error(opts.throwOnGet);
      return entries[account] ?? null;
    },
    set(account, secret) {
      entries[account] = secret;
    },
    delete(account) {
      const had = account in entries;
      delete entries[account];
      return had;
    },
  };
}

describe('keyStore "os"', () => {
  afterEach(() => setKeychainForTests(undefined));
  const lookupWith = (k: Keychain | null) => {
    setKeychainForTests(k);
    return keychainLookup;
  };
  const osProfile = { profiles: { team: { url: 'https://t.example.com', keyStore: 'os' } } };

  it('reads the key from the keychain (service digital-ai-testing-mcp, account = profile name)', () => {
    const r = parseStore(osProfile, 'p', lookupWith(fakeKeychain({ team: KEY_A })));
    expect(r.profiles).toEqual({ team: { url: 'https://t.example.com', key: KEY_A, keyStore: 'os' } });
    expect(KEYCHAIN_SERVICE).toBe('digital-ai-testing-mcp');
  });
  it('no keychain entry → skipped, naming the service and account', () => {
    const r = parseStore(osProfile, 'p', lookupWith(fakeKeychain()));
    expect(r.skipped).toEqual([
      { name: 'team', reason: 'its key is in the OS keychain, but there is no entry for it (service "digital-ai-testing-mcp", account "team")' },
    ]);
  });
  it('keychain unavailable or failing → skipped with the reason; other profiles still load', () => {
    const mixed = { profiles: { ...osProfile.profiles, plain: { url: 'https://p.example.com', key: KEY_B } } };
    const unavailable = parseStore(mixed, 'p', lookupWith(null));
    expect(Object.keys(unavailable.profiles)).toEqual(['plain']);
    expect(unavailable.skipped[0].reason).toMatch(/^its key is in the OS keychain, which cannot be used here/);
    const failing = parseStore(osProfile, 'p', lookupWith(fakeKeychain({}, { throwOnGet: 'Access denied' })));
    expect(failing.skipped[0].reason).toBe('its key is in the OS keychain, which could not be read (Access denied)');
  });
  it('without a lookup (pure parse), keychain profiles are skipped, not guessed', () => {
    expect(parseStore(osProfile, 'p').skipped[0].reason).toBe('its key is in the OS keychain, which is not read here');
  });
  it('rejects "key" together with "keyStore", and any keyStore other than "os"', () => {
    const r = parseStore(
      {
        profiles: {
          both: { url: 'https://t.example.com', keyStore: 'os', key: KEY_A },
          other: { url: 'https://t.example.com', keyStore: 'vault' },
        },
      },
      'p',
      lookupWith(fakeKeychain({ both: KEY_A }))
    );
    expect(r.profiles).toEqual({});
    expect(r.skipped.map((s) => s.reason)).toEqual(['has both "key" and "keyStore" — keep one', '"keyStore" must be "os" (got "vault")']);
    expect(JSON.stringify(r.skipped)).not.toContain(KEY_A);
  });
  it('a default naming a keychain profile whose entry is missing is reported, never replaced', () => {
    const r = parseStore(
      { default: 'team', profiles: { ...osProfile.profiles, plain: { url: 'https://p.example.com', key: KEY_B } } },
      'p',
      lookupWith(fakeKeychain())
    );
    expect(r.defaultProfile).toBeUndefined();
    expect(r.skipped.map((s) => s.name)).toEqual(['team', '(default)']);
  });
  it('saveKeyToKeychain / deleteKeyFromKeychain report the outcome and never throw', () => {
    const k = fakeKeychain();
    setKeychainForTests(k);
    expect(saveKeyToKeychain('team', KEY_A)).toEqual({ ok: true });
    expect(k.entries.team).toBe(KEY_A);
    expect(deleteKeyFromKeychain('team')).toEqual({ ok: true, existed: true });
    expect(deleteKeyFromKeychain('team')).toEqual({ ok: true, existed: false });
    setKeychainForTests(null);
    expect(saveKeyToKeychain('team', KEY_A)).toEqual({ ok: false, error: 'the OS keychain is not available' });
    expect(deleteKeyFromKeychain('team').ok).toBe(false);
  });
  it('the real optional dependency loads on this platform (load only — no entry is read or written)', () => {
    setKeychainForTests(undefined);
    const { keychain, error } = getKeychain();
    expect(error).toBeUndefined();
    expect(typeof keychain?.get).toBe('function');
  });
});

describe('profile-loader with keychain profiles', () => {
  let dir: string;
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dai-loader-kc-'));
    for (const k of ['MCP_CREDENTIAL_STORE', 'MCP_CREDENTIAL_STORE_DIR', 'DIGITAL_AI_BASE_URL', 'DIGITAL_AI_ACCESS_KEY', 'APPDATA', 'XDG_CONFIG_HOME']) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    process.env.MCP_CREDENTIAL_STORE = 'on';
    // default location (keychain account = profile name), as for a customer
    process.env.APPDATA = dir;
    process.env.XDG_CONFIG_HOME = dir;
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    setKeychainForTests(undefined);
    resetProfilesForTests();
    rmSync(dir, { recursive: true, force: true });
  });

  it('starts on a keychain default and reports where each key is kept', () => {
    setKeychainForTests(fakeKeychain({ team: KEY_A }));
    writeStore(
      { version: 1, default: 'team', profiles: { team: { url: 'https://t.example.com', keyStore: 'os' }, qa: { url: 'https://q.example.com', key: KEY_B } } },
      { APPDATA: dir, XDG_CONFIG_HOME: dir }
    );
    resetProfilesForTests();
    expect(getStartingProfile()).toMatchObject({ name: 'team', key: KEY_A, source: 'store' });
    expect(listProfiles().map((p) => `${p.name}:${p.keyStore}`).sort()).toEqual(['qa:file', 'team:os']);
    expect(JSON.stringify(listProfiles())).not.toContain('aut_1_');
  });
  it('a missing keychain entry for the default: setup mode explains it', () => {
    setKeychainForTests(fakeKeychain());
    writeStore({ version: 1, default: 'team', profiles: { team: { url: 'https://t.example.com', keyStore: 'os' } } }, { APPDATA: dir, XDG_CONFIG_HOME: dir });
    resetProfilesForTests();
    expect(startupCredentialProblem()?.storeNote).toContain('there is no entry for it (service "digital-ai-testing-mcp", account "team")');
  });
});

describe('get_server_info names where the active credential comes from', () => {
  let dir: string;
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dai-info-'));
    for (const k of ['MCP_CREDENTIAL_STORE', 'MCP_CREDENTIAL_STORE_DIR', 'DIGITAL_AI_BASE_URL', 'DIGITAL_AI_ACCESS_KEY']) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    process.env.MCP_CREDENTIAL_STORE = 'on';
    process.env.MCP_CREDENTIAL_STORE_DIR = dir;
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetProfilesForTests();
    rmSync(dir, { recursive: true, force: true });
  });

  it('a store profile: "from the credential store (key in …)"', async () => {
    const api = await startStubApi((req) => (req.path === '/api/v1/users/my-account-info' ? accountInfo('Admin', 'Default') : undefined), { noResetClient: true });
    try {
      writeStore({ version: 1, default: 'team', profiles: { team: { url: api.baseUrl, key: KEY_A } } }, { MCP_CREDENTIAL_STORE_DIR: dir });
      resetProfilesForTests();
      const tools = await connectTools(registerMetaTools);
      const text = (await tools.call('get_server_info', {})).text;
      expect(text).toMatch(/Active profile: +"team" — .* · from the credential store \(key in the profiles file\)/);
      expect(text).not.toContain(KEY_A);
    } finally {
      await api.close();
    }
  });
});
