/**
 * Detached shutdown worker. The exiting server spawns this with the open sessions and the active profile's credentials
 * in its environment, then exits at once: MCP clients end the server's input and kill it ~2 s later (the SDK's stdio
 * client: stdin end → 2 s → SIGTERM, a hard kill on Windows), which is shorter than quitting a cloud session
 * (measured live 2026-11-21: the report delete never ran). A detached child is not killed with its parent, so the full
 * quit — stop captures, reset a simulated location, end the session, delete the inspection report — completes.
 *
 * Environment (set by shutdown.ts, never written to disk): DIGITAL_AI_BASE_URL / DIGITAL_AI_ACCESS_KEY (the profile
 * that was ACTIVE, which may not be the default), MCP_CREDENTIAL_STORE=off, DAI_SHUTDOWN_SESSIONS (JSON InspectionSession[]).
 */
import type { InspectionSession } from '../types/digital-ai.js';
import { adoptSessionForShutdown, quitInspectionSession } from './webdriver.js';

const WORKER_DEADLINE_MS = 90_000;

async function main(): Promise<void> {
  const sessions = JSON.parse(process.env.DAI_SHUTDOWN_SESSIONS ?? '[]') as InspectionSession[];
  delete process.env.DAI_SHUTDOWN_SESSIONS;
  for (const s of sessions) adoptSessionForShutdown(s);
  await Promise.race([
    Promise.allSettled(sessions.map((s) => quitInspectionSession(s.handle))),
    new Promise((r) => setTimeout(r, WORKER_DEADLINE_MS).unref()),
  ]);
}

main().catch(() => undefined).finally(() => process.exit(0));
