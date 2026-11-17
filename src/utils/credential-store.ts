/**
 * Local credential store — named connection profiles in one file per user, read by profile-loader.ts.
 *
 * Location: MCP_CREDENTIAL_STORE_DIR, else %APPDATA%\digital-ai-testing (Windows) or
 * $XDG_CONFIG_HOME/digital-ai-testing, else ~/.config/digital-ai-testing. File: profiles.json.
 * MCP_CREDENTIAL_STORE=off disables it completely.
 *
 *   { "version": 1, "default": "admin",
 *     "profiles": { "admin": { "url": "https://tenant.experitest.com", "keyStore": "os" },
 *                   "qa":    { "url": "https://tenant.experitest.com", "key": "…" } } }
 *
 * The store is ADDITIVE: environment variables always win (profile-loader.ts applies the precedence). This module only
 * reads, validates and writes the file, and never throws on bad content: an unreadable file or a bad profile becomes
 * an error / skipped entry with a reason, so the server can still start and say what is wrong.
 *
 * Where a profile's key lives:
 *   "keyStore": "os" — the OS keychain (macOS Keychain, Windows Credential Manager, Linux Secret Service) under service
 *                      KEYCHAIN_SERVICE, account = profile name, through the OPTIONAL dependency @napi-rs/keyring. It is
 *                      loaded lazily, only when a profile needs it; if it cannot load (no prebuilt binary, Linux without a
 *                      keyring service) or has no entry, that profile is skipped with the reason.
 *   "key": "…"       — plain-file mode: the key is in this file (user-only folder, mode 0600 where the OS honours it — on
 *                      Windows the per-user %APPDATA% ACL is what protects it).
 * Measured on Windows 11 (2026-11-17): library load 11–161 ms once per process, a key read ~3 ms.
 *
 * Credential values never leave this module except through profile-loader.ts.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, copyFileSync, chmodSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ─── OS keychain ──────────────────────────────────────────────────────────────

export const KEYCHAIN_SERVICE = 'digital-ai-testing-mcp';

/** The three calls the store needs; the real one wraps @napi-rs/keyring's synchronous Entry. */
export interface Keychain {
  get(account: string): string | null;
  set(account: string, secret: string): void;
  delete(account: string): boolean;
}

/** Local shape of the optional dependency — no type import, so type-checking never depends on it being installed. */
interface KeyringModule {
  Entry: new (service: string, username: string) => {
    getPassword(): string | null;
    setPassword(password: string): void;
    deletePassword(): boolean;
  };
}

let _keychain: { keychain?: Keychain; error?: string } | undefined;
let _keychainOverride: Keychain | null | undefined;

/** Test hook: a fake keychain, null for "unavailable", undefined to go back to the real one. */
export function setKeychainForTests(k: Keychain | null | undefined): void {
  _keychainOverride = k;
}

function shortError(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).split('\n')[0].slice(0, 200);
}

/** The OS keychain, loaded on first use. Never throws: an unusable keychain comes back as an error. */
export function getKeychain(): { keychain?: Keychain; error?: string } {
  if (_keychainOverride !== undefined) {
    return _keychainOverride ? { keychain: _keychainOverride } : { error: 'the OS keychain is not available' };
  }
  if (!_keychain) {
    try {
      const { Entry } = createRequire(import.meta.url)('@napi-rs/keyring') as KeyringModule;
      _keychain = {
        keychain: {
          get: (account) => new Entry(KEYCHAIN_SERVICE, account).getPassword(),
          set: (account, secret) => new Entry(KEYCHAIN_SERVICE, account).setPassword(secret),
          delete: (account) => new Entry(KEYCHAIN_SERVICE, account).deletePassword(),
        },
      };
    } catch (e) {
      _keychain = { error: `the OS keychain library could not be loaded (${shortError(e)})` };
    }
  }
  return _keychain;
}

/** Reads one profile's key from the keychain: the key, or why there is none. */
export type KeyLookup = (profile: string) => { key?: string; reason?: string };

export const keychainLookup: KeyLookup = (profile) => {
  const { keychain, error } = getKeychain();
  if (!keychain) return { reason: `its key is in the OS keychain, which cannot be used here: ${error}` };
  try {
    const key = keychain.get(profile)?.trim();
    return key
      ? { key }
      : { reason: `its key is in the OS keychain, but there is no entry for it (service "${KEYCHAIN_SERVICE}", account "${profile}")` };
  } catch (e) {
    return { reason: `its key is in the OS keychain, which could not be read (${shortError(e)})` };
  }
};

/** Saves a profile's key in the keychain (for the setup command). Never throws. */
export function saveKeyToKeychain(profile: string, key: string): { ok: boolean; error?: string } {
  const { keychain, error } = getKeychain();
  if (!keychain) return { ok: false, error };
  try {
    keychain.set(profile, key);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `the OS keychain could not save it (${shortError(e)})` };
  }
}

/** Removes a profile's key from the keychain. `existed` is false when there was no entry. Never throws. */
export function deleteKeyFromKeychain(profile: string): { ok: boolean; existed?: boolean; error?: string } {
  const { keychain, error } = getKeychain();
  if (!keychain) return { ok: false, error };
  try {
    return { ok: true, existed: keychain.delete(profile) };
  } catch (e) {
    return { ok: false, error: `the OS keychain could not delete it (${shortError(e)})` };
  }
}

// ─── The profiles file ────────────────────────────────────────────────────────

export const STORE_FORMAT_VERSION = 1;
export const STORE_FILE_NAME = 'profiles.json';

/** Same shape as env profile names after lowercasing (DAI_PROFILE_QA_TEAM_* → qa_team). */
export const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** A usable profile after reading: the key is resolved, wherever it was kept. */
export interface StoredProfile {
  url: string;
  key: string;
  keyStore: 'os' | 'file';
}

/** A profile as written to the file: the key itself (plain-file mode) or a pointer to the OS keychain. */
export type StoreFileProfile = { url: string; key: string } | { url: string; keyStore: 'os' };

export interface StoreFile {
  version: number;
  default?: string;
  profiles: Record<string, StoreFileProfile>;
}

export interface StoreReadResult {
  /** false when MCP_CREDENTIAL_STORE=off */
  enabled: boolean;
  path: string;
  exists: boolean;
  /** The whole file could not be used (unreadable, invalid JSON, wrong shape, newer format). */
  error?: string;
  /** Usable profiles, names lowercased, URLs without a trailing slash. */
  profiles: Record<string, StoredProfile>;
  /** The file's default profile, when it names a usable profile. */
  defaultProfile?: string;
  /** Profiles (or the default) that were present but not usable, with the reason. Never contains a key. */
  skipped: Array<{ name: string; reason: string }>;
}

export function isStoreEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !/^(off|false|0|no)$/i.test(env.MCP_CREDENTIAL_STORE?.trim() ?? '');
}

export function storeDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  const override = env.MCP_CREDENTIAL_STORE_DIR?.trim();
  if (override) return override;
  if (platform === 'win32') return join(env.APPDATA?.trim() || join(homedir(), 'AppData', 'Roaming'), 'digital-ai-testing');
  return join(env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config'), 'digital-ai-testing');
}

export function storePath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  return join(storeDir(env, platform), STORE_FILE_NAME);
}

/** An http(s) URL without trailing slashes, or null. */
export function validUrl(u: unknown): string | null {
  if (typeof u !== 'string' || !u.trim()) return null;
  try {
    const parsed = new URL(u.trim());
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    return u.trim().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

const NO_KEYCHAIN: KeyLookup = () => ({ reason: 'its key is in the OS keychain, which is not read here' });

/**
 * Validates parsed JSON (`raw` is whatever JSON.parse returned). `lookup` resolves "keyStore": "os" profiles — readStore
 * passes the real keychain; tests pass a fake. Without one, such profiles are skipped.
 */
export function parseStore(raw: unknown, path: string, lookup: KeyLookup = NO_KEYCHAIN): StoreReadResult {
  const base: StoreReadResult = { enabled: true, path, exists: true, profiles: {}, skipped: [] };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...base, error: 'the file is not a JSON object' };
  const obj = raw as Record<string, unknown>;
  if (typeof obj.version === 'number' && obj.version > STORE_FORMAT_VERSION) {
    return { ...base, error: `the file uses format version ${obj.version}; this server reads version ${STORE_FORMAT_VERSION} — update the server` };
  }
  if (!obj.profiles || typeof obj.profiles !== 'object' || Array.isArray(obj.profiles)) {
    return { ...base, error: 'the file has no "profiles" object' };
  }

  const seen = new Set<string>();
  for (const [rawName, rawProfile] of Object.entries(obj.profiles as Record<string, unknown>)) {
    const name = rawName.trim().toLowerCase();
    if (!PROFILE_NAME_RE.test(name)) {
      base.skipped.push({ name: rawName, reason: 'invalid name (letters, digits, "_" and "-" only, up to 64)' });
      continue;
    }
    if (seen.has(name)) {
      base.skipped.push({ name: rawName, reason: `duplicate of "${name}" (names are not case-sensitive)` });
      continue;
    }
    seen.add(name);
    if (!rawProfile || typeof rawProfile !== 'object') {
      base.skipped.push({ name, reason: 'not an object with "url" and "key" or "keyStore"' });
      continue;
    }
    const p = rawProfile as Record<string, unknown>;
    const url = validUrl(p.url);
    if (!url) {
      base.skipped.push({ name, reason: '"url" is missing or not an http(s) URL' });
      continue;
    }
    if (p.keyStore !== undefined) {
      if (p.keyStore !== 'os') {
        base.skipped.push({ name, reason: `"keyStore" must be "os" (got ${JSON.stringify(String(p.keyStore)).slice(0, 40)})` });
        continue;
      }
      if (p.key !== undefined) {
        base.skipped.push({ name, reason: 'has both "key" and "keyStore" — keep one' });
        continue;
      }
      const found = lookup(name);
      if (!found.key) {
        base.skipped.push({ name, reason: found.reason ?? 'its key is in the OS keychain, but it could not be read' });
        continue;
      }
      base.profiles[name] = { url, key: found.key, keyStore: 'os' };
      continue;
    }
    if (typeof p.key !== 'string' || !p.key.trim()) {
      base.skipped.push({ name, reason: '"key" is missing or empty (or set "keyStore": "os" for a key in the OS keychain)' });
      continue;
    }
    base.profiles[name] = { url, key: p.key.trim(), keyStore: 'file' };
  }

  if (obj.default !== undefined) {
    const d = typeof obj.default === 'string' ? obj.default.trim().toLowerCase() : '';
    if (d && d in base.profiles) base.defaultProfile = d;
    else base.skipped.push({ name: '(default)', reason: `"default" names ${d ? `"${d}", which is not a usable profile` : 'no profile'}` });
  }
  return base;
}

/** " (line L, column C)" from a JSON.parse error, or "" — never any of the message's quoted input. */
export function jsonErrorPosition(e: unknown, text: string): string {
  const msg = e instanceof Error ? e.message : '';
  const lc = /line (\d+) column (\d+)/.exec(msg);
  if (lc) return ` (line ${lc[1]}, column ${lc[2]})`;
  const pos = /position (\d+)/.exec(msg);
  if (!pos) return '';
  const before = text.slice(0, Number(pos[1])).split('\n');
  return ` (line ${before.length}, column ${before[before.length - 1].length + 1})`;
}

/** Reads the store. Never throws. */
export function readStore(env: NodeJS.ProcessEnv = process.env): StoreReadResult {
  const path = storePath(env);
  if (!isStoreEnabled(env)) return { enabled: false, path, exists: false, profiles: {}, skipped: [] };
  if (!existsSync(path)) return { enabled: true, path, exists: false, profiles: {}, skipped: [] };
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    return { enabled: true, path, exists: true, error: `the file could not be read (${(e as NodeJS.ErrnoException).code ?? 'error'})`, profiles: {}, skipped: [] };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^﻿/, ''));
  } catch (e) {
    // Only the position is reported: V8's JSON.parse messages can quote part of the input, which may be a key.
    return { enabled: true, path, exists: true, error: `the file is not valid JSON${jsonErrorPosition(e, text)}`, profiles: {}, skipped: [] };
  }
  return parseStore(raw, path, keychainLookup);
}

/**
 * Writes the store atomically (temp file + rename) and keeps the previous version as profiles.json.bak.
 * The folder and file are created user-only where the OS honours POSIX modes.
 */
export function writeStore(data: StoreFile | RawStoreFile, env: NodeJS.ProcessEnv = process.env): string {
  const dir = storeDir(env);
  const path = storePath(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const body = JSON.stringify({ ...data, version: STORE_FORMAT_VERSION }, null, 2) + '\n';
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600 });
  if (existsSync(path)) copyFileSync(path, `${path}.bak`);
  renameSync(tmp, path);
  // The backup holds keys too, and a copy does not keep the source's mode.
  for (const f of [path, `${path}.bak`]) {
    try {
      if (existsSync(f)) chmodSync(f, 0o600);
    } catch {
      /* best effort — not meaningful on Windows */
    }
  }
  return path;
}

// ─── Editing helpers (the setup command) ──────────────────────────────────────

/** The file as written, for editing: unknown fields and broken profiles are kept, not dropped. */
export interface RawStoreFile {
  version?: number;
  default?: string;
  profiles: Record<string, Record<string, unknown>>;
  [other: string]: unknown;
}

/**
 * Reads the file for editing. A missing file is an empty store. An unreadable file, invalid JSON, a wrong shape or a
 * newer format version is an error: the caller must not write over it (setup offers `repair` instead).
 */
export function readStoreFileRaw(env: NodeJS.ProcessEnv = process.env): { exists: boolean; data?: RawStoreFile; error?: string } {
  const path = storePath(env);
  if (!existsSync(path)) return { exists: false, data: { version: STORE_FORMAT_VERSION, profiles: {} } };
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    return { exists: true, error: `the file could not be read (${(e as NodeJS.ErrnoException).code ?? 'error'})` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^﻿/, ''));
  } catch (e) {
    return { exists: true, error: `the file is not valid JSON${jsonErrorPosition(e, text)}` };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { exists: true, error: 'the file is not a JSON object' };
  const obj = raw as RawStoreFile;
  if (typeof obj.version === 'number' && obj.version > STORE_FORMAT_VERSION) {
    return { exists: true, error: `the file uses format version ${obj.version}, newer than this version reads — update first` };
  }
  if (obj.profiles === undefined) obj.profiles = {};
  if (!obj.profiles || typeof obj.profiles !== 'object' || Array.isArray(obj.profiles)) {
    return { exists: true, error: 'the file\'s "profiles" is not an object' };
  }
  return { exists: true, data: obj };
}

/** Finds a profile entry by name, ignoring case (names are case-insensitive). */
export function findRawProfileName(data: RawStoreFile, name: string): string | undefined {
  const wanted = name.trim().toLowerCase();
  return Object.keys(data.profiles).find((k) => k.trim().toLowerCase() === wanted);
}

/** Restores profiles.json from profiles.json.bak; the replaced file is kept as profiles.json.before-repair. */
export function restoreStoreBackup(env: NodeJS.ProcessEnv = process.env): { ok: boolean; error?: string; keptAs?: string } {
  const path = storePath(env);
  const bak = `${path}.bak`;
  if (!existsSync(bak)) return { ok: false, error: `there is no backup (${bak})` };
  let keptAs: string | undefined;
  if (existsSync(path)) {
    keptAs = `${path}.before-repair`;
    copyFileSync(path, keptAs);
  }
  copyFileSync(bak, path);
  for (const f of [path, keptAs]) {
    try {
      if (f) chmodSync(f, 0o600);
    } catch {
      /* best effort */
    }
  }
  return { ok: true, keptAs };
}

/** Deletes profiles.json and every copy setup made of it (backup, before-repair). Returns the files removed. */
export function deleteStoreFiles(env: NodeJS.ProcessEnv = process.env): string[] {
  const path = storePath(env);
  const removed: string[] = [];
  for (const f of [path, `${path}.bak`, `${path}.before-repair`]) {
    if (existsSync(f)) {
      rmSync(f, { force: true });
      removed.push(f);
    }
  }
  return removed;
}
