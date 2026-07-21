// Pure validation + size-guard logic for the platform usage-report CSV exports
// (GET /api/v2/configuration/get-CSV-reports/...). Kept dependency-free (no
// network, no fs) so it can be unit-tested directly.

export type UsageReportType =
  | 'Device Reservations'
  | 'Users Usage'
  | 'Devices Usage'
  | 'Browser Usage'
  | 'Users Statistics'
  | 'License Usage';

interface ReportCapabilities {
  supportsProject: boolean;
  supportsUser: boolean;
  /**
   * Literal object-type path segment the backend expects.
   *
   * For "Users Statistics", a since-superseded internal note suggested the wire
   * value was misspelled "Users Stastistics". Live testing against this tenant
   * disproved that: the correctly-spelled "Users Statistics" returns real data
   * (200, per-user click/screen-time telemetry) and the misspelled variant 500s
   * consistently, at every projectId/date-range combination tried. If a future
   * platform version flips this, re-probe both spellings before trusting either.
   */
  wireValue: string;
}

export const USAGE_REPORT_TYPES: Record<UsageReportType, ReportCapabilities> = {
  'Device Reservations': { supportsProject: true, supportsUser: true, wireValue: 'Device Reservations' },
  'Users Usage': { supportsProject: true, supportsUser: true, wireValue: 'Users Usage' },
  'Devices Usage': { supportsProject: true, supportsUser: false, wireValue: 'Devices Usage' },
  'Browser Usage': { supportsProject: true, supportsUser: false, wireValue: 'Browser Usage' },
  'Users Statistics': { supportsProject: true, supportsUser: true, wireValue: 'Users Statistics' },
  'License Usage': { supportsProject: false, supportsUser: false, wireValue: 'License Usage' },
};

// Measured live (see CLAUDE.md): one unfiltered month of License Usage was ~27 MB;
// one unfiltered week of Device Reservations was ~6.4 MB. Beyond this many days
// with no project/user narrowing, require explicit confirmation.
export const MAX_UNSCOPED_RANGE_DAYS = 31;

export interface UsageReportParams {
  reportType: UsageReportType;
  startDate: string; // "YYYY-MM-DD"
  endDate: string; // "YYYY-MM-DD"
  projectId?: number;
  userId?: number;
  confirmLargeExport?: boolean;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Converts a "YYYY-MM-DD" calendar day to its UTC epoch-ms boundary.
 *
 * The backend filters on raw epoch ms with no timezone awareness of its own —
 * confirmed live by requesting the same calendar month two ways: our own
 * example encoding (Pacific-Time midnight) vs. literal UTC midnight returned
 * DIFFERENT byte-for-byte data, with the Pacific version missing the first
 * 7-8 hours of the UTC day. Always anchor to UTC here so results are
 * reproducible regardless of the caller's or server's local timezone.
 */
export function usageReportUtcMs(dateStr: string, boundary: 'start' | 'end'): number {
  return boundary === 'start'
    ? Date.parse(`${dateStr}T00:00:00.000Z`)
    : Date.parse(`${dateStr}T23:59:59.999Z`);
}

/** Returns an error message string, or null if params are well-formed. */
export function validateUsageReportParams(params: UsageReportParams): string | null {
  const caps = USAGE_REPORT_TYPES[params.reportType];
  if (!caps) return `Unknown reportType "${params.reportType}".`;
  if (!DATE_RE.test(params.startDate)) return `startDate must be "YYYY-MM-DD", got "${params.startDate}".`;
  if (!DATE_RE.test(params.endDate)) return `endDate must be "YYYY-MM-DD", got "${params.endDate}".`;
  if (params.projectId !== undefined && !caps.supportsProject) {
    return `"${params.reportType}" does not support project filtering — omit projectId.`;
  }
  if (params.userId !== undefined && !caps.supportsUser) {
    return `"${params.reportType}" does not support user filtering — omit userId.`;
  }
  const startMs = usageReportUtcMs(params.startDate, 'start');
  const endMs = usageReportUtcMs(params.endDate, 'end');
  if (Number.isNaN(startMs)) return `Invalid startDate "${params.startDate}".`;
  if (Number.isNaN(endMs)) return `Invalid endDate "${params.endDate}".`;
  if (endMs < startMs) return 'endDate must not be before startDate.';
  return null;
}

/**
 * Returns a guard message (safe to return to the caller, isError: false — same
 * convention as checkDestructiveGuard) if this request looks like it will
 * produce a very large, slow download with no way for the caller to have
 * anticipated it. Returns null when the request may proceed.
 */
export function checkUsageReportSizeGuard(params: UsageReportParams): string | null {
  if (params.confirmLargeExport === true) return null;
  const caps = USAGE_REPORT_TYPES[params.reportType];

  const startMs = usageReportUtcMs(params.startDate, 'start');
  const endMs = usageReportUtcMs(params.endDate, 'end');
  const rangeDays = Math.ceil((endMs - startMs + 1) / 86_400_000);

  const hasProjectFilter = caps.supportsProject && params.projectId !== undefined && params.projectId !== 0;
  const hasUserFilter = caps.supportsUser && params.userId !== undefined && params.userId !== 0;
  const isNarrowed = hasProjectFilter || hasUserFilter;

  if (isNarrowed || rangeDays <= MAX_UNSCOPED_RANGE_DAYS) return null;

  const narrowingAdvice =
    caps.supportsProject || caps.supportsUser
      ? `Narrow the request with ${[caps.supportsProject && 'projectId', caps.supportsUser && 'userId']
          .filter(Boolean)
          .join(' and/or ')}, or shorten the date range to ${MAX_UNSCOPED_RANGE_DAYS} days or less.`
      : `"${params.reportType}" has no project/user filter available — shorten the date range to ${MAX_UNSCOPED_RANGE_DAYS} days or less.`;

  return (
    `⚠️  Large export guard triggered.\n\n` +
    `"${params.reportType}" for ${rangeDays} days with no project/user filter is likely to be very large ` +
    `(measured live: an unfiltered month of License Usage was ~27 MB; an unfiltered week of Device Reservations ` +
    `was ~6.4 MB). A multi-month or full-year unfiltered export can run into the hundreds of MB and take minutes.\n\n` +
    `${narrowingAdvice}\n\n` +
    `To proceed anyway, include confirmLargeExport: true in your request.\n\n` +
    `No download was attempted.`
  );
}
