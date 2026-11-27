/**
 * Test logins for the user's app (App Exploration, 2.6.0). `setup app-login <name>` keeps the user name in the profiles
 * file (top-level "appLogins") and the password in the OS keychain (account "app-login:<name>", same service and folder
 * rule as the profile keys), so an exploration can log in without the password ever passing through the chat or a
 * client's configuration. Environment variables stay the fallback (owner decision 2026-11-27).
 *
 * A profile name cannot contain ":", so an app-login account can never collide with a profile key.
 */
import { getKeychain, isStoreEnabled, keychainAccount, readStoreFileRaw, writeStore, type RawStoreFile } from './credential-store.js';

export const APP_LOGIN_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const account = (name: string) => `app-login:${name}`;

export interface AppLoginEntry { name: string; username: string }

function entries(data: RawStoreFile | undefined): Record<string, unknown> {
  const v = data?.appLogins;
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** The logins in the profiles file (names and user names only; never a password). */
export function listAppLogins(env: NodeJS.ProcessEnv = process.env): { logins: AppLoginEntry[]; error?: string } {
  if (!isStoreEnabled(env)) return { logins: [] };
  const raw = readStoreFileRaw(env);
  if (!raw.data) return { logins: [], error: raw.error };
  const logins: AppLoginEntry[] = [];
  for (const [name, v] of Object.entries(entries(raw.data))) {
    const u = v && typeof v === 'object' ? (v as Record<string, unknown>).username : undefined;
    if (typeof u === 'string' && u.trim()) logins.push({ name, username: u.trim() });
  }
  return { logins };
}

/** Saves a login: the user name in the file, the password in the keychain. Never throws for keychain trouble. */
export function saveAppLogin(data: RawStoreFile, name: string, username: string, password: string, env: NodeJS.ProcessEnv = process.env): { ok: boolean; error?: string } {
  const { keychain, error } = getKeychain();
  if (!keychain) return { ok: false, error };
  try {
    keychain.set(keychainAccount(account(name), env), password);
  } catch (e) {
    return { ok: false, error: `the OS keychain could not save it (${(e as Error).message.split('\n')[0]})` };
  }
  data.appLogins = { ...entries(data), [name]: { username, keyStore: 'os' } };
  writeStore(data, env);
  return { ok: true };
}

/** Removes a login from the file and the keychain. `existed` is false when neither held it. */
export function removeAppLogin(data: RawStoreFile, name: string, env: NodeJS.ProcessEnv = process.env): { existed: boolean; keychainError?: string } {
  const all = { ...entries(data) };
  const inFile = name in all;
  let inKeychain = false;
  let keychainError: string | undefined;
  const { keychain, error } = getKeychain();
  if (keychain) {
    try { inKeychain = keychain.delete(keychainAccount(account(name), env)); } catch (e) { keychainError = (e as Error).message.split('\n')[0]; }
  } else keychainError = error;
  if (inFile) {
    delete all[name];
    if (Object.keys(all).length) data.appLogins = all; else delete data.appLogins;
    writeStore(data, env);
  }
  return { existed: inFile || inKeychain, ...(keychainError ? { keychainError } : {}) };
}

/** Deletes every app-login password from the keychain (for `setup reset`). Returns the names removed. */
export function deleteAllAppLoginSecrets(data: RawStoreFile | undefined, env: NodeJS.ProcessEnv = process.env): string[] {
  const { keychain } = getKeychain();
  if (!keychain) return [];
  return Object.keys(entries(data)).filter((n) => { try { return keychain.delete(keychainAccount(account(n), env)); } catch { return false; } });
}

/**
 * The login named `name`, for the server: user name and password, or why it cannot be used. The reason names the command
 * that fixes it and never holds a secret.
 */
export function resolveAppLogin(name: string, fixCommand: string, env: NodeJS.ProcessEnv = process.env): { username?: string; password?: string; reason?: string } {
  const key = name.trim().toLowerCase();
  if (!APP_LOGIN_NAME_RE.test(key)) return { reason: `"${name}" is not a test-login name (letters, digits, - and _)` };
  if (!isStoreEnabled(env)) return { reason: 'the credential store is switched off on this server (MCP_CREDENTIAL_STORE=off), so saved test logins cannot be read; use loginUserEnv / loginPasswordEnv instead' };
  const raw = readStoreFileRaw(env);
  if (!raw.data) return { reason: `the profiles file cannot be read (${raw.error})` };
  const entry = entries(raw.data)[key] as Record<string, unknown> | undefined;
  const username = typeof entry?.username === 'string' ? entry.username.trim() : '';
  if (!username) return { reason: `there is no saved test login "${key}". The user saves one in a terminal with: ${fixCommand} app-login ${key}` };
  const { keychain, error } = getKeychain();
  if (!keychain) return { reason: `the test login's password is in the OS keychain, which cannot be used here: ${error}` };
  let password: string | null = null;
  try { password = keychain.get(keychainAccount(account(key), env)); } catch { /* reported below */ }
  if (!password) return { reason: `the test login "${key}" has no password in the OS keychain. The user saves it again with: ${fixCommand} app-login ${key}` };
  return { username, password };
}
