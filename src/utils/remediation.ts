/**
 * Debug mode (MCP_DEBUG_MODE=true) — remediation capture for ongoing improvement of the MCP.
 *
 * Off by default, and off means no behaviour change: nothing is wrapped, logged, nudged or registered.
 * On, three things work together:
 *  1. A server-side EVENT LOG of what the MCP observes itself — every tool call with timing, response size (a token
 *     proxy), outcome (ok / error / guard), and "retried after an error or guard" signals. The agent can't under-report
 *     these. Written to ~/remediation/<session>.events.jsonl when the server runs on the user's machine
 *     (MCP_DEPLOYMENT_MODE=local); kept in memory under Docker, where the server's ~ is the container's.
 *  2. record_remediation_note — a structured tool the agent calls for what only it can know (user corrections, giving
 *     up, a better path, unclear guidance). Local: appended to ~/remediation/<session>.md. Docker: the note text is
 *     returned for the agent to save on the user's machine.
 *  3. NUDGES — one line appended to an error or guard response, prompting a note at the moment it matters.
 * Everything written or returned is redacted (keys, JWTs, emails, signed-URL parameters).
 */
import { appendFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { getDeploymentMode } from './deployment-mode.js';

/** Read live (like getDeploymentMode) so tests can flip it; "true"/"1"/"yes", case-insensitive. */
export function isDebugMode(): boolean {
  return /^(true|1|yes)$/i.test((process.env.MCP_DEBUG_MODE ?? '').trim());
}

export const REMEDIATION_CATEGORIES = ['error', 'unclear-guidance', 'user-correction', 'gave-up', 'better-path', 'improvement'] as const;
export type RemediationCategory = (typeof REMEDIATION_CATEGORIES)[number];

export const CATEGORY_TITLES: Record<RemediationCategory, string> = {
  error: 'Error encountered',
  'unclear-guidance': 'Wasted effort — unclear MCP guidance',
  'user-correction': 'Corrected or stopped by the user',
  'gave-up': 'Gave up',
  'better-path': 'Found a better path than the MCP recommended',
  improvement: 'Improvement opportunity',
};

// ── Session ──────────────────────────────────────────────────────────────────

const pad = (n: number) => String(n).padStart(2, '0');
/** yyyymmddhhmmss in local time (the user reads these names in their own directory). */
export function remediationStamp(d: Date): string {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

interface SessionInfo {
  id: string;
  startedAt: Date;
  mcpVersion: string;
  toolsets: string;
  client: () => { name?: string; version?: string } | undefined;
}

let session: SessionInfo | null = null;

/** Called once at startup when debug mode is on. The short random suffix keeps parallel sessions apart. */
export function startRemediationSession(opts: { mcpVersion: string; toolsets: string; client: SessionInfo['client']; now?: Date }): SessionInfo {
  const startedAt = opts.now ?? new Date();
  session = { id: `${remediationStamp(startedAt)}-${randomBytes(2).toString('hex')}`, startedAt, mcpVersion: opts.mcpVersion, toolsets: opts.toolsets, client: opts.client };
  events.length = 0;
  lastOutcome.clear();
  nudged.clear();
  notesWritten = 0;
  sessionHeaderWritten = false;
  return session;
}

export function getRemediationSession(): SessionInfo | null {
  return session;
}

/** Overridable for tests; ~/remediation otherwise. */
export function remediationDir(): string {
  return process.env.MCP_REMEDIATION_DIR || join(homedir(), 'remediation');
}

/** Only when the server's filesystem is the user's machine (npm/local install). */
export function canWriteLocally(): boolean {
  return getDeploymentMode() === 'local';
}

// ── Redaction ────────────────────────────────────────────────────────────────

/** Strip credentials and personal data before anything is written or returned. */
export function redact(text: string): string {
  let out = text;
  // Exact configured secrets first (any profile), so even an unusual key format is caught.
  for (const [k, v] of Object.entries(process.env)) {
    if (v && v.length >= 12 && /(ACCESS_KEY|_KEY$|TOKEN|SECRET|PASSWORD)/i.test(k)) out = out.split(v).join('[REDACTED_KEY]');
  }
  return out
    .replace(/eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g, '[REDACTED_JWT]')
    .replace(/\baut_\d_[\w-]{8,}/g, '[REDACTED_KEY]')
    .replace(/\b(Bearer)\s+[\w.~+/-]{12,}=*/gi, '$1 [REDACTED]')
    .replace(/((?:access_?key|api_?key|token|password|secret|signature|sig)["']?\s*[:=]\s*["']?)[^\s"'&,}]{6,}/gi, '$1[REDACTED]')
    .replace(/([?&](?:token|key|signature|sig|X-Amz-Signature|X-Amz-Credential)=)[^&\s"']+/gi, '$1[REDACTED]')
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[REDACTED_EMAIL]');
}

// ── Event log ────────────────────────────────────────────────────────────────

export type Outcome = 'ok' | 'error' | 'guard';

export interface ToolEvent {
  type: 'tool';
  at: string;
  tool: string;
  ms: number;
  outcome: Outcome;
  responseChars: number;
  args: Record<string, string>;
  /** The previous call to this tool ended in error/guard — a retry, often caused by unclear guidance. */
  retryAfter?: Exclude<Outcome, 'ok'>;
  /** Identical arguments to the previous call — a repeat that cannot have helped. */
  repeatedArgs?: boolean;
  /** A toolset placeholder fired (the toolset was not loaded) — one extra round trip. */
  placeholder?: boolean;
  /** First line of an error/guard response, for context. */
  detail?: string;
}

const MAX_MEMORY_EVENTS = 300;
const events: ToolEvent[] = [];
const lastOutcome = new Map<string, { outcome: Outcome; argsKey: string }>();
const nudged = new Set<string>();
let notesWritten = 0;
let sessionHeaderWritten = false;

/** Guard responses are deliberate stops (selector gate, size guard, confirmDeletion previews) — not failures. */
export function classifyOutcome(result: unknown): { outcome: Outcome; text: string } {
  const r = result as { isError?: boolean; content?: Array<{ type?: string; text?: string }> } | undefined;
  const text = (r?.content ?? []).map((c) => (c.type === 'text' ? c.text ?? '' : '')).join('\n');
  const guard = /"status":\s*"blocked"|⛔|\bBLOCKED\b|guard triggered|confirmDeletion:\s*true|confirmPublicShare:\s*true|confirmLargeExport|Nothing was executed/i.test(text);
  if (guard) return { outcome: 'guard', text };
  return { outcome: r?.isError ? 'error' : 'ok', text };
}

function summarizeArgs(args: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!args || typeof args !== 'object') return out;
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    out[k] = redact(s.length > 160 ? `${s.slice(0, 160)}…(${s.length} chars)` : s);
  }
  return out;
}

function sessionFileBase(): string | null {
  return session ? join(remediationDir(), session.id) : null;
}

function writeEventLine(obj: unknown): void {
  const base = sessionFileBase();
  if (!base || !canWriteLocally()) return;
  try {
    mkdirSync(remediationDir(), { recursive: true });
    if (!sessionHeaderWritten) {
      sessionHeaderWritten = true;
      appendFileSync(`${base}.events.jsonl`, JSON.stringify({ type: 'session', ...sessionMeta() }) + '\n');
    }
    appendFileSync(`${base}.events.jsonl`, JSON.stringify(obj) + '\n');
  } catch (e) {
    console.error(`[debug-mode] could not write the event log: ${(e as Error).message}`);
  }
}

function sessionMeta() {
  const c = session?.client();
  return {
    session: session?.id,
    startedAt: session?.startedAt.toISOString(),
    mcpVersion: session?.mcpVersion,
    deploymentMode: getDeploymentMode(),
    toolsets: session?.toolsets,
    client: c ? `${c.name ?? '?'} ${c.version ?? ''}`.trim() : 'unknown',
  };
}

export function recordToolEvent(e: { tool: string; args: unknown; ms: number; result: unknown; placeholder?: boolean }): ToolEvent {
  const { outcome, text } = classifyOutcome(e.result);
  const args = summarizeArgs(e.args);
  const argsKey = JSON.stringify(args);
  const prev = lastOutcome.get(e.tool);
  const ev: ToolEvent = {
    type: 'tool',
    at: new Date().toISOString(),
    tool: e.tool,
    ms: e.ms,
    outcome,
    responseChars: text.length,
    args,
    ...(prev && prev.outcome !== 'ok' ? { retryAfter: prev.outcome } : {}),
    ...(prev && prev.argsKey === argsKey ? { repeatedArgs: true } : {}),
    ...(e.placeholder ? { placeholder: true } : {}),
    ...(outcome !== 'ok' ? { detail: redact(text.split('\n').find((l) => l.trim()) ?? '').slice(0, 300) } : {}),
  };
  lastOutcome.set(e.tool, { outcome, argsKey });
  events.push(ev);
  if (events.length > MAX_MEMORY_EVENTS) events.shift();
  writeEventLine(ev);
  return ev;
}

export function getRecordedEvents(): readonly ToolEvent[] {
  return events;
}

/** Compact, objective summary for a note: what the server saw, so the agent's account can be checked against it. */
export function summarizeEvents(list: readonly ToolEvent[] = events): string {
  if (list.length === 0) return 'No tool calls recorded yet.';
  const by = (o: Outcome) => list.filter((e) => e.outcome === o).length;
  const chars = list.reduce((n, e) => n + e.responseChars, 0);
  const retries = list.filter((e) => e.retryAfter).map((e) => e.tool);
  const repeats = list.filter((e) => e.repeatedArgs).map((e) => e.tool);
  const placeholders = list.filter((e) => e.placeholder).map((e) => e.tool);
  const biggest = [...list].sort((a, b) => b.responseChars - a.responseChars).slice(0, 3).map((e) => `${e.tool} (${e.responseChars} chars)`);
  const problems = list.filter((e) => e.outcome !== 'ok').slice(-5).map((e) => `${e.tool} → ${e.outcome}: ${e.detail ?? ''}`);
  return [
    `${list.length} tool calls: ${by('ok')} ok, ${by('error')} error, ${by('guard')} guard; ${chars} response chars in total.`,
    retries.length ? `Retried after an error/guard: ${[...new Set(retries)].join(', ')}.` : null,
    repeats.length ? `Repeated with identical arguments: ${[...new Set(repeats)].join(', ')}.` : null,
    placeholders.length ? `Toolset placeholders fired: ${[...new Set(placeholders)].join(', ')}.` : null,
    `Largest responses: ${biggest.join(', ')}.`,
    problems.length ? `Recent problems:\n${problems.map((p) => `  - ${p}`).join('\n')}` : null,
  ].filter(Boolean).join('\n');
}

// ── Nudges ───────────────────────────────────────────────────────────────────

/** One line, once per tool+outcome per session — enough to prompt a note without nagging. */
export function nudgeFor(tool: string, outcome: Outcome): string | null {
  if (outcome === 'ok' || tool === 'record_remediation_note') return null;
  const key = `${tool}:${outcome}`;
  if (nudged.has(key)) return null;
  nudged.add(key);
  return outcome === 'error'
    ? `[debug mode] Once this error is resolved or abandoned, record it with record_remediation_note (category "error": what you were doing, the error, the workaround). Don't interrupt the user's task to do it.`
    : `[debug mode] If this guard was unclear or cost extra calls, record it with record_remediation_note (category "unclear-guidance").`;
}

// ── Handler wrapping ─────────────────────────────────────────────────────────

type Handler = (...a: unknown[]) => unknown;

/** Wrap a tool callback: time it, log the event, append a nudge on error/guard. Never changes the tool's own result. */
export function instrumentHandler(tool: string, callback: Handler, opts: { placeholder?: boolean } = {}): Handler {
  return async (...a: unknown[]) => {
    const started = Date.now();
    // The note itself is already in the .md file — log only that the call happened.
    const args = opts.placeholder || tool === 'record_remediation_note' ? {} : a[0];
    let result: unknown;
    try {
      result = await callback(...a);
    } catch (e) {
      recordToolEvent({ tool, args, ms: Date.now() - started, result: { isError: true, content: [{ type: 'text', text: `thrown: ${(e as Error).message}` }] }, placeholder: opts.placeholder });
      throw e;
    }
    const ev = recordToolEvent({ tool, args, ms: Date.now() - started, result, placeholder: opts.placeholder });
    const nudge = opts.placeholder ? null : nudgeFor(tool, ev.outcome);
    const r = result as { content?: Array<{ type: string; text?: string }> } | undefined;
    if (nudge && r && Array.isArray(r.content)) return { ...r, content: [...r.content, { type: 'text', text: nudge }] };
    return result;
  };
}

// ── Notes ────────────────────────────────────────────────────────────────────

export interface RemediationNote {
  category: RemediationCategory;
  title: string;
  intent: string;
  whatHappened: string;
  resolution?: string;
  resolved?: boolean;
  tools?: string[];
  wastedCalls?: number;
  userFeedback?: string;
  suggestion?: string;
}

export function noteFileHeader(): string {
  const m = sessionMeta();
  return [
    '---',
    `session: ${m.session}`,
    `started: ${m.startedAt}`,
    `mcpVersion: ${m.mcpVersion}`,
    `deploymentMode: ${m.deploymentMode}`,
    `toolsets: ${m.toolsets}`,
    `client: ${m.client}`,
    'debugMode: true  # debug sessions spend extra tokens on notes — exclude them from token baselines',
    canWriteLocally() ? `eventsLog: ${m.session}.events.jsonl` : 'eventsLog: none (server not on this machine) — see "Server-observed events" in each note',
    '---',
    '',
    `# MCP remediation notes — session ${m.session}`,
    '',
    '',
  ].join('\n');
}

export function formatNote(note: RemediationNote, now: Date = new Date()): string {
  const r = (s: string | undefined) => (s ? redact(s.trim()) : '');
  const lines = [
    `## [${note.category}] ${r(note.title)}`,
    '',
    `- **When:** ${now.toISOString()}`,
    `- **Category:** ${CATEGORY_TITLES[note.category]}`,
    ...(note.tools?.length ? [`- **Tools:** ${note.tools.map((t) => `\`${r(t)}\``).join(', ')}`] : []),
    ...(note.wastedCalls != null ? [`- **Calls that did not move the task forward:** ${note.wastedCalls}`] : []),
    `- **Resolved:** ${note.resolved === true ? 'yes' : note.resolved === false ? 'no' : 'unknown'}`,
    '',
    '### What I was trying to do',
    r(note.intent),
    '',
    '### What happened',
    r(note.whatHappened),
    ...(note.userFeedback ? ['', '### What the user said', r(note.userFeedback)] : []),
    ...(note.resolution ? ['', '### Resolution / workaround', r(note.resolution)] : []),
    ...(note.suggestion ? ['', '### Suggested MCP change', r(note.suggestion)] : []),
  ];
  if (!canWriteLocally()) lines.push('', '### Server-observed events (so far this session)', summarizeEvents());
  return lines.join('\n') + '\n\n';
}

/** Local: append to ~/remediation/<session>.md. Otherwise: return the text for the agent to save. */
export function saveNote(note: RemediationNote): { written: string | null; markdown: string; fileName: string } {
  const fileName = `${session?.id ?? remediationStamp(new Date())}.md`;
  const entry = formatNote(note);
  const markdown = notesWritten === 0 ? noteFileHeader() + entry : entry;
  if (!canWriteLocally()) {
    notesWritten++;
    return { written: null, markdown, fileName };
  }
  mkdirSync(remediationDir(), { recursive: true });
  const path = join(remediationDir(), fileName);
  appendFileSync(path, markdown);
  notesWritten++;
  writeEventLine({ type: 'note', at: new Date().toISOString(), category: note.category, title: redact(note.title) });
  return { written: path, markdown, fileName };
}

/** Instructions block appended to the server instructions when debug mode is on (kept short — it costs tokens). */
export function debugInstructions(): string {
  const where = canWriteLocally()
    ? 'The server saves each note to ~/remediation/ on this machine.'
    : 'The tool returns each note as markdown: if you can write files on the user\'s machine, append it to ~/remediation/<fileName> (create the folder); if you cannot, skip saving — never paste notes into the conversation unasked.';
  return `

DEBUG MODE IS ON (MCP_DEBUG_MODE=true) — help improve this MCP. Call record_remediation_note once per occurrence, when it is resolved or abandoned (never interrupt the user's task for it):
1. error — an error you hit: what you were doing, the error, any workaround.
2. unclear-guidance — calls wasted because a tool's guidance was unclear: the request, the misunderstanding, the resolution.
3. user-correction — the user corrected or stopped you: what you did, what they said, the fix.
4. gave-up — you could not complete the request: your understanding of the intent and why it could not be done.
5. better-path — you found a better route than the one the MCP recommended.
6. improvement — anything that would make the experience cleaner or cheaper in tokens.
Count calls rather than guessing tokens. Never include credentials. Before you finish a task, make sure each such event has a note. ${where}`;
}
