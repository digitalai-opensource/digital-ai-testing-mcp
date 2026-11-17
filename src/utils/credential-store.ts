/**
 * Local credential store — named connection profiles in one file per user, read by profile-loader.ts.
 *
 * Location: MCP_CREDENTIAL_STORE_DIR, else %APPDATA%\digital-ai-testing (Windows) or
 * $XDG_CONFIG_HOME/digital-ai-testing, else ~/.config/digital-ai-testing. File: profiles.json.
 * MCP_CREDENTIAL_STORE=off disables it completely.
 *
 *   { "version": 1, "default": "admin",
 *     "profiles": { "admin": { "url": "https://tenant.experitest.com", "key": "…" } } }
 *
 * The store is ADDITIVE: environment variables always win (profile-loader.ts applies the precedence). This module only
 * reads, validates and writes the file, and never throws on bad content: an unreadable file or a bad profile becomes
 * an error / skipped entry with a reason, so the server can still start and say what is wrong.
 *
 * Keys are stored in the file itself for now (plain-file mode: user-only folder, mode 0600 where the OS honours it —
 * on Windows the per-user %APPDATA% ACL is what protects it). OS keychain storage is a planned addition; a profile
 * without a usable `key` is skipped with a reason, so a future format can add another key location without breaking
 * this reader.
 *
 * Credential values never leave this module except through profile-loader.ts.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, copyFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const STORE_FORMAT_VERSION = 1;
export const STORE_FILE_NAME = 'profiles.json';

/** Same shape as env profile names after lowercasing (DAI_PROFILE_QA_TEAM_* → qa_team). */
const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export interface StoredProfile {
  url: string;
  key: string;
}

export interface StoreFile {
  version: number;
  default?: string;
  profiles: Record<string, StoredProfile>;
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

function validUrl(u: unknown): string | null {
  if (typeof u !== 'string' || !u.trim()) return null;
  try {
    const parsed = new URL(u.trim());
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    return u.trim().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

/** Pure: validates parsed JSON. `raw` is whatever JSON.parse returned. */
export function parseStore(raw: unknown, path: string): StoreReadResult {
  const base: StoreReadResult = { enabled: true, path, exists: true, profiles: {}, skipped: [] };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...base, error: 'the file is not a JSON object' };
  const obj = raw as Record<string, unknown>;
  if (typeof obj.version === 'number' && obj.version > STORE_FORMAT_VERSION) {
    return { ...base, error: `the file uses format version ${obj.version}; this server reads version ${STORE_FORMAT_VERSION} — update the server` };
  }
  if (!obj.profiles || typeof obj.profiles !== 'object' || Array.isArray(obj.profiles)) {
    return { ...base, error: 'the file has no "profiles" object' };
  }

  for (const [rawName, rawProfile] of Object.entries(obj.profiles as Record<string, unknown>)) {
    const name = rawName.trim().toLowerCase();
    if (!PROFILE_NAME_RE.test(name)) {
      base.skipped.push({ name: rawName, reason: 'invalid name (letters, digits, "_" and "-" only, up to 64)' });
      continue;
    }
    if (name in base.profiles) {
      base.skipped.push({ name: rawName, reason: `duplicate of "${name}" (names are not case-sensitive)` });
      continue;
    }
    if (!rawProfile || typeof rawProfile !== 'object') {
      base.skipped.push({ name, reason: 'not an object with "url" and "key"' });
      continue;
    }
    const p = rawProfile as Record<string, unknown>;
    const url = validUrl(p.url);
    if (!url) {
      base.skipped.push({ name, reason: '"url" is missing or not an http(s) URL' });
      continue;
    }
    if (typeof p.key !== 'string' || !p.key.trim()) {
      base.skipped.push({ name, reason: '"key" is missing or empty' });
      continue;
    }
    base.profiles[name] = { url, key: p.key.trim() };
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
  return parseStore(raw, path);
}

/**
 * Writes the store atomically (temp file + rename) and keeps the previous version as profiles.json.bak.
 * The folder and file are created user-only where the OS honours POSIX modes.
 */
export function writeStore(data: StoreFile, env: NodeJS.ProcessEnv = process.env): string {
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
