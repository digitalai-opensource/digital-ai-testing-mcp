/**
 * Playwright runs through the Execution Service API — the platform runs the whole project in Microsoft's Playwright
 * container image and reports to the Reporter (test.run.id = the run's UUID). Needs a Cross Browser license; SaaS only.
 *
 * Verified live 2026-11-12 (uscloud, Cloud Admin and Project Admin keys):
 *  - POST /api/v1/executions, multipart: type=Playwright, project=<zip>, conf=<JSON> → { data: { "Test Run Id": <UUID>,
 *    "Link to Reporter": … } }. The UUID is how a Playwright run is told apart from a Test Run API run (numeric id).
 *  - conf.browsers[].imageVersion is checked against mcr.microsoft.com/playwright:v<version> at submit time — an unknown
 *    version is a 400 "Could not find image [mcr.microsoft.com/playwright:v0.0.1] …".
 *  - GET /api/v1/executions/{uuid}/status → { "Test Run State": QUEUED | RUNNING | CANCELED …, "Reason for Queue":
 *    "Waiting for licenses", browser counts, "Link to Reporter" }. Unknown id → 400 "Test Run <id> was not found".
 *  - PUT /api/v1/executions/{uuid}/actions/cancel → QUEUED → CANCELED; a second cancel answers (200) "Invalid request.
 *    This execution session is already canceled".
 *  - GET /api/v1/executions/{uuid}/logs → a zip (22-byte empty zip for a run that never started).
 * UNVERIFIED: every run on the dev tenant stayed QUEUED "Waiting for licenses" (two projects), so the states after
 * RUNNING, the browser counts of a real run and the log contents have not been seen. Re-probe when a license exists.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { basename, join } from 'path';
import FormData from 'form-data';
import AdmZip from 'adm-zip';
import { apiDownload, apiGet, apiPostForm, apiPut } from './client.js';
import type { TestRunStatus } from './test-runs.js';

export const PLAYWRIGHT_BROWSERS = ['chromium', 'firefox', 'webkit'] as const;
export type PlaywrightBrowser = (typeof PLAYWRIGHT_BROWSERS)[number];

/** Playwright runs get a UUID; Test Run API runs get a number (both verified live). */
export function isPlaywrightRunId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id.trim());
}

/** Folders never worth uploading, and credential files that must never leave the machine. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'test-results', 'playwright-report', 'blob-report', '.cache', 'coverage']);
const SECRET_FILE = /^(\.env(\..*)?|.*\.(pem|key|p12|pfx)|id_(rsa|dsa|ecdsa|ed25519)|credentials\.json|\.npmrc)$/i;

export interface PlaywrightProject {
  zip: Buffer;
  fileName: string;
  files: string[];
  hasConfig: boolean;
  specCount: number;
  /** @playwright/test version from package.json (devDependencies or dependencies), without ^/~, when exact enough. */
  detectedVersion: string | null;
  skipped: string[];
}

function versionFromPackageJson(text: string): string | null {
  try {
    const pkg = JSON.parse(text) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const spec = pkg.devDependencies?.['@playwright/test'] ?? pkg.dependencies?.['@playwright/test'] ?? pkg.devDependencies?.playwright ?? pkg.dependencies?.playwright;
    const m = spec?.match(/(\d+\.\d+\.\d+)/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/** Read a project .zip, or zip a project folder (skipping node_modules, reports, VCS and credential files). */
export function loadPlaywrightProject(path: string): PlaywrightProject {
  if (!existsSync(path)) throw new Error(`Not found: ${path}`);
  const skipped: string[] = [];
  let zip: AdmZip;
  if (statSync(path).isDirectory()) {
    zip = new AdmZip();
    const walk = (dir: string, rel: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        const relPath = rel ? `${rel}/${name}` : name;
        const st = statSync(full);
        if (st.isDirectory()) {
          if (SKIP_DIRS.has(name)) { skipped.push(`${relPath}/`); continue; }
          walk(full, relPath);
        } else if (SECRET_FILE.test(name)) {
          skipped.push(relPath);
        } else {
          zip.addFile(relPath, readFileSync(full));
        }
      }
    };
    walk(path, '');
  } else {
    if (!/\.zip$/i.test(path)) throw new Error('projectPath must be a Playwright project folder or a .zip of one.');
    try { zip = new AdmZip(path); } catch (e) { throw new Error(`Could not read ${path} as a ZIP: ${(e as Error).message}`); }
  }
  const files = zip.getEntries().filter((e) => !e.isDirectory).map((e) => e.entryName.replace(/\\/g, '/'));
  const hasConfig = files.some((f) => /^playwright\.config\.(js|ts|mjs|cjs)$/.test(f));
  const specCount = files.filter((f) => /\.(spec|test)\.(js|ts|mjs|cjs)$/.test(f) && !f.startsWith('node_modules/')).length;
  const pkg = zip.getEntry('package.json');
  const detectedVersion = pkg ? versionFromPackageJson(pkg.getData().toString('utf8')) : null;
  return {
    zip: zip.toBuffer(),
    fileName: statSync(path).isDirectory() ? `${basename(path) || 'playwright-project'}.zip` : basename(path),
    files,
    hasConfig,
    specCount,
    detectedVersion,
    skipped,
  };
}

export interface PlaywrightConf {
  browsers: Array<{ browser?: PlaywrightBrowser; imageVersion: string }>;
}

/**
 * Build the run configuration. With a playwright.config.* the config's own projects choose the browsers and conf only
 * pins the image ("With playwright.config.js: { imageVersion }" — platform docs); without one, each browser is listed.
 */
export function buildPlaywrightConf(p: { hasConfig: boolean }, imageVersion: string, browsers?: PlaywrightBrowser[]): PlaywrightConf | string {
  if (!/^\d+\.\d+\.\d+$/.test(imageVersion)) return `imageVersion must look like "1.49.0" (a tag of mcr.microsoft.com/playwright), got "${imageVersion}".`;
  if (browsers?.length) return { browsers: browsers.map((browser) => ({ browser, imageVersion })) };
  if (p.hasConfig) return { browsers: [{ imageVersion }] };
  return 'The project has no playwright.config.* — pass browsers (chromium, firefox and/or webkit).';
}

export async function executePlaywrightRun(project: PlaywrightProject, conf: PlaywrightConf): Promise<{ testRunId: string; reporterLink: string | null }> {
  const form = new FormData();
  form.append('type', 'Playwright');
  form.append('project', project.zip, { filename: project.fileName, contentType: 'application/zip' });
  form.append('conf', JSON.stringify(conf));
  try {
    const res = await apiPostForm<{ data?: Record<string, string> }>('/api/v1/executions', form);
    const id = res.data?.['Test Run Id'];
    if (!id) throw new Error(`the platform returned no Test Run Id: ${JSON.stringify(res).slice(0, 300)}`);
    return { testRunId: String(id), reporterLink: res.data?.['Link to Reporter'] ?? null };
  } catch (e) {
    throw new Error(`Playwright run not started: ${(e as Error).message}`);
  }
}

const num = (v: unknown): number | null => {
  const n = Number(v);
  return v == null || v === '' || !Number.isFinite(n) || n < 0 ? null : n;
};

/** Pure: Execution Service status → the shared TestRunStatus shape (browser counts in place of test counts). */
export function normalizePlaywrightStatus(id: string, d: Record<string, unknown>): TestRunStatus {
  const state = String(d['Test Run State'] ?? 'Unknown');
  return {
    testRunId: String(d['Test Run Id'] ?? id),
    state,
    finished: !/^(queued|running|pending|starting|initializing)$/i.test(state) && state !== 'Unknown',
    counts: {
      inFile: null,
      requested: num(d['Number of requested browsers']),
      total: num(d['Number of requested browsers']),
      passed: null,
      failed: null,
      skipped: null,
      running: num(d['Number of browsers running']),
      queued: num(d['Number of browsers in queue']),
      ignored: null,
    },
    reporterLink: d['Link to Reporter'] != null ? String(d['Link to Reporter']) : null,
    kind: 'playwright',
    browsersCompleted: num(d['Number of browsers completed']),
    queueReason: d['Reason for Queue'] != null ? String(d['Reason for Queue']) : null,
  };
}

export async function getPlaywrightRunStatus(id: string): Promise<TestRunStatus> {
  try {
    const res = await apiGet<{ data?: Record<string, unknown> }>(`/api/v1/executions/${encodeURIComponent(id)}/status`);
    return normalizePlaywrightStatus(id, res.data ?? {});
  } catch (e) {
    throw new Error(`Playwright run status failed: ${(e as Error).message}`);
  }
}

export async function cancelPlaywrightRun(id: string): Promise<string> {
  try {
    const r = await apiPut<unknown>(`/api/v1/executions/${encodeURIComponent(id)}/actions/cancel`);
    return typeof r === 'string' ? r : JSON.stringify(r);
  } catch (e) {
    throw new Error(`Playwright run cancel failed: ${(e as Error).message}`);
  }
}

export async function downloadPlaywrightLogs(id: string): Promise<Buffer> {
  try {
    return await apiDownload(`/api/v1/executions/${encodeURIComponent(id)}/logs`);
  } catch (e) {
    throw new Error(`Playwright run logs failed: ${(e as Error).message}`);
  }
}
