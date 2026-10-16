import { writeFile } from 'fs/promises';
import { StringDecoder } from 'node:string_decoder';
import { apiDownloadStream } from './client.js';
import { USAGE_REPORT_TYPES, usageReportUtcMs, type UsageReportType } from '../utils/usage-report-guard.js';
import { parseCsv, parseCsvSections } from '../utils/csv.js';
import { pickSection, sectionHasColumns, summarizeRows, type SummarizeOptions, type SummaryResult } from '../utils/usage-report-summary.js';

// v2 API — Cloud Admin only. Confirmed live: a project-level key (Project Admin
// or Project User) gets a 403 "This endpoint requires Cloud Admin access", same
// as list_agents/list_regions/etc.

export interface UsageReportRequest {
  startDate: string; // "YYYY-MM-DD", inclusive
  endDate: string; // "YYYY-MM-DD", inclusive
  projectId?: number;
  userId?: number;
}

/** Path segments are project/user/startMs/endMs/objectType — 0 means "All" for project/user. */
export function buildUsageReportPath(reportType: UsageReportType, params: UsageReportRequest): string {
  const caps = USAGE_REPORT_TYPES[reportType];
  const startMs = usageReportUtcMs(params.startDate, 'start');
  const endMs = usageReportUtcMs(params.endDate, 'end');
  const projectSegment = params.projectId ?? 0;
  const userSegment = params.userId ?? 0;
  return `/api/v2/configuration/get-CSV-reports/${projectSegment}/${userSegment}/${startMs}/${endMs}/${encodeURIComponent(caps.wireValue)}`;
}

/**
 * Wall-clock cap on one usage-report fetch (USAGE_REPORT_TIMEOUT_MS overrides). Measured live 2026-10-14: one
 * unfiltered month of Device Reservations was ~12 MB / ~40k rows; the platform had it ready in ~4 s and the remaining
 * 1–4 minutes was transfer (three of them in one agent session blew a 10-minute budget). axios's idle timeout never fires on a streaming
 * response, so without this cap a tool call can block for as long as the platform keeps sending.
 */
export const DEFAULT_USAGE_REPORT_TIMEOUT_MS = 240_000;
export function usageReportTimeoutMs(): number {
  const n = Number(process.env.USAGE_REPORT_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_USAGE_REPORT_TIMEOUT_MS;
}

export interface UsageReportCsv {
  data: Buffer;
  fetchMs: number;
  /** True when reading stopped at the end of the first (summary) section — `data` holds only that section. */
  stoppedAfterFirstSection?: boolean;
}

export interface FetchUsageReportOptions {
  /**
   * Called once with the FIRST section's header row as soon as the blank line that ends it arrives. Return true to
   * stop reading there. Measured live 2026-10-14: the platform generates the whole CSV in ~4 s and the rest of the
   * 1–4 minutes is transferring ~12 MB of per-reservation rows — rows a per-project summary never looks at.
   */
  stopAfterFirstSection?: (headers: string[]) => boolean;
}

const SECTION_BREAK = /\r?\n\r?\n/;
const SINGLE_SECTION_PROBE_BYTES = 1_000_000; // no blank line in the first MB → a single-section report; read it all

/**
 * Streams the raw CSV bytes into memory without writing anything to disk, under the wall-clock cap above. With
 * `stopAfterFirstSection`, may return only the first section (`stoppedAfterFirstSection: true`).
 */
export async function fetchUsageReportCsv(
  reportType: UsageReportType,
  params: UsageReportRequest,
  opts: FetchUsageReportOptions = {}
): Promise<UsageReportCsv> {
  const path = buildUsageReportPath(reportType, params);
  const timeoutMs = usageReportTimeoutMs();
  const started = Date.now();
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), timeoutMs);
  try {
    const stream = await apiDownloadStream(path, { signal: deadline.signal });
    const chunks: Buffer[] = [];
    let probe = '';
    // A StringDecoder carries a multi-byte character split across chunks over to the next write; decoding each chunk
    // on its own would put U+FFFD into the first section's bytes (a project called "Zürich QA" became two groups).
    const decoder = new StringDecoder('utf8');
    let decided = !opts.stopAfterFirstSection;
    let firstSection: Buffer | null = null;
    await new Promise<void>((resolve, reject) => {
      stream.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
        if (decided) return;
        probe += decoder.write(chunk);
        const m = probe.match(SECTION_BREAK);
        if (!m) {
          if (probe.length > SINGLE_SECTION_PROBE_BYTES) { decided = true; probe = ''; }
          return;
        }
        decided = true;
        const first = probe.slice(0, m.index);
        probe = '';
        if (opts.stopAfterFirstSection!(parseCsv(first).headers)) {
          firstSection = Buffer.from(first, 'utf8');
          (stream as unknown as { destroy: () => void }).destroy();
          resolve();
        }
      });
      stream.on('end', resolve);
      // After a deliberate destroy the stream may emit an abort error — that is not a failure.
      stream.on('error', (e: Error) => (firstSection ? resolve() : reject(e)));
      stream.on('close', () => (firstSection ? resolve() : undefined));
    });
    const data = firstSection ?? Buffer.concat(chunks);
    return { data, fetchMs: Date.now() - started, ...(firstSection ? { stoppedAfterFirstSection: true } : {}) };
  } catch (e) {
    const msg = (e as Error).message ?? '';
    if (/abort|cancel|timeout/i.test(msg) && Date.now() - started >= timeoutMs - 50) {
      const scope = params.projectId || params.userId ? 'this filter' : 'no project/user filter';
      throw new Error(
        `"${reportType}" for ${params.startDate}..${params.endDate} with ${scope} was still being generated after ${Math.round(timeoutMs / 1000)} s and was abandoned. ` +
        'The platform builds the CSV on request and an unfiltered month of Device Reservations / Users Usage is ~12 MB (measured live). ' +
        'Narrow it with projectId or userId, use a shorter date range, or hand the user get_usage_report_download_command so the ' +
        'download runs outside this tool. One report at a time: parallel requests slow each other down. ' +
        `(USAGE_REPORT_TIMEOUT_MS raises the cap; current ${timeoutMs} ms.)`
      );
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export async function downloadUsageReport(
  reportType: UsageReportType,
  params: UsageReportRequest,
  localPath: string
): Promise<{ bytes: number; fetchMs: number }> {
  try {
    const { data, fetchMs } = await fetchUsageReportCsv(reportType, params);
    await writeFile(localPath, data);
    return { bytes: data.length, fetchMs };
  } catch (e) {
    throw new Error(`downloadUsageReport failed: ${(e as Error).message}`);
  }
}

/**
 * Fetches the CSV into memory and aggregates it by a column — e.g. session
 * counts by username — without ever writing a file. Exists specifically so
 * this works from a client whose filesystem is not the MCP server's own
 * (see CLAUDE.md's "Usage Report CSV Exports" notes): no file crosses that
 * boundary at all, so there is nothing for the caller to fail to read back.
 */
export async function summarizeUsageReport(
  reportType: UsageReportType,
  params: UsageReportRequest,
  opts: SummarizeOptions
): Promise<SummaryResult> {
  try {
    // Per-project totals live in the first (summary) section: stop reading there instead of pulling every reservation row.
    const { data, fetchMs, stoppedAfterFirstSection } = await fetchUsageReportCsv(reportType, params, {
      stopAfterFirstSection: (headers) => sectionHasColumns(headers, opts),
    });
    const parsed = pickSection(parseCsvSections(data.toString('utf8')), opts);
    return { ...summarizeRows(parsed, opts), fetchMs, csvBytes: data.length, ...(stoppedAfterFirstSection ? { stoppedAfterFirstSection: true } : {}) };
  } catch (e) {
    throw new Error(`summarizeUsageReport failed: ${(e as Error).message}`);
  }
}
