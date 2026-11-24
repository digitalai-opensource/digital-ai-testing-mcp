/**
 * Graceful shutdown: quit every open inspection / browser session before the process exits.
 *
 * Without this, a client that closed (or was closed) with a session open left the cloud device "In Use" by the caller
 * until the platform's idle timeout, plus an orphaned inspection report — on shared, licence-counted devices. Triggers:
 * SIGINT, SIGTERM and stdin closing (a stdio client that goes away closes our input; on Windows a client typically ends
 * the process without a signal handler ever running, so stdin's end is the one chance to clean up there).
 *
 * Clients kill the server ~2 s after ending its input — shorter than a cloud quit — so the work goes to a detached
 * worker (handOffToWorker); the in-process quitAllSessions is the fallback when the worker cannot start.
 * Live 2026-11-21 (Android, SDK stdio client): device held after the client closed — 95 s before (idle timeout),
 * 11 s with the in-process quit (report left behind: the kill came first).
 */
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { listActiveSessions, quitInspectionSession } from './webdriver.js';
import { getActiveAccessKey, getActiveUrl } from './client.js';
import type { InspectionSession } from '../types/digital-ai.js';
import { cancelAllJobs } from '../utils/report-jobs.js';

/**
 * Hands the open sessions to a detached worker (shutdown-worker.ts) that outlives this process. Returns false when the
 * worker could not be started — the caller then quits in-process within its deadline.
 */
export function handOffToWorker(
  sessions: InspectionSession[],
  opts: { spawnFn?: typeof spawn } = {},
): boolean {
  try {
    const self = fileURLToPath(import.meta.url);
    const ext = self.endsWith('.ts') ? '.ts' : '.js'; // `npm run dev` runs the sources through tsx
    const worker = self.replace(/shutdown\.(ts|js)$/, `shutdown-worker${ext}`);
    const child = (opts.spawnFn ?? spawn)(process.execPath, [...process.execArgv, worker], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: {
        ...process.env,
        // The ACTIVE profile (switch_environment may have moved off the default) — reports live in its reporter.
        DIGITAL_AI_BASE_URL: getActiveUrl(),
        DIGITAL_AI_ACCESS_KEY: getActiveAccessKey(),
        MCP_CREDENTIAL_STORE: 'off',
        MCP_DEBUG_MODE: 'false',
        DAI_SHUTDOWN_SESSIONS: JSON.stringify(sessions),
      },
    });
    child.on('error', () => undefined);
    child.unref();
    return typeof child.pid === 'number';
  } catch {
    return false;
  }
}

export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 8_000;

export function shutdownTimeoutMs(): number {
  const n = Number(process.env.MCP_SHUTDOWN_TIMEOUT_MS);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_SHUTDOWN_TIMEOUT_MS;
}

export interface ShutdownResult {
  /** Sessions that were open when shutdown began. */
  open: number;
  quit: number;
  failed: number;
  /** True when the deadline passed before every quit finished. */
  timedOut: boolean;
  ms: number;
}

/** Quits all sessions in parallel, never longer than `timeoutMs`; never throws. */
export async function quitAllSessions(
  opts: {
    timeoutMs?: number;
    list?: () => Array<{ handle: string }>;
    quit?: (handle: string) => Promise<unknown>;
  } = {},
): Promise<ShutdownResult> {
  const started = Date.now();
  const list = opts.list ?? listActiveSessions;
  const quit = opts.quit ?? ((h: string) => quitInspectionSession(h));
  const handles = list().map((s) => s.handle);
  if (handles.length === 0) return { open: 0, quit: 0, failed: 0, timedOut: false, ms: 0 };
  let quitCount = 0;
  let failed = 0;
  const all = Promise.all(
    handles.map((h) =>
      quit(h).then(
        () => { quitCount++; },
        () => { failed++; },
      ),
    ),
  ).then(() => false);
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(true), opts.timeoutMs ?? shutdownTimeoutMs());
  });
  const timedOut = await Promise.race([all, deadline]);
  clearTimeout(timer);
  return { open: handles.length, quit: quitCount, failed, timedOut, ms: Date.now() - started };
}

let shuttingDown: Promise<void> | null = null;

/**
 * Installs the handlers. `exit` is injectable for tests. A second signal while cleanup runs exits at once.
 */
export function installShutdownHandlers(
  name: string,
  opts: { exit?: (code: number) => void; stdin?: NodeJS.ReadableStream } = {},
): void {
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const stdin: NodeJS.EventEmitter = opts.stdin ?? process.stdin;
  const shutdown = (reason: string) => {
    if (shuttingDown) {
      if (reason === 'SIGINT' || reason === 'SIGTERM') exit(0);
      return;
    }
    shuttingDown = (async () => {
      cancelAllJobs(); // background reports live in this process; stop them cleanly instead of mid-write
      const sessions = listActiveSessions();
      const open = sessions.length;
      if (open === 0) {
        console.error(`[${name}] Shutting down (${reason}).`);
        exit(0);
        return;
      }
      if (handOffToWorker(sessions)) {
        console.error(`[${name}] Shutting down (${reason}) — ${open} open session(s) handed to a cleanup process (device release + report cleanup).`);
        exit(0);
        return;
      }
      console.error(`[${name}] Shutting down (${reason}) — closing ${open} open session(s)…`);
      const r = await quitAllSessions();
      if (r.open > 0) {
        console.error(
          `[${name}] Closed ${r.quit}/${r.open} session(s) in ${r.ms} ms` +
            (r.failed ? `, ${r.failed} failed` : '') +
            (r.timedOut ? ' — deadline reached; the platform releases the rest at its idle timeout' : '') + '.',
        );
      }
      exit(0);
    })();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  stdin.on('end', () => shutdown('stdin closed'));
  stdin.on('close', () => shutdown('stdin closed'));
}

/** Test hook. */
export function resetShutdownStateForTests(): void {
  shuttingDown = null;
}
