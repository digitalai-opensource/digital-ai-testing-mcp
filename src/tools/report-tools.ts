import { z } from 'zod';
import { mkdirSync, writeFileSync, existsSync, statSync, readdirSync, rmSync, readFileSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { getDeploymentMode } from '../utils/deployment-mode.js';
import { readReportDirSetting } from '../utils/credential-store.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { renderReport, type ReportSpec } from '../utils/report-render.js';
import { validateOutputPath } from '../utils/path-guard.js';
import { REPORT_META_KEY, REPORT_VIEW_URI, VIEW_MIME_TYPE, clientDeclaresUi, noteViewRead, reportViewHtml, viewActive } from '../utils/report-view.js';
import { buildTestSummary, buildFailureAnalysis, buildDeviceHealth, buildUsageSummary, buildUsageOverview, addDays, isoDate, type RecipeResult, type ReservationRow } from '../utils/report-recipes.js';
import { startJob, getJob, cancelJob, listJobs, describeJob, jobDeadlineMs, fmtDuration, markJobNotified, markJobCollected, type JobResult } from '../utils/report-jobs.js';
import { scanRuns, scanFailures, groupedCounts, deviceRows, cloudProjectId, reservationRows, deviceUsageRows, userUsageRows, estimateReporterRecipe, estimateUsageRecipe, type WorkEstimate } from '../api/report-recipes.js';

// ── Full spec validation (server side) ─────────────────────────────────────────────────────────────────────────────
// The PUBLISHED schema stays small (it is paid for in every conversation); the detailed check runs here and names the
// exact field that is wrong, so a bad spec costs one short retry instead of a long schema in every session.

const num = z.number().finite();
const tone = z.enum(['pass', 'fail', 'warn', 'info', 'skip']);
const nf = { unit: z.string().max(12).optional(), decimals: z.number().int().min(0).max(4).optional() };
const series = z.strictObject({ name: z.string(), values: z.array(num.nullable()), tone: tone.optional() });
const highlight = z.strictObject({ from: z.string(), to: z.string().optional(), label: z.string().optional() });
const target = z.strictObject({ value: num, label: z.string().optional() });

const block = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('kpis'), items: z.array(z.strictObject({
    value: z.union([z.string(), num]), label: z.string(), delta: z.string().optional(), deltaGood: z.boolean().optional(),
    accent: z.enum(['green', 'teal', 'fail']).optional(),
  })).min(1).max(8) }),
  z.strictObject({ type: z.literal('share'), value: z.union([z.string(), num]).optional(), label: z.string().optional(),
    parts: z.array(z.strictObject({ label: z.string(), value: num, tone: tone.optional() })).min(1).max(8), ...nf }),
  z.strictObject({ type: z.literal('bar'), title: z.string().optional(), categories: z.array(z.string()).max(200), series: z.array(series).min(1).max(8),
    stacked: z.boolean().optional(), orientation: z.enum(['auto', 'vertical', 'horizontal']).optional(), highlight: highlight.optional(),
    partial: z.array(z.string()).optional(), partialNote: z.string().optional(), showShare: z.boolean().optional(), shareTotal: num.optional(),
    otherLabel: z.string().optional(), otherNote: z.string().optional(), target: target.optional(), ...nf }),
  z.strictObject({ type: z.literal('line'), title: z.string().optional(), categories: z.array(z.string()).max(400), series: z.array(series).min(1).max(8),
    highlight: highlight.optional(), area: z.boolean().optional(), target: target.optional(), ...nf }),
  z.strictObject({ type: z.literal('compare'), groups: z.array(z.strictObject({ title: z.string(), tone: z.enum(['primary', 'secondary']).optional(), max: num.optional(),
    rows: z.array(z.strictObject({ label: z.string(), value: num, display: z.string().optional() })).min(1) })).min(1), ...nf }),
  z.strictObject({ type: z.literal('meter'), label: z.string(), value: num, max: num, display: z.string().optional(), warnAt: num.optional(), failAt: num.optional(), ...nf }),
  z.strictObject({ type: z.literal('heatmap'), title: z.string().optional(), rows: z.array(z.string()), columns: z.array(z.string()),
    values: z.array(z.array(num.nullable())), highBad: z.boolean().optional(), ...nf }),
  z.strictObject({ type: z.literal('calendar'), title: z.string().optional(), days: z.array(z.strictObject({ date: z.string(), value: num.nullable() })).max(800),
    highBad: z.boolean().optional(), ...nf }),
  z.strictObject({ type: z.literal('tiles'), title: z.string().optional(), items: z.array(z.strictObject({
    name: z.string(), status: z.string(), detail: z.string().optional(), metric: z.string().optional() })).max(300) }),
  z.strictObject({ type: z.literal('timeline'), title: z.string().optional(), events: z.array(z.strictObject({
    date: z.string(), title: z.string(), detail: z.string().optional(), tone: tone.optional() })).max(100) }),
  z.strictObject({ type: z.literal('table'), title: z.string().optional(), maxRows: z.number().int().min(1).max(500).optional(),
    columns: z.array(z.strictObject({ key: z.string(), label: z.string(), format: z.enum(['text', 'number', 'percent', 'status', 'mono', 'spark']).optional(),
      decimals: z.number().int().min(0).max(4).optional(), unit: z.string().optional() })).min(1).max(12),
    rows: z.array(z.record(z.string(), z.unknown())) }),
  z.strictObject({ type: z.literal('callout'), tone: z.enum(['finding', 'note', 'warning', 'risk']).optional(), title: z.string().optional(), text: z.string() }),
  z.strictObject({ type: z.literal('findings'), items: z.array(z.union([z.string(), z.strictObject({ text: z.string(), tone: z.enum(['good', 'bad', 'neutral']).optional() })])).min(1).max(12) }),
  z.strictObject({ type: z.literal('text'), text: z.string() }),
]);

const section = z.strictObject({
  title: z.string(), columns: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(), blocks: z.array(block).min(1).max(12),
  whatItMeans: z.string().optional(),
});

export const reportSpecSchema = z.strictObject({
  title: z.string().min(1).max(120), subtitle: z.string().max(200).optional(), eyebrow: z.string().max(40).optional(),
  meta: z.array(z.strictObject({ label: z.string(), value: z.string() })).max(6).optional(),
  headline: z.strictObject({ value: z.string(), label: z.string().optional() }).optional(),
  tabs: z.array(z.strictObject({ label: z.string(), sections: z.array(section).min(1) })).min(1).max(8).optional(),
  sections: z.array(section).min(1).max(30).optional(),
  source: z.string().max(600).optional(),
  timeZone: z.string().optional(),
}).refine((s) => !!s.tabs !== !!s.sections, { message: 'give either "tabs" or "sections", not both' });

/** Readable error lines for a spec that does not validate: "tabs.0.sections.1.blocks.0.series.0.values: expected array". */
export function specErrors(e: z.ZodError): string[] {
  return e.issues.slice(0, 12).map((i) => `${i.path.join('.') || '(spec)'}: ${i.message}`);
}

/** Problems that validate but would draw a misleading chart. */
export function specWarnings(spec: ReportSpec): string[] {
  const out: string[] = [];
  const sections = spec.tabs ? spec.tabs.flatMap((t) => t.sections.map((s) => ({ s, where: `${t.label} › ${s.title}` }))) : (spec.sections ?? []).map((s) => ({ s, where: s.title }));
  for (const { s, where } of sections) {
    if (!s.whatItMeans && s.blocks.some((b) => ['bar', 'line', 'heatmap', 'calendar', 'compare', 'share', 'table'].includes(b.type))) {
      out.push(`${where}: no whatItMeans — every section that shows data should say what it means.`);
    }
    for (const b of s.blocks) {
      if ((b.type === 'bar' || b.type === 'line') && b.series.some((x) => x.values.length !== b.categories.length)) {
        out.push(`${where}: a series has a different number of values than there are categories.`);
      }
      if (b.type === 'heatmap' && b.values.some((r) => r.length !== b.columns.length)) out.push(`${where}: a heatmap row has a different number of values than columns.`);
    }
  }
  return out;
}

// ── Delivery ──────────────────────────────────────────────────────────────────────────────────────────────────────
// The report goes BACK TO THE AGENT, which saves it where the conversation keeps its files (Claude Desktop: Outputs).
// Where a finished report goes (user decisions 2026-11-23). Never a personal folder on its own: an early build wrote to
// Documents (OneDrive-redirected, unseen) and opened a browser — "far too invasive". Allowed: a path the user names
// (outputPath), a folder they configured (MCP_REPORT_DIR), a folder their client shares with the conversation (MCP roots),
// and the system temp folder. The agent saving the attached HTML costs about the file size in output tokens (Claude
// Desktop retyped a 28 KB report in ~1-1.5 min), so the answer leads with a path whenever one exists.
//   1. outputPath / MCP_REPORT_DIR / a shared folder → written there; the agent only names it (no attachment).
//   2. otherwise, local install → temp folder + one copy command, plus the attachment for an agent whose shell cannot
//      reach this machine (Claude Desktop's sandbox).
//   3. Docker without MCP_REPORT_DIR → the attachment only (the container's disk is not the user's).
// A client that renders MCP Apps views (Claude Desktop) shows the report INLINE as well (utils/report-view.ts): the file
// is still saved by the rules above, but the answer asks the agent for nothing — no copy, no link, no writing out.

export interface ReportFile { fileName: string; html: string; savedTo?: string }

type RootsProvider = () => Promise<string[]>;
let rootsProvider: RootsProvider | null = null;
/** index.ts passes the client's workspace roots (only clients that declare the roots capability answer). */
export function setReportRootsProvider(fn: RootsProvider | null): void { rootsProvider = fn; }

export const SHARED_REPORT_SUBFOLDER = 'digital-ai-reports';
export const reportTempDir = () => join(tmpdir(), 'digital-ai-testing-reports');
const TEMP_KEEP_MS = 24 * 3_600_000;

type Placement = { kind: 'configured' | 'shared' | 'temp'; dir: string; source?: 'env' | 'setup' } | { kind: 'none' };

async function reportFolder(): Promise<Placement> {
  const configured = process.env.MCP_REPORT_DIR?.trim();
  if (configured) return { kind: 'configured', dir: configured, source: 'env' }; // also under Docker: a mounted volume the user set up
  const stored = getDeploymentMode() === 'local' ? readReportDirSetting() : {};
  if (stored.dir) return { kind: 'configured', dir: stored.dir, source: 'setup' };
  if (getDeploymentMode() !== 'local') return { kind: 'none' };
  if (rootsProvider) {
    try {
      for (const uri of await rootsProvider()) {
        const path = uri.startsWith('file:') ? fileURLToPath(uri) : uri;
        if (existsSync(path) && statSync(path).isDirectory()) return { kind: 'shared', dir: join(path, SHARED_REPORT_SUBFOLDER) };
      }
    } catch {
      // No roots support, or no answer in time — temp.
    }
  }
  return { kind: 'temp', dir: reportTempDir() };
}

function pruneTemp(dir: string): void {
  try {
    for (const n of readdirSync(dir)) {
      const f = join(dir, n);
      if (/\.html$/i.test(n) && Date.now() - statSync(f).mtimeMs > TEMP_KEEP_MS) rmSync(f, { force: true });
    }
  } catch { /* best effort */ }
}

/** Why an outputPath cannot be used, or null. Checked BEFORE any data is fetched: a recipe can run for minutes. */
export function outputPathError(outputPath: string): string | null {
  return validateOutputPath(outputPath) ?? (/\.html?$/i.test(outputPath) ? null : `outputPath must end in .html: ${outputPath}`);
}

export function buildFile(spec: ReportSpec, outputPath?: string): ReportFile | { error: string } {
  const now = new Date();
  const html = renderReport({ ...spec, generatedAt: now });
  if (!outputPath) return { fileName: reserveName(fileName(spec.title, now), html), html };
  const pathErr = outputPathError(outputPath);
  if (pathErr) return { error: pathErr };
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, html, 'utf8');
  return { fileName: basename(outputPath), html, savedTo: outputPath };
}

/** Write already rendered HTML to an outputPath (same checks as buildFile). */
export function buildFileFromHtml(fileName: string, html: string, outputPath: string): ReportFile | { error: string } {
  const pathErr = outputPathError(outputPath);
  if (pathErr) return { error: pathErr };
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, html, 'utf8');
  return { fileName: basename(outputPath) || fileName, html, savedTo: outputPath };
}

type Content = Array<{ type: 'text'; text: string } | { type: 'resource'; resource: { uri: string; mimeType: string; text: string } }>;
type Delivered = { content: Content; _meta?: Record<string, unknown> };

// Claude Desktop links only files in its Outputs; one copy inside its sandbox (which sees a folder added to the task) gave the
// user a "Download and open" card with no retyping (2026-11-23).
const OUTPUTS_COPY = 'NEXT STEP, before you answer: if you have an outputs folder (Claude Desktop: Outputs), copy this file into it ' +
  'with ONE shell command. The user gets a clickable link only for files there, so skipping this leaves them without one. Never ' +
  'retype the file. Skip only if you have no outputs folder.';

/**
 * For an agent in a Linux sandbox (Claude Desktop): find the saved report in a folder added to the conversation and copy it
 * into Outputs. /mnt/user-data/outputs is where Claude Desktop's sandbox keeps Outputs (seen live 2026-11-23).
 */
export const sandboxCopyCommand = (name: string) =>
  `f=$(find / -maxdepth 8 -name "${name}" -not -path "/proc/*" -not -path "/sys/*" -not -path "/mnt/user-data/outputs/*" 2>/dev/null | head -1); ` +
  'if [ -n "$f" ]; then cp "$f" /mnt/user-data/outputs/ && echo COPIED; else echo NOT-ADDED; fi';

const copyCommand = (src: string) => (process.platform === 'win32'
  ? `Copy-Item -LiteralPath "${src}" -Destination "<folder>"`
  : `cp "${src}" "<folder>/"`);

// Every delivered report stays in memory for an hour so the agent can have the server write it into a folder the user shared
// with the task (create_report fileName + outputPath) instead of writing it out itself. Claude Desktop's agent did exactly
// that with runId when the folder was added to the task (2026-11-23): saved in about a second, no retyping.
const DELIVERED_KEEP_MS = 3_600_000;
const delivered = new Map<string, { html: string; at: number }>();
function rememberDelivered(file: ReportFile): void {
  const now = Date.now();
  for (const [k, v] of delivered) if (now - v.at > DELIVERED_KEEP_MS) delivered.delete(k);
  delivered.set(file.fileName, { html: file.html, at: now });
}
/**
 * A generated file name that no OTHER report of the last hour holds. Names carry the title and the minute, so two
 * reports with one title made in the same minute (the same recipe for two projects, called in parallel) had the same
 * name: the second replaced the first on disk and in `delivered`, and both answers named that one file.
 */
function reserveName(name: string, html: string): string {
  let candidate = name;
  for (let n = 2; ; n++) {
    const held = delivered.get(candidate);
    if (!held || held.html === html) break;
    candidate = name.replace(/(\.html)?$/i, `-${n}.html`);
  }
  delivered.set(candidate, { html, at: Date.now() });
  return candidate;
}
/** A report delivered in the last hour, by its file name. */
export function deliveredReport(fileName: string): string | undefined { return delivered.get(fileName)?.html; }

/**
 * The same, and after that hour (or a server restart) the saved file itself: a conversation reopened later asks the inline
 * view to draw its report again. Only a plain .html file name, only in the folder reports are saved to or the temp folder.
 */
export async function findDelivered(fileName: string): Promise<string | undefined> {
  const held = deliveredReport(fileName);
  if (held || !/^[A-Za-z0-9][A-Za-z0-9._ -]*\.html?$/.test(fileName) || fileName.includes('..')) return held;
  const place = await reportFolder();
  for (const dir of [...(place.kind === 'none' ? [] : [place.dir]), reportTempDir()]) {
    try {
      const f = join(dir, fileName);
      if (existsSync(f) && statSync(f).isFile() && statSync(f).size < 16 * 1_048_576) return readFileSync(f, 'utf8');
    } catch { /* not readable: the next folder */ }
  }
  return undefined;
}

/**
 * Write a report where reports go when the user named no path (the placement rules above). Used by deliver(), and by a
 * background job the moment it finishes: its file used to be written only when the agent collected it, so a report
 * nobody asked about again never reached the report folder (user test 2026-11-24). Writing the same file twice is harmless.
 */
export async function writeToReportFolder(file: ReportFile): Promise<{ place: Placement; path: string | null; writeError: string }> {
  const place = await reportFolder();
  let path: string | null = null, writeError = '';
  if (place.kind !== 'none') {
    const target = join(place.dir, file.fileName);
    const err = validateOutputPath(target);
    if (err) writeError = err;
    else {
      try {
        mkdirSync(place.dir, { recursive: true });
        if (place.kind === 'temp') pruneTemp(place.dir);
        // A shared folder is the user's project: reports (user names, device names) must not end up in their repository.
        // Same rule as remediation/ (ensureRemediationDir).
        if (place.kind === 'shared' && !existsSync(join(place.dir, '.gitignore'))) writeFileSync(join(place.dir, '.gitignore'), '*\n', 'utf8');
        writeFileSync(target, file.html, 'utf8');
        path = target;
      } catch (e) { writeError = (e as Error).message; }
    }
  }
  return { place, path, writeError };
}

/** The tool result for a finished report — see the placement rules above. attach: return the HTML for the agent to write out. */
export async function deliver(file: ReportFile, extra: string[] = [], opts: { attach?: boolean } = {}): Promise<Delivered> {
  rememberDelivered(file);
  const kb = (Buffer.byteLength(file.html, 'utf8') / 1024).toFixed(0);
  const attachment = { type: 'resource' as const, resource: { uri: `report:///${encodeURIComponent(file.fileName)}`, mimeType: 'text/html', text: file.html } };
  // For the inline view. The HTML rides along only for a client that declared MCP Apps: _meta is not shown to the model
  // there, and a client that ignores views must not be handed 20 KB it has no use for.
  const meta = (savedTo?: string): Record<string, unknown> | undefined => (reportViewHtml() == null ? undefined
    : { [REPORT_META_KEY]: { fileName: file.fileName, ...(savedTo ? { savedTo } : {}), ...(clientDeclaresUi() ? { html: file.html } : {}) } });
  let metaPath: string | undefined = file.savedTo;
  const said = (lines: string[], withAttachment: boolean): Delivered => {
    const m = opts.attach ? undefined : meta(metaPath);
    return { content: [{ type: 'text', text: [...lines, ...extra].join('\n') }, ...(withAttachment ? [attachment] : [])], ...(m ? { _meta: m } : {}) };
  };
  // The client draws the report itself, inline: the agent has nothing to do with the file.
  const inline = (savedLine: string | null): Delivered => said([
    `✅ Report ready: ${file.fileName} (${kb} KB). It is DISPLAYED to the user right now, inline in this conversation: a view ` +
    'attached to this tool call, with Download and Full screen buttons.',
    ...(savedLine ? [savedLine] : []),
    'Do NOT copy, save, attach, link, re-create or paste the report, and run no command for it: the user already has it.',
    `Tell the user it is shown above${savedLine ? ' and where it is saved' : ''}, then the highlights in a sentence or two.`,
    `Only if the user says they cannot see it: create_report fileName: "${file.fileName}", attach: true (writing it out takes about a minute).`], false);

  if (opts.attach) {
    return said([`Report ${file.fileName} (${kb} KB) attached as text/html, as asked. Save it UNCHANGED as "${file.fileName}" in the ` +
      'user\'s outputs (writing it out takes about a minute); never edit or shorten it and never paste it into the chat.'], true);
  }
  if (file.savedTo) {
    if (getDeploymentMode() !== 'local') {
      // The server's disk is not the user's (Docker): never claim the file is where the user can open it.
      return said([`✅ Report saved on the MCP server's own filesystem: ${file.savedTo} (${kb} KB, self-contained, works offline).`,
        'That is NOT the user\'s machine unless the folder is mounted from it: say so, and give the highlights in a sentence or two. ' +
        `For a copy in the chat: create_report fileName: "${file.fileName}", attach: true.`], false);
    }
    if (viewActive()) return inline(`It is also saved where the user asked: ${file.savedTo}.`);
    return said([`✅ Report saved where the user asked: ${file.savedTo} (${kb} KB, self-contained, works offline).`,
      OUTPUTS_COPY, 'Tell the user the full path and the highlights in a sentence or two.'], false);
  }
  const { place, path, writeError } = await writeToReportFolder(file);
  if (path && (place.kind === 'configured' || place.kind === 'shared')) {
    const where = place.kind === 'shared' ? 'the folder shared with this conversation'
      : place.source === 'setup' ? 'the report folder set with setup' : 'the folder set for reports (MCP_REPORT_DIR)';
    metaPath = path;
    if (viewActive()) return inline(`It is also saved at ${path} (${where}).`);
    if (place.kind === 'shared') {
      return said([`✅ Report saved: ${path} (${kb} KB, one self-contained HTML file that works offline), in ${where}.`,
        `It is already saved: do not re-create or paste it. ${OUTPUTS_COPY}`,
        'Tell the user the full path, then the highlights in a sentence or two.'], false);
    }
    // A configured folder is a path on the user's machine; an agent in a sandbox (Claude Desktop) sees it only as a folder
    // added to the conversation, under another path. Asked to judge whether it "can reach" the path, it skipped the copy
    // (seen live: saved, no link, although the folder was added). One command decides instead: it looks for the file by name.
    return said([`✅ Report saved: ${path} (${kb} KB, one self-contained HTML file that works offline), in ${where}.`,
      'It is already saved: do not re-create or paste it.',
      'NEXT STEP, before you answer, if you work in a sandbox with an outputs folder (Claude Desktop): run this ONE command as it ' +
      'is. It finds the file in a folder added to the conversation and copies it into Outputs, which is the only place the user ' +
      `gets a link for:\n${sandboxCopyCommand(file.fileName)}`,
      'COPIED → give the user the link to the copy in Outputs, and the full path above. NOT-ADDED → the folder is not added to this ' +
      'conversation: tell the user the full path, and that adding this folder (Add folder) gives them a link next time; a copy in ' +
      `the chat now is create_report fileName: "${file.fileName}", attach: true (writing it out takes about a minute).`,
      'Your shell is the user\'s own machine (no sandbox) → skip the command.',
      'Then the highlights in a sentence or two.'], false);
  }
  if (path && viewActive()) return inline(null);
  const sep = process.platform === 'win32' ? '\\' : '/';
  const toFolder = 'If the user added a folder on this machine to the conversation, call create_report with fileName: ' +
    `"${file.fileName}" and outputPath: "<that folder's full path on this machine>${sep}${file.fileName}" — the server writes it ` +
    `there in a second; then ${OUTPUTS_COPY.replace('NEXT STEP, before you answer: if', 'if').replace(/^./, (c) => c.toLowerCase())}`;
  if (path) {
    // No attachment: an agent in a sandbox (Claude Desktop) would write the whole HTML out again (~1 min, ~6k output tokens
    // for 20 KB, measured 2026-11-23). It asks the user instead: add a folder (seconds, with a link) or have it written out.
    return said([`✅ Report ready: ${file.fileName} (${kb} KB, one self-contained HTML file that works offline).`,
      `It is saved at ${path} (temporary, removed after a day). Hand it to the user in the FIRST way that works:`,
      `1. Your shell can reach that path: copy it with one command to where you keep files for the user (your outputs or ` +
      `working folder): ${copyCommand(path)}. Never retype the HTML.`,
      `2. ${toFolder}`,
      '3. Neither (a sandbox with no folder added, as in a Claude Desktop task without a folder): do NOT write the report out. ' +
      'Give the highlights, then ask the user: "Your report is ready. Add a folder to this conversation (Add folder) and I will ' +
      'save it there with a link in a few seconds, or say \'write it here\' and I will put it in Outputs (about a minute)." ' +
      `Folder added → step 2. "Write it here" → create_report fileName: "${file.fileName}", attach: true, then save the returned ` +
      'HTML unchanged in your outputs. The report stays available for an hour.',
      'Then tell the user where it is and the highlights in a sentence or two.'], false);
  }
  return said([`✅ Report ready: ${file.fileName} (${kb} KB, one self-contained HTML file that works offline).`,
    ...(writeError ? [`(It could not be written to the report folder: ${writeError})`] : []),
    `Save the attached text/html resource UNCHANGED as "${file.fileName}" in the user's outputs (Claude Desktop: Outputs; ` +
    'otherwise the folder where you keep files for the user) and tell them its name. Do not edit, shorten or re-create the ' +
    'HTML, and do not paste it into the chat. Then give the highlights in a sentence or two.'], true);
}

function fileName(title: string, now: Date): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'report';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${slug}-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}.html`;
}

const OUTPUT_PATH_DESC = 'Only when the user asks for the report at a specific place on this machine: an absolute .html path. ' +
  'Otherwise leave it out — the answer says where the report is (or attaches it) and how to hand it to the user.';
/**
 * The outputPath wording for THIS install, built at registration (after dotenv) like the locality.ts builders: under
 * Docker the path is on the server's disk, not the user's machine.
 */
function outputPathDesc(): string {
  if (getDeploymentMode() === 'local') return OUTPUT_PATH_DESC;
  return 'Only when the user asks for the report at a specific path: an absolute .html path on the MCP server\'s own filesystem ' +
    '(Docker: inside a mounted folder), NOT a path on the user\'s machine. Otherwise leave it out — the answer attaches the report.';
}

const DESCRIPTION =
  'Render data as a Digital.ai-branded HTML report: ONE self-contained file (styles, charts and tabs inline; works offline, ' +
  'can be mailed or attached), returned to you to save in the user\'s outputs. Use it whenever you present more than a few numbers for the user to read or share (summaries, ' +
  'trends, rankings, usage, health, failures, comparisons) instead of writing HTML, CSS or charts yourself: you send only the ' +
  'structure, the numbers and the interpretation, and every report looks like the same design system. Not for a one-line answer.\n' +
  'spec: {title, subtitle?, meta?:[{label,value}], headline?:{value,label?}, tabs?:[{label, sections}] | sections:[…], source?}. ' +
  'section: {title, columns?:1|2|3, blocks:[…], whatItMeans}. Blocks (type + fields):\n' +
  '• kpis {items:[{value,label,delta?,deltaGood?,accent?:green|teal|fail}]}\n' +
  '• share {value?,label?,parts:[{label,value,tone?}],unit?} — part-to-whole bar (manual vs automation, pass vs fail)\n' +
  '• bar {title?,categories,series:[{name,values,tone?}],stacked?,orientation?:auto|vertical|horizontal,highlight?:{from,to?,label},' +
  'partial?:[category],partialNote?,showShare?,shareTotal?,otherLabel?,otherNote?,target?:{value,label?},unit?,decimals?} — auto: dates ' +
  'become columns, long or many labels become rows; "id|description" labels show two lines; highlight shades a window (e.g. last 30 days)\n' +
  '• line {categories,series,highlight?,area?,target?} — trends over many points\n' +
  '• compare {groups:[{title,rows:[{label,value,display?}],max?}]} — period vs period; "%" displays are drawn against 100\n' +
  '• meter {label,value,max,warnAt?,failAt?} — usage against a limit (percent thresholds)\n' +
  '• heatmap {rows,columns,values,highBad?} · calendar {days:[{date:"YYYY-MM-DD",value}],highBad?} — daily activity\n' +
  '• tiles {items:[{name,status,detail?,metric?}]} — device/agent health, worst first · timeline {events:[{date,title,detail?,tone?}]}\n' +
  '• table {columns:[{key,label,format?:text|number|percent|status|mono|spark}],rows,maxRows?} · callout {tone?:finding|note|warning|risk,title?,text} · ' +
  'findings {items:[text|{text,tone?:good|bad|neutral}]} · text {text}\n' +
  'Tones: pass fail warn info skip; status text (Passed, Failed, Offline…) is coloured automatically. Write whatItMeans for every data section: ' +
  '1-3 sentences of conclusions, not a restatement of the numbers. Headings in Title Case; no em dashes; "**bold**" is the only markup. ' +
  'Pre-aggregate: send top-N plus otherLabel, not thousands of rows.';

// ── Recipes ───────────────────────────────────────────────────────────────────────────────────────────────────────

const RECIPES = ['test-summary', 'failure-analysis', 'device-health', 'usage-summary'] as const;
type Recipe = (typeof RECIPES)[number];

/** Rendered recipe specs kept for an hour, so the agent can swap in its own interpretation without refetching. */
const runs = new Map<string, { spec: ReportSpec; at: number; recipe: Recipe }>();
function remember(spec: ReportSpec, recipe: Recipe): string {
  const now = Date.now();
  for (const [k, v] of runs) if (now - v.at > 3_600_000) runs.delete(k);
  while (runs.size >= 20) runs.delete(runs.keys().next().value as string);
  const id = `${recipe}-${now.toString(36)}`;
  runs.set(id, { spec, at: now, recipe });
  return id;
}

/** Replace "What it means" texts by section title (case-insensitive). Returns the titles that matched nothing. */
export function applyInterpretations(spec: ReportSpec, texts: Record<string, string>): { spec: ReportSpec; unknown: string[] } {
  const want = new Map(Object.entries(texts).map(([k, v]) => [k.trim().toLowerCase(), v]));
  const used = new Set<string>();
  const fix = (s: ReportSpec['sections'] extends (infer T)[] | undefined ? T : never) => {
    const t = want.get(s.title.toLowerCase());
    if (t == null) return s;
    used.add(s.title.toLowerCase());
    return { ...s, whatItMeans: t };
  };
  const out: ReportSpec = spec.tabs ? { ...spec, tabs: spec.tabs.map((tab) => ({ ...tab, sections: tab.sections.map(fix) })) } : { ...spec, sections: (spec.sections ?? []).map(fix) };
  return { spec: out, unknown: [...want.keys()].filter((k) => !used.has(k)) };
}

const sectionTitles = (spec: ReportSpec) => (spec.tabs ? spec.tabs.flatMap((t) => t.sections) : spec.sections ?? []).filter((s) => s.whatItMeans).map((s) => s.title);
// Local days (the user's time zone on an npm install), see report-recipes.ts. The usage window is the user's local
// dates, which the platform then cuts at UTC midnight.
const isoDay = (t: number) => isoDate(t);
const minTestId = (runs: Array<{ test_id: number }>) => runs.length ? runs.reduce((m, r) => (r.test_id && r.test_id < m ? r.test_id : m), Number.MAX_SAFE_INTEGER) : null;

interface RecipeOpts { days?: number; recentDays?: number; projectName?: string; passRateGoal?: number; compare?: boolean; maxRecords?: number }
interface RunCtx { signal?: AbortSignal; progress?: (text: string) => void; timeoutMs?: number; prefetched?: ReservationRow[] }

const defaultDays = (r: Recipe) => (r === 'usage-summary' ? 90 : 7);

async function runRecipe(recipe: Recipe, o: RecipeOpts, ctx: RunCtx = {}): Promise<RecipeResult> {
  const now = Date.now();
  const maxRecords = o.maxRecords ?? 10_000;
  const days = o.days ?? defaultDays(recipe);
  const from = addDays(now, -(days - 1)); // whole local days; today is the last, still running
  const scanOpts = { signal: ctx.signal, onProgress: (n: number) => ctx.progress?.(`read ${n.toLocaleString('en-US')} test runs`) };
  switch (recipe) {
    case 'test-summary': {
      const compare = o.compare ?? true;
      // The previous period has the same length in time, so a partial today is compared like with like.
      const [{ runs: all, capped, sorted }, fails] = await Promise.all([
        scanRuns(compare ? from - (now - from) : from, maxRecords, o.projectName, scanOpts),
        scanFailures(from, maxRecords, o.projectName, ctx.signal),
      ]);
      const cur = all.filter((r) => Date.parse(r.start_time) >= from);
      const prev = compare ? all.filter((r) => Date.parse(r.start_time) < from) : null;
      // Newest first: once a run older than the window was read, the window itself is complete and only the comparison
      // period was cut. Saying "the range is incomplete" then was wrong (7 days of 7,000 runs + compare, limit 10,000).
      const windowCapped = capped && !(sorted && prev != null && prev.length > 0);
      const minId = minTestId(cur);
      ctx.progress?.('counting by platform and device');
      const [platforms, devices] = minId == null ? [null, null] : await Promise.all([
        groupedCounts('device.os', minId, o.projectName).catch(() => null),
        groupedCounts('device.serialNumber', minId, o.projectName).catch(() => null),
      ]);
      return buildTestSummary({ runs: cur, previous: capped ? null : prev, failures: fails.runs, platforms, devicesUsed: devices ? devices.filter((d) => d.key).length : null,
        from, to: now, days, projectName: o.projectName, passRateGoal: o.passRateGoal, capped: windowCapped || fails.capped,
        comparisonCut: compare && capped && !windowCapped });
    }
    case 'failure-analysis': {
      const [all, fails] = await Promise.all([scanRuns(from, maxRecords, o.projectName, scanOpts), scanFailures(from, maxRecords, o.projectName, ctx.signal)]);
      return buildFailureAnalysis({ failures: fails.runs, totalRuns: all.capped ? null : all.runs.length, from, to: now, days, projectName: o.projectName, capped: fails.capped });
    }
    case 'device-health': {
      const [devices, all, fails] = await Promise.all([
        deviceRows(), scanRuns(from, maxRecords, o.projectName, scanOpts).catch(() => null), scanFailures(from, maxRecords, o.projectName, ctx.signal).catch(() => null),
      ]);
      if (ctx.signal?.aborted) throw new Error('cancelled');
      const minId = all ? minTestId(all.runs) : null;
      const counts = minId == null ? null : await groupedCounts('device.serialNumber', minId, o.projectName).catch(() => null);
      return buildDeviceHealth({ devices, deviceCounts: counts, failures: fails?.runs ?? [], days, now, projectName: o.projectName });
    }
    case 'usage-summary': {
      const recentDays = Math.min(o.recentDays ?? 30, days);
      const endDay = isoDay(now), startDay = isoDay(addDays(now, -(days - 1)));
      if (!o.projectName) {
        // Every project: the aggregated reports (small files for any range). Measured live 2026-11-24, all projects:
        // Devices Usage 30 days 11 s, 180 days 18 s; Users Usage 30 days 17 s, 180 days over 30 s (the three together
        // took 56-60 s, at the limit a client gives a tool call). So the per-user report is asked for only up to
        // OVERVIEW_USERS_MAX_DAYS, and neither extra is worth a failed report.
        const cap = { signal: ctx.signal, timeoutMs: ctx.timeoutMs ?? OVERVIEW_TIMEOUT_MS };
        const withUsers = days <= OVERVIEW_USERS_MAX_DAYS;
        const recentStart = isoDay(addDays(now, -(recentDays - 1)));
        ctx.progress?.('reading the usage reports of every project');
        const [devices, recentDevices, users] = await Promise.all([
          deviceUsageRows(0, startDay, endDay, cap),
          recentDays < days ? deviceUsageRows(0, recentStart, endDay, cap).catch(() => null) : Promise.resolve(null),
          withUsers ? userUsageRows(startDay, endDay, cap).catch(() => null) : Promise.resolve(null),
        ]);
        if (ctx.signal?.aborted) throw new Error('cancelled');
        return buildUsageOverview({ devices, recentDevices, users, from: Date.parse(`${startDay}T00:00:00Z`), to: Date.parse(`${endDay}T23:59:59Z`), recentDays,
          usersNote: users ? undefined : withUsers ? 'The per-user report did not arrive in time, so users are not shown.'
            : `Users are not shown: over more than ${OVERVIEW_USERS_MAX_DAYS} days the per-user report of every project takes about a minute to build. Ask for ${OVERVIEW_USERS_MAX_DAYS} days or less, or name one project.` });
      }
      const project = await cloudProjectId(o.projectName);
      const rows = ctx.prefetched ?? (await reservationRows(project.id, startDay, endDay, {
        signal: ctx.signal, timeoutMs: ctx.timeoutMs,
        onProgress: (read, total) => ctx.progress?.(`downloaded ${(read / 1_048_576).toFixed(1)}${total ? ` of ${(total / 1_048_576).toFixed(1)}` : ''} MB of the usage report`),
      })).rows;
      ctx.progress?.('building the report');
      return buildUsageSummary({ rows, from: Date.parse(`${startDay}T00:00:00Z`), to: Date.parse(`${endDay}T23:59:59Z`), recentDays, projectName: project.name });
    }
  }
}

/** How long a recipe will take, measured before any of the slow work starts. */
async function estimateRecipe(recipe: Recipe, o: RecipeOpts): Promise<WorkEstimate> {
  const now = Date.now();
  const days = o.days ?? defaultDays(recipe);
  const windowMs = now - addDays(now, -(days - 1));
  if (recipe === 'usage-summary') {
    // Every project: small aggregated reports, 11-18 s each (live 2026-11-24).
    if (!o.projectName) return { ms: OVERVIEW_ESTIMATE_MS, basis: 'the aggregated usage reports of every project' };
    const project = await cloudProjectId(o.projectName);
    return estimateUsageRecipe(project.id, isoDay(addDays(now, -(days - 1))), isoDay(now));
  }
  return estimateReporterRecipe({
    windowMs, extraWindowMs: recipe === 'test-summary' && (o.compare ?? true) ? windowMs : 0,
    maxRecords: o.maxRecords ?? 10_000, grouped: recipe !== 'failure-analysis', projectName: o.projectName,
  });
}

const OVERVIEW_ESTIMATE_MS = 30_000;
const OVERVIEW_TIMEOUT_MS = 50_000;
const OVERVIEW_USERS_MAX_DAYS = 31;

/** Tool calls longer than this are offered as a background job. Most clients give a tool call about 60 s. */
export function syncLimitMs(): number {
  const v = Number(process.env.MCP_REPORT_SYNC_LIMIT_MS);
  return Number.isFinite(v) && v >= 5_000 ? v : 45_000;
}

/** The largest window (days) expected to finish within `limitMs`, by scaling the variable part of the estimate. */
export function fittingDays(days: number, estimateMs: number, limitMs: number, fixedMs = 8_000): number {
  if (estimateMs <= limitMs) return days;
  const scale = (limitMs - fixedMs) / Math.max(1, estimateMs - fixedMs);
  return Math.max(0, Math.floor(days * scale));
}

/**
 * The largest window below `days` whose own estimate fits `limitMs` (0: none). `msFor` must not decrease with the window.
 * The linear fittingDays offered windows that took just as long when the scan was bound by maxRecords, so the agent was
 * refused again with each smaller window it was told would fit.
 */
export function fittingDaysBy(days: number, msFor: (days: number) => number, limitMs: number): number {
  if (days <= 1 || msFor(1) > limitMs) return 0;
  let lo = 1, hi = days - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (msFor(mid) <= limitMs) lo = mid; else hi = mid - 1;
  }
  return lo;
}

const CREATE_DESCRIPTION =
  'Report generator: test summary report (test execution summary, pass rate report), failure analysis report, device health ' +
  'report, usage summary / usage report. ' +
  'Build a finished Digital.ai-branded HTML report from live data in ONE call: the server fetches the data, lays it out and ' +
  'writes a first "What it means" for every section. Prefer this over gathering data with other tools and calling render_report. ' +
  'Recipes:\n' +
  '• test-summary — runs, pass rate (vs the previous period), runs per day/week, pass rate over time, results by platform, most ' +
  'frequent failures, failure classification. days (default 7), passRateGoal, projectName.\n' +
  '• failure-analysis — failures by classification and device, a device × day heatmap, most common causes with an example test. days (default 7).\n' +
  '• device-health — pool status, devices by OS, status tiles (worst first), devices offline for more than a day, and devices that ' +
  'fail far more often than the pool. days (default 7) and projectName scope the test results only; the pool is every device this key sees.\n' +
  '• usage-summary — with projectName: reserved device hours, active users, weekly hours with the recent window shaded, top users, ' +
  'top devices. Without projectName: an overview of EVERY project in about 30 s (hours by project, device and platform; users up to 31 days; no weekly trend). ' +
  'Cloud Admin; days (default 90), recentDays (default 30).\n' +
  'Every call first MEASURES how long the report will take. If that is longer than a tool call can wait, nothing runs: the answer ' +
  'gives the estimate, a smaller window that fits, and the option to run the full report in the background; ask the user which. ' +
  'background: true starts a job and answers at once with its jobId; the job runs on the server under its own deadline and the ' +
  'next tool result says when it is ready. After starting one, END YOUR TURN and give control back to the user; never wait for it ' +
  '(no sleep, no waiting command, no polling); check with jobId only when the user asks or the notice says it is ready ' +
  '(a finished job returns the report); cancel with jobId + cancel: true. A running job costs no tokens. ' +
  'The answer says where the finished report is: already saved in a folder (just tell the user), or a temporary file to COPY ' +
  'with one command, with the HTML attached only for agents that cannot reach that path; never retype it. ' +
  'The answer also lists the highlights and a runId; runId + whatItMeans {"<section title>": "<1-3 sentences>"} replaces an ' +
  'interpretation without refetching.';

const createShape = {
    recipe: z.enum(RECIPES).optional().describe('Which report to build. Omit with runId or jobId.'),
    days: z.number().int().min(1).max(365).optional().describe('Length of the window in days (default 7; usage-summary 90).'),
    recentDays: z.number().int().min(1).max(180).optional().describe('usage-summary: the recent window compared with the whole range (default 30).'),
    projectName: z.string().optional().describe("Scope to this project (reporter project name; for usage-summary the cloud project name). Default: the access key's own scope."),
    passRateGoal: z.number().min(0).max(100).optional().describe('test-summary: draw a goal line at this pass rate (percent).'),
    compare: z.boolean().optional().describe('test-summary: compare with the previous period of the same length (default true; doubles the scan).'),
    maxRecords: z.number().int().min(500).max(25_000).optional().describe('Upper bound on reporter runs read (default 10 000). The report says when the window was cut short.'),
    background: z.boolean().optional().describe('Run as a background job (after the user agreed to a long report). Answers at once with a jobId.'),
    jobId: z.string().optional().describe('Status of a background job — a finished one returns its report; with cancel: true, stop it. Omit everything else.'),
    cancel: z.boolean().optional().describe('With jobId: cancel the job.'),
    runId: z.string().optional().describe('Re-render an earlier result from this server run (from a previous answer) instead of fetching again.'),
    whatItMeans: z.record(z.string(), z.string()).optional().describe('With runId: section title → your interpretation, replacing the generated one.'),
    title: z.string().max(120).optional().describe('Report title (default per recipe).'),
    outputPath: z.string().optional().describe(OUTPUT_PATH_DESC),
    attach: z.boolean().optional().describe('With fileName: return that report\'s HTML for you to write out (about a minute). Only when the ' +
      'user asks for a copy in the chat\'s outputs and no folder route works.'),
    fileName: z.string().optional().describe('With outputPath (or attach): write a report this server delivered in the last hour (its file name ' +
      'from that answer, from create_report or render_report) to outputPath. For a folder the user added to the conversation when ' +
      'your shell cannot reach the temporary file. Omit everything else.'),
  };
type CreateArgs = { [K in keyof typeof createShape]?: z.infer<(typeof createShape)[K]> };

async function createHandler({ recipe, days, recentDays, projectName, passRateGoal, compare, maxRecords, background, jobId, cancel, runId, whatItMeans, title, outputPath, fileName, attach }: CreateArgs) {
    const text = (t: string, isError = false) => ({ ...(isError ? { isError: true } : {}), content: [{ type: 'text' as const, text: t }] });
    try {
      // Save an already delivered report into a folder the user shared (no rendering, no fetching).
      if (fileName) {
        if (!outputPath && !attach) return text('fileName needs outputPath (the full path, on this machine, where the report should be written) or attach: true.', true);
        const html = await findDelivered(fileName);
        if (!html) return text(`No report "${fileName}" was delivered in the last hour by this server run, and no saved file of that name was found. Use runId, or create it again.`, true);
        if (!outputPath) return await deliver({ fileName, html }, [], { attach: true });
        const f = buildFileFromHtml(fileName, html, outputPath);
        if ('error' in f) return text(f.error, true);
        return await deliver(f);
      }

      // Background job status / cancel.
      if (jobId) {
        const job = cancel ? cancelJob(jobId) : getJob(jobId);
        if (!job) {
          const all = listJobs();
          return text(`No background report "${jobId}" in this server run.${all.length ? ` Jobs: ${all.map((j) => `${j.id} (${j.label}, ${j.status})`).join('; ')}.` : ''}`, true);
        }
        if (job.status === 'done' && job.result) {
          markJobCollected(job.id);
          const r = job.result;
          return await deliver({ fileName: r.fileName, html: r.html, savedTo: r.savedTo }, [describeJob(job), `runId: ${r.runId} (runId + whatItMeans replaces an interpretation).`]);
        }
        if (job.status !== 'running') markJobNotified(job.id);
        return text(describeJob(job));
      }

      // Re-render with the agent's own interpretation.
      if (runId) {
        const prev = runs.get(runId);
        if (!prev) return text(`No report "${runId}" in this server run (results are kept for an hour). Call create_report with a recipe instead.`, true);
        const applied = applyInterpretations(prev.spec, whatItMeans ?? {});
        const spec = { ...applied.spec, ...(title ? { title } : {}) };
        prev.spec = spec;
        prev.at = Date.now();
        const f = buildFile(spec, outputPath);
        if ('error' in f) return text(f.error, true);
        return await deliver(f, [`runId: ${runId}.`, ...(applied.unknown.length ? [`No section matched: ${applied.unknown.map((t) => `"${t}"`).join(', ')}.`] : [])]);
      }

      if (!recipe) return text(`Give a recipe (${RECIPES.join(', ')}), or a runId / jobId from an earlier answer.`, true);
      // Before the estimate and the fetch: a bad path used to surface only after the whole recipe (or background job) had run.
      const pathErr = outputPath ? outputPathError(outputPath) : null;
      if (pathErr) return text(pathErr, true);
      const opts: RecipeOpts = { days, recentDays, projectName, passRateGoal, compare, maxRecords };
      const d = days ?? defaultDays(recipe);
      const est = await estimateRecipe(recipe, opts);
      const limit = syncLimitMs();
      const label = `${recipe} (${d} day${d === 1 ? '' : 's'}${projectName ? `, ${projectName}` : ''})`;
      const range = est.rangeMs && est.rangeMs[1] - est.rangeMs[0] > 10_000 ? `, likely between ${fmtDuration(est.rangeMs[0])} and ${fmtDuration(est.rangeMs[1])}` : '';

      const produce = async (ctx: RunCtx): Promise<JobResult & { spec: ReportSpec; unknown: string[] }> => {
        const result = await runRecipe(recipe, opts, ctx);
        let spec = { ...result.spec, ...(title ? { title } : {}) };
        let unknown: string[] = [];
        if (whatItMeans) { const a = applyInterpretations(spec, whatItMeans); spec = a.spec; unknown = a.unknown; }
        const id = remember(spec, recipe);
        const f = buildFile(spec, outputPath);
        if ('error' in f) throw new Error(f.error);
        return { ...f, highlights: result.highlights, runId: id, spec, unknown };
      };
      const extras = (r: { highlights: string[]; runId: string; spec: ReportSpec; unknown: string[] }) => [
        ...(r.highlights.length ? ['', 'Highlights:', ...r.highlights.map((h) => `- ${h}`)] : []),
        '',
        `runId: ${r.runId} — sections with a "What it means": ${sectionTitles(r.spec).map((t) => `"${t}"`).join(', ')}.`,
        ...(r.unknown.length ? [`No section matched: ${r.unknown.map((t) => `"${t}"`).join(', ')}.`] : []),
      ];

      if (background) {
        const deadline = jobDeadlineMs(est.ms);
        const job = startJob({
          label, estimateMs: est.ms, deadlineMs: deadline,
          run: async (signal, progress) => {
            const r = await produce({ signal, progress, timeoutMs: deadline, prefetched: est.prefetched });
            // Saved the moment it is finished, not when the agent comes back for it. Never fatal: collecting it writes again.
            if (!r.savedTo && !signal.aborted) {
              try {
                const w = await writeToReportFolder(r);
                if (w.path && w.place.kind !== 'temp') r.savedAt = w.path;
              } catch { /* delivered when collected */ }
            }
            return r;
          },
        });
        const eta = new Date(job.startedAt + est.ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        return text(
          `⏳ Started ${label} in the background, jobId "${job.id}".\n` +
          `Estimated ${fmtDuration(est.ms)}${range} (${est.basis}); expected around ${eta} (server time). It stops by itself after ${fmtDuration(deadline)}.\n` +
          'END YOUR TURN NOW and give control back to the user: tell them it is running, about how long it takes, that they can keep ' +
          'working, and that they can ask "is my report ready?" at any time (or cancel it). Do NOT wait for it: no sleep, no command ' +
          'that waits, no polling. The next tool result after it finishes says so; then collect it with create_report jobId (it ' +
          'returns the report). If the user asks before that, one jobId call shows the progress; cancel with jobId + cancel: true.'
        );
      }

      if (est.ms > limit) {
        // A reporter estimate bound by maxRecords does not shrink with the window, so it is re-evaluated per window.
        const scaled = est.scaled;
        const msFor = scaled ? (n: number) => scaled(n / d) : null;
        const fit = msFor ? fittingDaysBy(d, msFor, limit) : fittingDays(d, est.ms, limit);
        const fitMs = !fit ? 0 : msFor ? msFor(fit) : Math.round(8_000 + (est.ms - 8_000) * (fit / d));
        return text(
          `This report would take about ${fmtDuration(est.ms)}${range} (${est.basis}), longer than a tool call can wait (${fmtDuration(limit)}), so nothing was started.\n` +
          'Ask the user which they want:\n' +
          (fit >= 1 ? `1. A smaller window: days: ${fit}, about ${fmtDuration(fitMs)}, returned right away.\n` : '') +
          `${fit >= 1 ? '2' : '1'}. The full ${d}-day report in the background: call again with background: true. It runs on the server (about ${fmtDuration(est.ms)}), ` +
          'can be checked or cancelled at any time and is handed back when ready; waiting costs no tokens.'
        );
      }

      // The estimate fit the limit; give the platform a little more than that to start sending (it builds CSVs first).
      const r = await produce({ prefetched: est.prefetched, timeoutMs: limit + 15_000 });
      return await deliver(r, extras(r));
    } catch (e) {
      return text(`create_report failed: ${(e as Error).message}`, true);
    }
}

// One entry point per recipe, named the way people ask. Claude Desktop does NOT pass this server's instructions to the
// agent, and in tasks that load tools on demand the agent picks from tool NAMES alone: asked for a "test summary report",
// it chose get_daily_execution_trend + summarize_test_failures over create_report twice (2026-11-23).
const RECIPE_TOOLS: Array<{ name: string; recipe: Recipe; description: string; keys: Array<keyof typeof createShape> }> = [
  { name: 'create_test_summary_report', recipe: 'test-summary', keys: ['days', 'projectName', 'passRateGoal', 'compare', 'maxRecords', 'background', 'title', 'outputPath'],
    description: 'Test summary report (test execution summary, pass rate report) as a finished Digital.ai-branded HTML file in one call: ' +
      'runs, pass rate vs the previous period, runs per day, pass rate over time, results by platform, most frequent failures, failure ' +
      'classification, each with a "What it means". Use this for any "test summary" / "test report" request instead of assembling ' +
      'one from other tools. Same as create_report recipe "test-summary"; create_report also checks background jobs (jobId) and re-renders (runId).' },
  { name: 'create_failure_analysis_report', recipe: 'failure-analysis', keys: ['days', 'projectName', 'maxRecords', 'background', 'title', 'outputPath'],
    description: 'Failure analysis report (why tests fail) as a finished Digital.ai-branded HTML file in one call: failures by ' +
      'classification and device, a device-by-day heatmap, the most common causes with an example. Same as create_report recipe "failure-analysis".' },
  { name: 'create_device_health_report', recipe: 'device-health', keys: ['days', 'projectName', 'maxRecords', 'background', 'title', 'outputPath'],
    description: 'Device health report (which devices need attention) as a finished Digital.ai-branded HTML file in one call: pool ' +
      'status, offline and degraded devices, devices failing far more than the pool. Same as create_report recipe "device-health".' },
  { name: 'create_usage_summary_report', recipe: 'usage-summary', keys: ['projectName', 'days', 'recentDays', 'background', 'title', 'outputPath'],
    description: 'Usage summary report (device reservation hours, users, devices) as a finished Digital.ai-branded HTML file. ' +
      'With projectName: that project, with weekly hours. Without it: an overview of ALL projects (hours by project, device, platform ' +
      'and user) — do not build that by hand from summarize_usage_report. Cloud Admin. A long range of one project is offered as a ' +
      'background job. Same as create_report recipe "usage-summary".' },
];

export function registerReportTools(server: McpServer): void {
  // The inline report view (MCP Apps). Registered only when it can be built; the report tools name it (toolUiMeta).
  const view = reportViewHtml();
  if (view != null) {
    server.resource('Report view', REPORT_VIEW_URI, { mimeType: VIEW_MIME_TYPE, description: 'Shows a finished report inline in the conversation (MCP Apps).' }, async () => {
      noteViewRead();
      return { contents: [{ uri: REPORT_VIEW_URI, mimeType: VIEW_MIME_TYPE, text: view }] };
    });
  }
  const outputPath = z.string().optional().describe(outputPathDesc());
  const shape = { ...createShape, outputPath };
  server.tool('create_report', CREATE_DESCRIPTION, shape, (args) => createHandler(args));
  // Literal names, so a grep (and the REGISTERED_TOOLS sync test) finds every registration.
  const recipeTool = (name: string) => {
    const t = RECIPE_TOOLS.find((x) => x.name === name)!;
    return [t.description, Object.fromEntries(t.keys.map((k) => [k, shape[k]])), (args: CreateArgs) => createHandler({ ...args, recipe: t.recipe })] as const;
  };
  server.tool('create_test_summary_report', ...recipeTool('create_test_summary_report'));
  server.tool('create_failure_analysis_report', ...recipeTool('create_failure_analysis_report'));
  server.tool('create_device_health_report', ...recipeTool('create_device_health_report'));
  server.tool('create_usage_summary_report', ...recipeTool('create_usage_summary_report'));

  server.tool(
    'render_report',
    DESCRIPTION,
    {
      spec: z.record(z.string(), z.unknown()).describe('The report outline (see the description for the shape).'),
      outputPath,
    },
    async ({ spec, outputPath }) => {
      try {
        const parsed = reportSpecSchema.safeParse(spec);
        if (!parsed.success) {
          return { isError: true, content: [{ type: 'text' as const, text: `The report spec is not valid:\n- ${specErrors(parsed.error).join('\n- ')}\nFix those fields and call render_report again.` }] };
        }
        const s = parsed.data as ReportSpec;
        const f = buildFile(s, outputPath);
        if ('error' in f) return { isError: true, content: [{ type: 'text' as const, text: f.error }] };
        const warnings = specWarnings(s);
        const blocks = (s.tabs ? s.tabs.flatMap((t) => t.sections) : s.sections ?? []).reduce((n, x) => n + x.blocks.length, 0);
        return await deliver(f, [`${s.tabs ? `${s.tabs.length} tabs · ` : ''}${blocks} blocks.`, ...(warnings.length ? ['', 'Check:', ...warnings.map((w) => `- ${w}`)] : [])]);
      } catch (e) {
        return { isError: true, content: [{ type: 'text' as const, text: `render_report failed: ${(e as Error).message}` }] };
      }
    }
  );
}
