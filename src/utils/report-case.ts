/**
 * Letter case in test report values.
 *
 * The platform stores what each client sent: a tenant holds "ANDROID" and "Android", "Chrome" and "chrome", and its
 * `=` filter matches one spelling only (live 2026-11-25: browserName = "chrome" 1,243 runs, = "Chrome" 809, = "CHROME"
 * 0). A person asking for "Chrome runs" means all of them, so by default a filter value and a group value are matched
 * whatever their case.
 *
 * How, in one request: the platform's `contains` filter ignores case (verified live on 16 report keys, 2026-11-25), so an
 * equality filter is sent as `contains`, the key is added to the grouping, and only the groups whose value EQUALS the
 * wanted one (case aside) are kept. `contains` treats "_" and "%" as wildcards; that only widens what comes back, and
 * the equality check here decides. No other operator ignores case (ilike, equalsIgnoreCase … → 400).
 */

export type GroupRow = Record<string, unknown>;
export interface ReporterFilter { property: string; operator?: string; value?: unknown }

/** Columns that hold numbers, booleans or times: an equality on them is sent as written. */
const EXACT_ONLY = new Set(['test_id', 'project_id', 'status_code', 'success', 'has_attachment', 'accessibility_report', 'duration', 'attachment_count',
  'attachments_size', 'start_time', 'create_time']);
const lc = (v: unknown) => String(v).toLowerCase();
/** A value whose upper and lower case differ; "12.0" and "2026-11-22" have nothing to ignore. */
const hasLetters = (v: unknown): v is string => typeof v === 'string' && v.toLowerCase() !== v.toUpperCase();
const CANONICAL_OS: Record<string, string> = { android: 'Android', ios: 'iOS' };

export interface LoosePlan<F extends ReporterFilter> {
  /** The grouping to send: the one asked for plus the filtered keys, so the stored spelling comes back. */
  groupBy: string[];
  /** The filter to send: each loosened equality as `contains`. */
  filter: F[];
  /** Rows of the answer → rows for the question asked: only the wanted values, without the added keys. */
  apply(rows: GroupRow[]): { rows: GroupRow[]; matched: Record<string, string[]> };
}

/** A plan for the equality filters that can ignore case, or null when the request has none. */
export function loosePlan<F extends ReporterFilter>(groupBy: string[] | undefined, filter: F[] | undefined): LoosePlan<F> | null {
  const loose = (filter ?? []).filter((f) => (f.operator ?? '=') === '=' && hasLetters(f.value) && !EXACT_ONLY.has(f.property));
  if (!loose.length) return null;
  const asked = groupBy ?? [];
  const added = [...new Set(loose.map((f) => f.property))].filter((k) => !asked.includes(k));
  return {
    groupBy: [...asked, ...added],
    filter: (filter ?? []).map((f) => (loose.includes(f) ? { ...f, operator: 'contains', value: lc(f.value) } : f)),
    apply(rows) {
      const matched: Record<string, Set<string>> = {};
      const kept: GroupRow[] = [];
      for (const row of rows) {
        if (!loose.every((f) => row[f.property] != null && lc(row[f.property]) === lc(f.value))) continue;
        for (const f of loose) (matched[f.property] ??= new Set()).add(String(row[f.property]));
        if (!added.length) { kept.push(row); continue; }
        const copy = { ...row };
        for (const k of added) delete copy[k];
        kept.push(copy);
      }
      return { rows: kept, matched: Object.fromEntries(loose.map((f) => [f.property, [...(matched[f.property] ?? [])].sort()])) };
    },
  };
}

/**
 * One row per combination of `fields`: rows that agree on every field are summed (every numeric column that is not a
 * field). With `ignoreCase`, values that differ only in case are one group, shown in the spelling most runs have
 * (the platform column always as Android / iOS). `merged` lists, per field, the spellings that became one group.
 * `exactFields` are never folded: they name things (a project), not a value a test client spelled.
 */
export function mergeGroupRows(rows: GroupRow[], fields: string[], ignoreCase: boolean, exactFields: string[] = []): { rows: GroupRow[]; merged: Record<string, string[][]> } {
  const weight = (r: GroupRow) => (typeof r['_count_'] === 'number' ? (r['_count_'] as number) : 1);
  const folds = (f: string) => ignoreCase && !exactFields.includes(f);
  const fold = (f: string, v: unknown) => (v == null ? null : folds(f) && typeof v === 'string' ? v.toLowerCase() : v);
  // Per field and folded value: the runs behind each stored spelling.
  const spellings = new Map<string, Map<string, Map<string, number>>>();
  const out = new Map<string, GroupRow>();
  for (const row of rows) {
    const key = JSON.stringify(fields.map((f) => fold(f, row[f])));
    if (ignoreCase) for (const f of fields) {
      const v = row[f];
      if (typeof v !== 'string' || !folds(f)) continue;
      const byFold = spellings.get(f) ?? new Map<string, Map<string, number>>();
      spellings.set(f, byFold);
      const seen = byFold.get(v.toLowerCase()) ?? new Map<string, number>();
      byFold.set(v.toLowerCase(), seen);
      seen.set(v, (seen.get(v) ?? 0) + weight(row));
    }
    const hit = out.get(key);
    if (!hit) { out.set(key, { ...row }); continue; }
    for (const [k, v] of Object.entries(row)) if (typeof v === 'number' && !fields.includes(k)) hit[k] = ((hit[k] as number | undefined) ?? 0) + v;
  }
  const merged: Record<string, string[][]> = {};
  if (ignoreCase) {
    const shown = (f: string, v: string) => {
      if (f === 'device.os' && CANONICAL_OS[v.toLowerCase()]) return CANONICAL_OS[v.toLowerCase()];
      const seen = spellings.get(f)?.get(v.toLowerCase());
      return seen ? [...seen].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0] : v;
    };
    for (const row of out.values()) for (const f of fields) if (folds(f) && typeof row[f] === 'string') row[f] = shown(f, row[f] as string);
    for (const [f, byFold] of spellings) {
      const several = [...byFold.values()].filter((seen) => seen.size > 1).map((seen) => [...seen.keys()].sort());
      if (several.length) merged[f] = several;
    }
  }
  return { rows: [...out.values()], merged };
}
