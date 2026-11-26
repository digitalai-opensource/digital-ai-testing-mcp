/**
 * Server options kept in the profiles file (`setup options`), so nobody has to edit an AI client's configuration file by
 * hand to change how the server behaves. Top-level "options" in profiles.json: { "MCP_TOOLSETS": "core", … }.
 *
 * At start the server reads them and sets each one in its own environment UNLESS that variable is already set: a value in
 * the client's configuration (or a .env file) always wins, exactly as it did before this existed. Only the options listed
 * here can be stored: never a credential, a path or anything about the store itself, and every value is checked.
 */
import { isStoreEnabled, readStoreFileRaw } from './credential-store.js';
import { TOOLSETS, parseToolsetSelection } from './toolsets.js';

export interface ServerOption {
  /** The environment variable the server reads. */
  env: string;
  /** A short name for the command line: `setup options toolsets core`. */
  alias: string;
  /** What the server does when the option is not set. */
  fallback: string;
  about: string;
  /** The value as it will be stored, or why it cannot be used. */
  check(value: string): { value: string } | { error: string };
}

const onOff = (value: string): { value: string } | { error: string } => {
  const v = value.trim().toLowerCase();
  if (/^(true|on|yes|1)$/.test(v)) return { value: 'true' };
  if (/^(false|off|no|0)$/.test(v)) return { value: 'false' };
  return { error: 'use true or false' };
};

export const SERVER_OPTIONS: ServerOption[] = [
  {
    env: 'MCP_TOOLSETS', alias: 'toolsets', fallback: 'all',
    about: `Which groups of tools load in full; the rest stay listed and load on first use (a smaller tool list). One or more of ${Object.keys(TOOLSETS).join(', ')}, or core (only the always-loaded tools), or all.`,
    check(value) {
      const names = value.split(/[,\s]+/).map((t) => t.trim().toLowerCase()).filter(Boolean);
      if (!names.length) return { error: 'name at least one toolset, or core, or all' };
      const unknown = parseToolsetSelection(names.join(',')).unknown;
      if (unknown.length) return { error: `unknown toolset${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')} (valid: ${Object.keys(TOOLSETS).join(', ')}, core, all)` };
      return { value: names.join(',') };
    },
  },
  { env: 'MCP_REPORT_POINTER', alias: 'report-pointer', fallback: 'true', check: onOff,
    about: 'The line a data tool adds to a large result, telling the AI it can present the data as a report.' },
  { env: 'MCP_UPDATE_CHECK', alias: 'update-check', fallback: 'true', check: onOff,
    about: 'The daily check for a newer release, and its notice.' },
  { env: 'MCP_DEBUG_MODE', alias: 'debug', fallback: 'false', check: onOff,
    about: 'Debug mode: the AI records what went wrong or wasted calls, for improving the server.' },
  {
    env: 'MCP_SESSION_IDLE_TIMEOUT_SECONDS', alias: 'idle-timeout', fallback: '300',
    about: 'How many seconds an inspection session may sit idle before the platform ends it (60 to 1800).',
    check(value) {
      const n = Number(value.trim());
      if (!Number.isInteger(n) || n < 60 || n > 1800) return { error: 'use a whole number of seconds from 60 to 1800' };
      return { value: String(n) };
    },
  },
];

/** By variable name or short name, whatever the case. */
export function findServerOption(name: string): ServerOption | undefined {
  const wanted = name.trim().toLowerCase();
  return SERVER_OPTIONS.find((o) => o.env.toLowerCase() === wanted || o.alias === wanted);
}

/** The options in the profiles file that can be used, and a line for each entry that cannot (it is skipped, never fatal). */
export function readStoredOptions(env: NodeJS.ProcessEnv = process.env): { options: Record<string, string>; problems: string[] } {
  const options: Record<string, string> = {};
  const problems: string[] = [];
  if (!isStoreEnabled(env)) return { options, problems };
  const raw = readStoreFileRaw(env);
  const stored = raw.data?.options;
  if (stored === undefined) return { options, problems };
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return { options, problems: ['"options" in the profiles file is not an object; it is ignored'] };
  for (const [name, value] of Object.entries(stored as Record<string, unknown>)) {
    const option = findServerOption(name);
    if (!option) { problems.push(`option "${name}" is not one this server stores; it is ignored`); continue; }
    const checked = typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? option.check(String(value)) : { error: 'the value is not text' };
    if ('error' in checked) problems.push(`option ${option.env}: ${checked.error}; it is ignored`);
    else options[option.env] = checked.value;
  }
  return { options, problems };
}

let lastApplied: { applied: Record<string, string>; overridden: string[]; problems: string[] } | null = null;

/**
 * Put the stored options into `env` (the server's own environment) where the variable is not set already. Called once at
 * start, after a .env file was read and before anything reads an option. Never throws.
 */
export function applyStoredOptions(env: NodeJS.ProcessEnv = process.env): { applied: Record<string, string>; overridden: string[]; problems: string[] } {
  const result = { applied: {} as Record<string, string>, overridden: [] as string[], problems: [] as string[] };
  try {
    const { options, problems } = readStoredOptions(env);
    result.problems = problems;
    for (const [name, value] of Object.entries(options)) {
      if ((env[name] ?? '').trim()) result.overridden.push(name);
      else { env[name] = value; result.applied[name] = value; }
    }
  } catch (e) {
    result.problems.push(`the stored options could not be read: ${(e as Error).message}`);
  }
  if (env === process.env) lastApplied = result;
  return result;
}

/** One line for get_server_info, or null when no stored option is in effect. */
export function serverOptionsStatusLine(): string | null {
  if (!lastApplied) return null;
  const set = Object.entries(lastApplied.applied).map(([k, v]) => `${k}=${v}`);
  if (!set.length && !lastApplied.problems.length && !lastApplied.overridden.length) return null;
  return `Server options from setup: ${set.join(', ') || 'none in effect'}${lastApplied.overridden.length ? ` (set in the client's configuration instead: ${lastApplied.overridden.join(', ')})` : ''}` +
    `${lastApplied.problems.length ? ` · ${lastApplied.problems.join('; ')}` : ''}`;
}

export function resetServerOptionsForTests(): void { lastApplied = null; }
