/**
 * Background report jobs (create_report background: true). A report that would take longer than a client waits for a
 * tool call runs inside this server process instead: the tool answers at once with a job id and an estimate, the job
 * runs under its own deadline, and the user can cancel it at any time.
 *
 * Nothing is written to the user's disk and nothing is opened on their screen (user decision 2026-11-23: "far too
 * invasive"). A finished job keeps its HTML in memory until the agent collects it with create_report jobId, which hands
 * it back like any report. The server cannot start a conversation turn, so the NEXT tool result of any tool starts with
 * a one-line notice (withReportNotice) telling the agent to collect it. A running job costs no model tokens — only the
 * status checks and the collection do.
 */
import { withNudge } from './remediation.js';

export type JobStatus = 'running' | 'done' | 'failed' | 'cancelled' | 'timed-out';
export interface JobResult {
  fileName: string; html: string; highlights: string[]; runId: string;
  /** The path the user asked for (outputPath). */
  savedTo?: string;
  /** Where the finished report was saved by the placement rules (a report folder or a shared folder), at completion. */
  savedAt?: string;
}
export interface ReportJob {
  id: string;
  label: string;
  status: JobStatus;
  startedAt: number;
  estimateMs: number;
  deadlineMs: number;
  progress: string;
  result?: JobResult;
  error?: string;
  finishedAt?: number;
  notified: boolean;
  collected: boolean;
}

interface Internal extends ReportJob { abort: AbortController; timer: NodeJS.Timeout }
const jobs = new Map<string, Internal>();

/** A finished report waits this long to be collected; then its HTML is dropped (the server keeps it in memory only). */
export const KEEP_RESULT_MS = 60 * 60_000;

/** Deadline for a job: twice the estimate or the estimate plus 2 minutes, whichever is longer; 5 to 60 minutes. */
export function jobDeadlineMs(estimateMs: number): number {
  return Math.min(60 * 60_000, Math.max(5 * 60_000, 2 * estimateMs, estimateMs + 120_000));
}

export const fmtDuration = (ms: number): string => {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60), r = s % 60;
  return r && m < 10 ? `${m} min ${r} s` : `${Math.round(s / 60)} min`;
};

function prune(now = Date.now()): void {
  for (const [id, j] of jobs) {
    if (j.status !== 'running' && j.finishedAt && now - j.finishedAt > KEEP_RESULT_MS) jobs.delete(id);
  }
}

export function startJob(o: {
  label: string;
  estimateMs: number;
  deadlineMs?: number;
  run: (signal: AbortSignal, progress: (text: string) => void) => Promise<JobResult>;
}): ReportJob {
  prune();
  const now = Date.now();
  const id = `job-${now.toString(36)}`;
  const abort = new AbortController();
  const deadlineMs = o.deadlineMs ?? jobDeadlineMs(o.estimateMs);
  const job: Internal = {
    id, label: o.label, status: 'running', startedAt: now, estimateMs: o.estimateMs, deadlineMs, progress: 'starting', notified: false,
    collected: false, abort,
    timer: setTimeout(() => { if (job.status === 'running') { job.status = 'timed-out'; job.finishedAt = Date.now(); job.error = `stopped at its deadline (${fmtDuration(deadlineMs)})`; abort.abort(); } }, deadlineMs),
  };
  job.timer.unref?.();
  jobs.set(id, job);
  o.run(abort.signal, (text) => { job.progress = text; })
    .then((result) => {
      if (job.status !== 'running') return; // cancelled or timed out meanwhile — keep that status
      job.status = 'done';
      job.result = result;
      job.finishedAt = Date.now();
    })
    .catch((e: Error) => {
      if (job.status !== 'running') return;
      job.status = abort.signal.aborted ? 'cancelled' : 'failed';
      job.error = e.message;
      job.finishedAt = Date.now();
    })
    .finally(() => clearTimeout(job.timer));
  return publicView(job);
}

function publicView(j: Internal): ReportJob {
  const { abort: _a, timer: _t, ...rest } = j;
  void _a; void _t;
  return { ...rest };
}

export function getJob(id: string): ReportJob | null {
  prune();
  const j = jobs.get(id);
  return j ? publicView(j) : null;
}
export function listJobs(): ReportJob[] {
  prune();
  return [...jobs.values()].map(publicView).sort((a, b) => b.startedAt - a.startedAt);
}
export function cancelJob(id: string): ReportJob | null {
  const j = jobs.get(id);
  if (!j) return null;
  if (j.status === 'running') {
    j.status = 'cancelled';
    j.finishedAt = Date.now();
    j.notified = true; // the user asked for it — no "finished" notice
    j.abort.abort();
    clearTimeout(j.timer);
  }
  return publicView(j);
}
/** The agent learned the outcome through a status check — no separate notice. */
export function markJobNotified(id: string): void {
  const j = jobs.get(id);
  if (j) j.notified = true;
}
/** The agent took the finished report. */
export function markJobCollected(id: string): void {
  const j = jobs.get(id);
  if (j) { j.collected = true; j.notified = true; }
}

/** Stops every running job (server shutdown). */
export function cancelAllJobs(): void {
  for (const j of jobs.values()) if (j.status === 'running') cancelJob(j.id);
}

/** Status text for one job — what create_report jobId answers (a finished report is attached by the tool). */
export function describeJob(j: ReportJob, now = Date.now()): string {
  const elapsed = (j.finishedAt ?? now) - j.startedAt;
  switch (j.status) {
    case 'running': {
      const left = j.estimateMs - elapsed;
      return `⏳ ${j.label} — running for ${fmtDuration(elapsed)} of an estimated ${fmtDuration(j.estimateMs)}` +
        `${left > 0 ? ` (about ${fmtDuration(left)} left)` : ' (taking longer than estimated)'}. Now: ${j.progress}. ` +
        `It stops by itself at ${fmtDuration(j.deadlineMs)}. Cancel it with create_report jobId "${j.id}", cancel: true.`;
    }
    case 'done':
      return `✅ ${j.label} — finished in ${fmtDuration(elapsed)} (estimated ${fmtDuration(j.estimateMs)}).` +
        (j.result!.highlights.length ? `\nHighlights:\n${j.result!.highlights.map((h) => `- ${h}`).join('\n')}` : '');
    case 'cancelled':
      return `⏹ ${j.label} — cancelled after ${fmtDuration(elapsed)}. No report was made.`;
    case 'timed-out':
      return `⌛ ${j.label} — ${j.error}. No report was made; try a shorter window.`;
    case 'failed':
      return `❌ ${j.label} — failed after ${fmtDuration(elapsed)}: ${j.error}`;
  }
}

/** One line for each job that finished (or failed) since the last notice; marks them as told. */
export function takeFinishedNotice(): string | null {
  const ready = [...jobs.values()].filter((j) => !j.notified && j.status !== 'running');
  if (!ready.length) return null;
  for (const j of ready) j.notified = true;
  return ready.map((j) => j.status === 'done'
    ? `📄 Background report ready: ${j.label}. Collect it now with create_report jobId "${j.id}" (it hands over the report, ${j.result!.fileName}${j.result!.savedAt ? `, already saved at ${j.result!.savedAt}` : ''}), then tell the user.`
    : `⚠️ Background report ${j.label}: ${describeJob(j)}`).join('\n');
}

type Handler = (...a: unknown[]) => unknown;
/** Puts the finished-job notice first in the next successful tool result (any tool). */
export function withReportNotice(callback: Handler): Handler {
  return async (...a: unknown[]) => {
    const result = await callback(...a);
    const r = result as { content?: Array<{ type: string; text?: string }>; isError?: boolean } | undefined;
    if (!r || r.isError || !Array.isArray(r.content) || !jobs.size) return result;
    try {
      const notice = takeFinishedNotice();
      return notice ? withNudge(r, notice, '_reportReady') : result;
    } catch {
      return result;
    }
  };
}

/** Tests only. */
export function resetJobsForTests(): void {
  for (const j of jobs.values()) { clearTimeout(j.timer); j.abort.abort(); }
  jobs.clear();
}
