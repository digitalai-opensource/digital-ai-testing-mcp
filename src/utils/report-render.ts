/**
 * Branded HTML report renderer (render_report). Pure: a compact report spec in, ONE self-contained HTML file out —
 * every style, chart (inline SVG / CSS bars) and the tab script inline, so the file works offline and can be mailed,
 * attached or archived as is. The only external request is the font stylesheet; without it the page falls back to Arial.
 *
 * Why the server draws it: an agent that writes a report by hand spends most of its output tokens on CSS, chart
 * markup and layout decisions, and five agents produce five designs. Here the agent sends only structure, numbers and
 * the "What it means" sentences; the presentation decisions below are made once, in code.
 *
 * Design rules follow the Digital.ai report style guide (colour tokens, Montserrat, compact type scale, header band,
 * KPI cards, pills, callouts, print rules, no em dashes).
 */

// ── Spec ────────────────────────────────────────────────────────────────────────────────────────────────────────────

export type Tone = 'pass' | 'fail' | 'warn' | 'info' | 'skip';
export interface Series { name: string; values: Array<number | null>; tone?: Tone }
export interface Highlight { from: string; to?: string; label?: string }
/** A dashed reference line (a goal, an SLA, a license limit). */
export interface Target { value: number; label?: string }
export interface NumberFormat { unit?: string; decimals?: number }

export type Block =
  | ({ type: 'kpis'; items: Array<{ value: string | number; label: string; delta?: string; deltaGood?: boolean; accent?: 'green' | 'teal' | 'fail' }> })
  | ({ type: 'share'; value?: string | number; label?: string; parts: Array<{ label: string; value: number; tone?: Tone }> } & NumberFormat)
  | ({ type: 'bar'; title?: string; categories: string[]; series: Series[]; stacked?: boolean; orientation?: 'auto' | 'vertical' | 'horizontal';
      highlight?: Highlight; partial?: string[]; partialNote?: string; showShare?: boolean; shareTotal?: number; otherLabel?: string; otherNote?: string; target?: Target } & NumberFormat)
  | ({ type: 'line'; title?: string; categories: string[]; series: Series[]; highlight?: Highlight; area?: boolean; target?: Target } & NumberFormat)
  | ({ type: 'compare'; groups: Array<{ title: string; rows: Array<{ label: string; value: number; display?: string }>; tone?: 'primary' | 'secondary'; max?: number }> } & NumberFormat)
  | ({ type: 'meter'; label: string; value: number; max: number; display?: string; warnAt?: number; failAt?: number } & NumberFormat)
  | ({ type: 'heatmap'; title?: string; rows: string[]; columns: string[]; values: Array<Array<number | null>>; highBad?: boolean } & NumberFormat)
  | { type: 'table'; title?: string; columns: Array<{ key: string; label: string; format?: 'text' | 'number' | 'percent' | 'status' | 'mono' | 'spark'; decimals?: number; unit?: string }>;
      rows: Array<Record<string, unknown>>; maxRows?: number }
  | ({ type: 'calendar'; title?: string; days: Array<{ date: string; value: number | null }>; highBad?: boolean } & NumberFormat)
  | { type: 'tiles'; title?: string; items: Array<{ name: string; status: string; detail?: string; metric?: string }> }
  | { type: 'timeline'; title?: string; events: Array<{ date: string; title: string; detail?: string; tone?: Tone }> }
  | { type: 'callout'; tone?: 'finding' | 'note' | 'warning' | 'risk'; title?: string; text: string }
  | { type: 'findings'; items: Array<string | { text: string; tone?: 'good' | 'bad' | 'neutral' }> }
  | { type: 'text'; text: string };

export interface Section { title: string; columns?: 1 | 2 | 3; blocks: Block[]; whatItMeans?: string }
export interface ReportSpec {
  title: string;
  subtitle?: string;
  eyebrow?: string;
  meta?: Array<{ label: string; value: string }>;
  headline?: { value: string; label?: string };
  tabs?: Array<{ label: string; sections: Section[] }>;
  sections?: Section[];
  source?: string;
  generatedAt?: Date;
  timeZone?: string;
}

// ── Text helpers ────────────────────────────────────────────────────────────────────────────────────────────────────

/** Style guide rule 1: no em dashes anywhere, including text the agent supplied. */
export function noEmDash(s: string): string {
  return s.replace(/\s*—\s*/g, ', ').replace(/, ,/g, ',');
}
export function esc(v: unknown): string {
  return noEmDash(String(v ?? '')).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
/** Escaped text with **bold** spans — the only markup agent text may carry. */
function rich(s: string): string {
  return esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}
export function fmt(v: number | null | undefined, f: NumberFormat = {}): string {
  if (v == null || !Number.isFinite(v)) return '';
  const d = f.decimals ?? Math.min(2, (String(v).split('.')[1] ?? '').length);
  const n = v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  return f.unit ? (f.unit === '%' ? `${n}%` : `${n} ${f.unit}`) : n;
}
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'x';

// ── Palette ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const CATEGORICAL = ['var(--green)', 'var(--teal)', 'var(--dark-blue)', 'var(--lime)', 'var(--gray-400)', 'var(--bright-blue)'];
const toneVar = (t: Tone) => `var(--status-${t})`;
function seriesColor(s: Series, i: number): string {
  return s.tone ? toneVar(s.tone) : CATEGORICAL[i % CATEGORICAL.length];
}

/** Sequential ramp light green → green → dark teal (style guide §5). t in 0..1. */
function ramp(t: number): { bg: string; fg: string } {
  const stops = [[0xe1, 0xf2, 0xda], [0x64, 0x9a, 0x3d], [0x27, 0x4f, 0x4a]];
  const x = Math.max(0, Math.min(1, t)) * 2;
  const [a, b] = x <= 1 ? [stops[0], stops[1]] : [stops[1], stops[2]];
  const k = x <= 1 ? x : x - 1;
  const c = a.map((v, i) => Math.round(v + (b[i] - v) * k));
  const lum = (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) / 255;
  return { bg: `rgb(${c.join(',')})`, fg: lum > 0.6 ? 'var(--text)' : '#fff' };
}

// ── Charts ──────────────────────────────────────────────────────────────────────────────────────────────────────────

function niceMax(v: number): { max: number; step: number } {
  if (!(v > 0)) return { max: 1, step: 0.25 };
  const raw = v / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  return { max: step * Math.ceil(v / step), step };
}

/** Axis range for a line: lines need no zero baseline, so a 87 to 95 move is not drawn flat. */
export function niceRange(lo: number, hi: number): { min: number; max: number; step: number } {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { min: 0, max: 1, step: 0.25 };
  if (lo >= 0 && lo <= (hi - lo) * 0.5) lo = 0; // close to zero anyway: keep the honest baseline
  const span = hi - lo || Math.abs(hi) || 1;
  const raw = span / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  let min = Math.floor(lo / step) * step;
  let max = Math.ceil(hi / step) * step;
  if (max === min) max = min + step;
  if (min < 0 && lo >= 0) min = 0;
  return { min, max, step };
}

const TIME_LABEL = /^(\d{1,4}[-/.]\d{1,2}([-/.]\d{1,4})?|(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?(\s+\d{1,4})?|w(ee)?k\s*\d+|q[1-4](\s+\d{4})?|\d{4}|\d{1,2}:\d{2})$/i;
/** Orientation by data shape: dates read left to right; long or many category labels read better as rows. */
export function chooseOrientation(b: { categories: string[]; highlight?: Highlight; orientation?: string }): 'vertical' | 'horizontal' {
  if (b.orientation === 'vertical' || b.orientation === 'horizontal') return b.orientation;
  if (b.highlight || (b.categories.length > 0 && b.categories.every((c) => TIME_LABEL.test(c.trim())))) return 'vertical';
  const longest = Math.max(0, ...b.categories.map((c) => c.length));
  return b.categories.length > 8 || longest > 10 ? 'horizontal' : 'vertical';
}

function targetLine(t: Target | undefined, y: (v: number) => number, x0: number, x1: number, f: NumberFormat): string {
  if (!t) return '';
  const yy = y(t.value).toFixed(1);
  return `<line x1="${x0}" x2="${x1}" y1="${yy}" y2="${yy}" class="target"/><text x="${x1 - 4}" y="${(y(t.value) - 5).toFixed(1)}" text-anchor="end" class="target-label">${esc(t.label ?? `Target ${fmt(t.value, f)}`)}</text>`;
}

function legend(series: Series[], extra = ''): string {
  if (series.length < 2 && !extra) return '';
  const keys = series.length < 2 ? '' : series.map((s, i) => `<span><i style="background:${seriesColor(s, i)}"></i>${esc(s.name)}</span>`).join('');
  return `<div class="key">${keys}${extra ? `<span class="caption">${esc(extra)}</span>` : ''}</div>`;
}

function indexOfCat(cats: string[], c: string | undefined): number {
  if (c == null) return -1;
  const i = cats.indexOf(c);
  return i >= 0 ? i : cats.findIndex((x) => x.toLowerCase() === c.toLowerCase());
}

function verticalBars(b: Extract<Block, { type: 'bar' }>): string {
  const W = 1080, H = 300, L = 48, R = 12, T = 32, B = 34;
  const n = b.categories.length;
  const stackedTotals = b.categories.map((_, i) => b.series.reduce((s, x) => s + (x.values[i] ?? 0), 0));
  const top = b.stacked ? Math.max(0, ...stackedTotals) : Math.max(0, ...b.series.flatMap((s) => s.values.map((v) => v ?? 0)));
  const { max, step } = niceMax(Math.max(top, b.target?.value ?? 0));
  const pw = W - L - R, ph = H - T - B;
  const band = pw / Math.max(1, n);
  const barW = band * 0.64;
  const y = (v: number) => T + ph - (v / max) * ph;
  const parts: string[] = [];
  for (let v = 0; v <= max + 1e-9; v += step) {
    parts.push(`<line x1="${L}" x2="${W - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" class="grid"/>`,
      `<text x="${L - 6}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${esc(fmt(v, { decimals: Number.isInteger(step) ? 0 : 1 }))}</text>`);
  }
  const hi = b.highlight ? [indexOfCat(b.categories, b.highlight.from), indexOfCat(b.categories, b.highlight.to ?? b.categories[n - 1])] : null;
  if (hi && hi[0] >= 0 && hi[1] >= hi[0]) {
    const x0 = L + hi[0] * band, x1 = L + (hi[1] + 1) * band;
    parts.unshift(`<rect x="${x0.toFixed(1)}" y="${T - 22}" width="${(x1 - x0).toFixed(1)}" height="${ph + 22}" class="hl"/>`,
      `<text x="${(x0 + 6).toFixed(1)}" y="${T - 8}" class="hl-label">${esc(b.highlight!.label ?? 'Highlighted')}</text>`);
  }
  const partial = new Set((b.partial ?? []).map((c) => indexOfCat(b.categories, c)));
  const labelEvery = Math.ceil(n / 24);
  b.categories.forEach((cat, i) => {
    const cx = L + i * band + band / 2;
    const op = partial.has(i) ? ' opacity="0.45"' : '';
    if (b.stacked || b.series.length === 1) {
      let base = 0;
      b.series.forEach((s, si) => {
        const v = s.values[i] ?? 0;
        if (v <= 0) return;
        parts.push(`<rect x="${(cx - barW / 2).toFixed(1)}" y="${y(base + v).toFixed(1)}" width="${barW.toFixed(1)}" height="${(y(base) - y(base + v)).toFixed(1)}" rx="2" fill="${seriesColor(s, si)}"${op}><title>${esc(`${cat} · ${s.name}: ${fmt(v, b)}`)}</title></rect>`);
        base += v;
      });
      if (n <= 31 && base > 0) parts.push(`<text x="${cx.toFixed(1)}" y="${(y(base) - 5).toFixed(1)}" text-anchor="middle" class="val">${esc(fmt(base, { decimals: b.decimals ?? (base < 10 ? 1 : 0) }))}</text>`);
    } else {
      const w = barW / b.series.length;
      b.series.forEach((s, si) => {
        const v = s.values[i] ?? 0;
        const x = cx - barW / 2 + si * w;
        parts.push(`<rect x="${x.toFixed(1)}" y="${y(v).toFixed(1)}" width="${(w - 1).toFixed(1)}" height="${(y(0) - y(v)).toFixed(1)}" rx="2" fill="${seriesColor(s, si)}"${op}><title>${esc(`${cat} · ${s.name}: ${fmt(v, b)}`)}</title></rect>`);
      });
    }
    if (i % labelEvery === 0) parts.push(`<text x="${cx.toFixed(1)}" y="${H - B + 18}" text-anchor="middle">${esc(cat.length > 14 ? cat.slice(0, 13) + '…' : cat)}</text>`);
  });
  parts.push(`<line x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}" class="axis"/>`, targetLine(b.target, y, L, W - R, b));
  const note =[b.partialNote ?? (partial.size ? 'Lighter bars are partial periods' : ''), ''].filter(Boolean).join(' ');
  return `<div class="scroll"><svg class="ch" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(b.title ?? 'Bar chart')}">${parts.join('')}</svg></div>${legend(b.series, note)}`;
}

function horizontalBars(b: Extract<Block, { type: 'bar' }>): string {
  const totals = b.categories.map((_, i) => b.series.reduce((s, x) => s + (x.values[i] ?? 0), 0));
  const top = b.stacked || b.series.length === 1 ? Math.max(0, ...totals) : Math.max(0, ...b.series.flatMap((s) => s.values.map((v) => v ?? 0)));
  const grand = b.shareTotal ?? totals.reduce((a, c) => a + c, 0);
  const rows = b.categories.map((cat, i) => {
    const [name, ...rest] = cat.split('|');
    const label = `<div class="hb-name" title="${esc(cat.replace('|', ' '))}"><b>${esc(name.trim())}</b>${rest.length ? `<span>${esc(rest.join(' ').trim())}</span>` : ''}</div>`;
    let track: string;
    if (b.stacked || b.series.length === 1) {
      track = `<div class="track">${b.series.map((s, si) => {
        const v = s.values[i] ?? 0;
        return v > 0 ? `<div class="seg" style="width:${((v / (top || 1)) * 100).toFixed(2)}%;background:${seriesColor(s, si)}" title="${esc(`${s.name}: ${fmt(v, b)}`)}"></div>` : '';
      }).join('')}</div>`;
    } else {
      track = `<div class="multi">${b.series.map((s, si) => `<div class="track thin"><div class="seg" style="width:${(((s.values[i] ?? 0) / (top || 1)) * 100).toFixed(2)}%;background:${seriesColor(s, si)}" title="${esc(`${s.name}: ${fmt(s.values[i], b)}`)}"></div></div>`).join('')}</div>`;
    }
    const share = b.showShare && grand > 0 ? `<span class="share">${fmt((totals[i] / grand) * 100, { decimals: 1 })}%</span>` : '';
    const value = b.stacked || b.series.length === 1 ? fmt(totals[i], b) : b.series.map((s) => fmt(s.values[i], b)).join(' / ');
    return `<div class="hb">${label}${track}<div class="hb-val">${esc(value)}${share}</div></div>`;
  });
  if (b.otherLabel) {
    rows.push(`<div class="hb other"><div class="hb-name"><b>${esc(b.otherLabel)}</b>${b.otherNote ? `<span>${esc(b.otherNote)}</span>` : ''}</div><div class="track"></div><div class="hb-val"></div></div>`);
  }
  return `<div class="hbars">${rows.join('')}</div>${legend(b.stacked ? b.series : b.series.length > 1 ? b.series : [])}`;
}

function lineChart(b: Extract<Block, { type: 'line' }>): string {
  const W = 1080, H = 280, L = 48, R = 12, T = 32, B = 34;
  const n = b.categories.length;
  const vals = [...b.series.flatMap((s) => s.values.filter((v): v is number => v != null)), ...(b.target ? [b.target.value] : [])];
  const { min, max, step } = niceRange(Math.min(...vals), Math.max(...vals));
  const pw = W - L - R, ph = H - T - B;
  const x = (i: number) => L + (n <= 1 ? pw / 2 : (i / (n - 1)) * pw);
  const y = (v: number) => T + ph - ((v - min) / (max - min)) * ph;
  const parts: string[] = [];
  for (let v = min; v <= max + 1e-9; v += step) {
    parts.push(`<line x1="${L}" x2="${W - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" class="grid"/>`,
      `<text x="${L - 6}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${esc(fmt(v, { decimals: Number.isInteger(step) ? 0 : 1 }))}</text>`);
  }
  if (b.highlight) {
    const i0 = indexOfCat(b.categories, b.highlight.from), i1 = indexOfCat(b.categories, b.highlight.to ?? b.categories[n - 1]);
    if (i0 >= 0 && i1 >= i0) {
      const half = n > 1 ? pw / (n - 1) / 2 : 20;
      const x0 = Math.max(L, x(i0) - half), x1 = Math.min(W - R, x(i1) + half);
      parts.unshift(`<rect x="${x0.toFixed(1)}" y="${T - 22}" width="${(x1 - x0).toFixed(1)}" height="${ph + 22}" class="hl"/>`,
        `<text x="${(x0 + 6).toFixed(1)}" y="${T - 8}" class="hl-label">${esc(b.highlight.label ?? 'Highlighted')}</text>`);
    }
  }
  b.series.forEach((s, si) => {
    const pts = s.values.map((v, i) => (v == null ? null : `${x(i).toFixed(1)},${y(v).toFixed(1)}`));
    const runs: string[][] = [[]];
    pts.forEach((p) => (p ? runs[runs.length - 1].push(p) : runs.push([])));
    for (const run of runs.filter((r) => r.length)) {
      if (b.area && b.series.length === 1) {
        const first = run[0].split(',')[0], last = run[run.length - 1].split(',')[0];
        parts.push(`<polygon points="${first},${y(min)} ${run.join(' ')} ${last},${y(min)}" fill="${seriesColor(s, si)}" opacity="0.15"/>`);
      }
      parts.push(`<polyline points="${run.join(' ')}" fill="none" stroke="${seriesColor(s, si)}" stroke-width="2"/>`);
    }
    if (n < 20) s.values.forEach((v, i) => { if (v != null) parts.push(`<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="3" fill="${seriesColor(s, si)}"><title>${esc(`${b.categories[i]} · ${s.name}: ${fmt(v, b)}`)}</title></circle>`); });
  });
  const every = Math.ceil(n / 12);
  b.categories.forEach((c, i) => {
    if (i % every !== 0 && i !== n - 1) return;
    const anchor = n > 1 && i === 0 ? 'start' : n > 1 && i === n - 1 ? 'end' : 'middle';
    parts.push(`<text x="${x(i).toFixed(1)}" y="${H - B + 18}" text-anchor="${anchor}">${esc(c.length > 14 ? c.slice(0, 13) + '…' : c)}</text>`);
  });
  parts.push(`<line x1="${L}" x2="${W - R}" y1="${y(min)}" y2="${y(min)}" class="axis"/>`, targetLine(b.target, y, L, W - R, b));
  return `<div class="scroll"><svg class="ch" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(b.title ?? 'Line chart')}">${parts.join('')}</svg></div>${legend(b.series)}`;
}

// ── Blocks ──────────────────────────────────────────────────────────────────────────────────────────────────────────

const STATUS_TONE: Array<[RegExp, Tone]> = [
  [/^(pass(ed)?|success(ful)?|ok|online|available|healthy|up|done|complete(d)?)$/i, 'pass'],
  [/^(fail(ed|ure)?|error|crash(ed)?|offline|down|broken|unhealthy|critical)$/i, 'fail'],
  [/^(flaky|warn(ing)?|degraded|incomplete|unstable|slow|at risk)$/i, 'warn'],
  [/^(running|in progress|queued|reserved|in use|pending|started)$/i, 'info'],
];
export function statusTone(s: string): Tone {
  return STATUS_TONE.find(([re]) => re.test(s.trim()))?.[1] ?? 'skip';
}
const pill = (s: string) => `<span class="pill ${statusTone(s)}">${esc(s)}</span>`;

function spark(values: unknown): string {
  const v = Array.isArray(values) ? values.map(Number).filter(Number.isFinite) : [];
  if (v.length < 2) return '';
  const max = Math.max(...v), min = Math.min(...v), W = 80, H = 20;
  const pts = v.map((n, i) => `${((i / (v.length - 1)) * W).toFixed(1)},${(H - 2 - ((n - min) / (max - min || 1)) * (H - 4)).toFixed(1)}`).join(' ');
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="var(--teal)" stroke-width="1.5"/></svg>`;
}

function table(b: Extract<Block, { type: 'table' }>): string {
  const limit = b.maxRows ?? 50;
  const rows = b.rows.slice(0, limit);
  const right = (f?: string) => f === 'number' || f === 'percent';
  const head = b.columns.map((c) => `<th${right(c.format) ? ' class="num"' : ''}>${esc(c.label)}</th>`).join('');
  const body = rows.map((r) => `<tr>${b.columns.map((c) => {
    const v = r[c.key];
    switch (c.format) {
      case 'number': return `<td class="num">${esc(typeof v === 'number' ? fmt(v, c) : v)}</td>`;
      case 'percent': return `<td class="num">${esc(typeof v === 'number' ? fmt(v, { ...c, unit: '%' }) : v)}</td>`;
      case 'status': return `<td>${v == null || v === '' ? '' : pill(String(v))}</td>`;
      case 'spark': return `<td>${spark(v)}</td>`;
      case 'mono': { const s = String(v ?? ''); return `<td class="mono" title="${esc(s)}">${esc(s.length > 24 ? s.slice(0, 22) + '…' : s)}</td>`; }
      default: return `<td>${esc(v)}</td>`;
    }
  }).join('')}</tr>`).join('');
  const more = b.rows.length > limit ? `<p class="caption">Showing ${limit} of ${b.rows.length.toLocaleString('en-US')} rows.</p>` : '';
  return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>${more}`;
}

function share(b: Extract<Block, { type: 'share' }>): string {
  const total = b.parts.reduce((s, p) => s + p.value, 0) || 1;
  const segs = b.parts.map((p, i) => {
    const pct = (p.value / total) * 100;
    const color = p.tone ? toneVar(p.tone) : CATEGORICAL[i % CATEGORICAL.length];
    return `<div style="width:${pct.toFixed(2)}%;background:${color}" title="${esc(`${p.label}: ${fmt(p.value, b)} (${fmt(pct, { decimals: 1 })}%)`)}">${pct >= 12 ? `${fmt(pct, { decimals: 1 })}%` : ''}</div>`;
  }).join('');
  const keys = b.parts.map((p, i) => {
    const pct = (p.value / total) * 100;
    return `<span><i style="background:${p.tone ? toneVar(p.tone) : CATEGORICAL[i % CATEGORICAL.length]}"></i>${esc(p.label)}: ${esc(fmt(p.value, b))} (${fmt(pct, { decimals: 1 })}%)</span>`;
  }).join('');
  const stat = b.value != null ? `<div class="stat"><div class="value">${esc(b.value)}</div>${b.label ? `<div class="label">${esc(b.label)}</div>` : ''}</div>` : '';
  return `${stat}<div class="stack">${segs}</div><div class="key">${keys}</div>`;
}

function compare(b: Extract<Block, { type: 'compare' }>): string {
  return b.groups.map((g) => {
    const pct = b.unit === '%' || g.rows.every((r) => /%\s*$/.test(r.display ?? ''));
    const max = (g.max ?? (pct ? 100 : Math.max(0, ...g.rows.map((r) => r.value)))) || 1;
    const color = g.tone === 'secondary' ? 'var(--teal)' : 'var(--green)';
    return `<div class="cmp"><div class="cmp-h">${esc(g.title)}</div>${g.rows.map((r) =>
      `<div class="cmp-row"><span class="tag">${esc(r.label)}</span><div class="track"><div class="seg" style="width:${((r.value / max) * 100).toFixed(2)}%;background:${color}"></div></div><b class="num">${esc(r.display ?? fmt(r.value, b))}</b></div>`).join('')}</div>`;
  }).join('');
}

function meter(b: Extract<Block, { type: 'meter' }>): string {
  const pct = b.max > 0 ? (b.value / b.max) * 100 : 0;
  const tone = b.failAt != null && pct >= b.failAt ? 'var(--status-fail)' : b.warnAt != null && pct >= b.warnAt ? 'var(--status-warn)' : 'var(--green)';
  return `<div class="meter"><div class="meter-h"><span>${esc(b.label)}</span><b class="num">${esc(b.display ?? `${fmt(b.value, b)} of ${fmt(b.max, b)}`)} (${fmt(pct, { decimals: 0 })}%)</b></div><div class="track"><div class="seg" style="width:${Math.min(100, pct).toFixed(2)}%;background:${tone}"></div></div></div>`;
}

function heatmap(b: Extract<Block, { type: 'heatmap' }>): string {
  const all = b.values.flat().filter((v): v is number => v != null);
  const min = Math.min(...all), max = Math.max(...all);
  const head = `<tr><th></th>${b.columns.map((c) => `<th class="num">${esc(c)}</th>`).join('')}</tr>`;
  const body = b.rows.map((r, ri) => `<tr><th scope="row">${esc(r)}</th>${b.columns.map((_, ci) => {
    const v = b.values[ri]?.[ci];
    if (v == null) return '<td class="hm empty"></td>';
    const t = max > min ? (v - min) / (max - min) : 0.5;
    const { bg, fg } = ramp(t);
    const worst = b.highBad && v === max && max > min ? ' worst' : '';
    return `<td class="hm${worst}" style="background:${bg};color:${fg}" title="${esc(`${r} · ${b.columns[ci]}: ${fmt(v, b)}`)}">${esc(fmt(v, b))}</td>`;
  }).join('')}</tr>`).join('');
  return `<div class="table-wrap"><table class="heat"><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
}

/** GitHub-style daily grid: one column per week (Sunday first), months labelled above. */
function calendar(b: Extract<Block, { type: 'calendar' }>): string {
  const days = b.days
    .map((d) => ({ ...d, t: Date.parse(`${d.date.slice(0, 10)}T00:00:00Z`) }))
    .filter((d) => Number.isFinite(d.t))
    .sort((a, c) => a.t - c.t);
  if (!days.length) return '';
  const DAY = 86_400_000, C = 22, G = 4, L = 34, T = 20;
  const start = days[0].t - new Date(days[0].t).getUTCDay() * DAY;
  const byT = new Map(days.map((d) => [d.t, d.value]));
  const vals = days.map((d) => d.value).filter((v): v is number => v != null);
  const min = Math.min(...vals), max = Math.max(...vals);
  const weeks = Math.floor((days[days.length - 1].t - start) / DAY / 7) + 1;
  const cells: string[] = [];
  let lastMonth = -1;
  for (let w = 0; w < weeks; w++) {
    for (let d = 0; d < 7; d++) {
      const t = start + (w * 7 + d) * DAY;
      if (t < days[0].t || t > days[days.length - 1].t) continue;
      const date = new Date(t);
      if (d === 0 || w === 0) {
        const m = date.getUTCMonth();
        if (m !== lastMonth && date.getUTCDate() <= 7) {
          cells.push(`<text x="${L + w * (C + G)}" y="${T - 6}">${date.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })}</text>`);
          lastMonth = m;
        }
      }
      const v = byT.get(t);
      const x = L + w * (C + G), y = T + d * (C + G);
      const iso = date.toISOString().slice(0, 10);
      if (v == null) { cells.push(`<rect x="${x}" y="${y}" width="${C}" height="${C}" rx="2" class="cal-empty"><title>${iso}: no data</title></rect>`); continue; }
      const { bg } = ramp(max > min ? (v - min) / (max - min) : 0.5);
      const worst = b.highBad && v === max && max > min ? ' class="cal-worst"' : '';
      cells.push(`<rect x="${x}" y="${y}" width="${C}" height="${C}" rx="2" fill="${bg}"${worst}><title>${esc(`${iso}: ${fmt(v, b)}`)}</title></rect>`);
    }
  }
  ['Mon', 'Wed', 'Fri'].forEach((n, i) => cells.push(`<text x="0" y="${T + (i * 2 + 1) * (C + G) + 15}">${n}</text>`));
  const W = L + weeks * (C + G), H = T + 7 * (C + G);
  const scale = [0, 0.5, 1].map((t) => `<i style="background:${ramp(t).bg}"></i>`).join('');
  return `<div class="scroll"><svg class="cal" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(b.title ?? 'Daily calendar')}">${cells.join('')}</svg></div>` +
    `<div class="key"><span>Less</span><span class="ramp">${scale}</span><span>More</span><span class="caption">${esc(`Range ${fmt(min, b)} to ${fmt(max, b)} per day`)}</span></div>`;
}

function tiles(b: Extract<Block, { type: 'tiles' }>): string {
  const order: Tone[] = ['fail', 'warn', 'info', 'skip', 'pass'];
  const items = [...b.items].sort((x, y) => order.indexOf(statusTone(x.status)) - order.indexOf(statusTone(y.status)));
  // One pill per STATUS, worst first. Counting per tone put every status of a tone under the first one's name
  // ("5 Offline" for 3 Offline and 2 Error; every unknown status under whichever came first).
  const counts = new Map<string, number>();
  for (const i of items) counts.set(i.status, (counts.get(i.status) ?? 0) + 1);
  const summary = [...counts].map(([s, n]) => `<span class="pill ${statusTone(s)}">${n} ${esc(s)}</span>`).join(' ');
  return `<div class="tile-summary">${summary}</div><div class="tiles">${items.map((i) =>
    `<div class="tile ${statusTone(i.status)}"><div class="tile-h"><b title="${esc(i.name)}">${esc(i.name)}</b>${i.metric ? `<span class="num">${esc(i.metric)}</span>` : ''}</div><div class="tile-s">${pill(i.status)}</div>${i.detail ? `<div class="tile-d">${esc(i.detail)}</div>` : ''}</div>`).join('')}</div>`;
}

function timeline(b: Extract<Block, { type: 'timeline' }>): string {
  return `<ol class="timeline">${b.events.map((e) =>
    `<li class="${e.tone ?? 'info'}"><span class="tl-date">${esc(e.date)}</span><div><b>${esc(e.title)}</b>${e.detail ? `<p>${rich(e.detail)}</p>` : ''}</div></li>`).join('')}</ol>`;
}

function isEmpty(b: Block): boolean {
  switch (b.type) {
    case 'bar': case 'line': return b.categories.length === 0 || b.series.every((s) => s.values.every((v) => v == null || v === 0));
    case 'table': return b.rows.length === 0;
    case 'heatmap': return b.rows.length === 0 || b.columns.length === 0;
    case 'share': return b.parts.every((p) => !p.value);
    case 'compare': return b.groups.length === 0;
    case 'kpis': return b.items.length === 0;
    case 'findings': return b.items.length === 0;
    case 'calendar': return b.days.every((d) => d.value == null);
    case 'tiles': return b.items.length === 0;
    case 'timeline': return b.events.length === 0;
    default: return false;
  }
}

function renderBlock(b: Block): string {
  const title = 'title' in b && b.title ? `<h3>${esc(b.title)}</h3>` : '';
  if (isEmpty(b) && b.type !== 'kpis' && b.type !== 'findings') {
    return `<div class="card">${title}<p class="empty-state">No data for this period.</p></div>`;
  }
  switch (b.type) {
    case 'kpis':
      return `<div class="kpi-row">${b.items.map((k) => `<div class="kpi${k.accent && k.accent !== 'green' ? ` accent-${k.accent}` : ''}"><div class="value">${esc(k.value)}</div><div class="label">${esc(k.label)}</div>${k.delta ? `<div class="delta ${k.deltaGood === false ? 'bad' : 'good'}">${esc(k.delta)}</div>` : ''}</div>`).join('')}</div>`;
    case 'callout': {
      const cls = b.tone && b.tone !== 'finding' ? ` ${b.tone}` : '';
      return `<div class="callout${cls}">${b.title ? `<strong>${esc(b.title)}</strong>` : ''}${rich(b.text)}</div>`;
    }
    case 'findings':
      return `<ul class="findings">${b.items.map((it) => { const o = typeof it === 'string' ? { text: it } : it; return `<li class="${o.tone ?? 'neutral'}">${rich(o.text)}</li>`; }).join('')}</ul>`;
    case 'text': return `<p class="prose">${rich(b.text)}</p>`;
    case 'bar': return `<div class="card">${title}${chooseOrientation(b) === 'vertical' ? verticalBars(b) : horizontalBars(b)}</div>`;
    case 'line': return `<div class="card">${title}${lineChart(b)}</div>`;
    case 'table': return `${title ? `<div class="block-title">${title}</div>` : ''}${table(b)}`;
    case 'share': return `<div class="card">${share(b)}</div>`;
    case 'compare': return `<div class="card">${compare(b)}</div>`;
    case 'meter': return `<div class="card">${meter(b)}</div>`;
    case 'heatmap': return `${title ? `<div class="block-title">${title}</div>` : ''}${heatmap(b)}`;
    case 'calendar': return `<div class="card">${title}${calendar(b)}</div>`;
    case 'tiles': return `<div class="card">${title}${tiles(b)}</div>`;
    case 'timeline': return `<div class="card">${title}${timeline(b)}</div>`;
  }
}

function renderSection(s: Section): string {
  const cols = s.columns && s.columns > 1 ? ` g${s.columns}` : '';
  const blocks = s.blocks.map(renderBlock).join('');
  const means = s.whatItMeans ? `<div class="callout means"><strong>What it means</strong>${rich(s.whatItMeans)}</div>` : '';
  return `<section><h2>${esc(s.title)}</h2><div class="grid${cols}">${blocks}</div>${means}</section>`;
}

// ── Page ────────────────────────────────────────────────────────────────────────────────────────────────────────────

const CSS = `
:root{--green:#649A3D;--green-dark:#4d7a2d;--teal:#356B63;--lime:#B9DD47;--gray-600:#232E40;--teal-dark:#274F4A;--light-green:#E1F2DA;--bright-blue:#279FEA;--dark-blue:#205AB7;--gray-100:#F2F2F4;--gray-200:#C1C5CD;--gray-300:#A4ADB6;--gray-400:#677485;--gray-500:#445267;--text:#2a2a2a;--text-body:#555555;--bg:#FFFFFF;--status-pass:#649A3D;--status-fail:#E8291A;--status-warn:#F7B731;--status-info:#279FEA;--status-skip:#A4ADB6;--border:#d8e4d0;--border-light:#eef4eb;--radius:12px;--radius-sm:6px}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Montserrat','Gotham',Arial,sans-serif;font-size:15px;line-height:1.6;color:var(--text-body);background:var(--bg);-webkit-font-smoothing:antialiased}
.container{max-width:1200px;margin:0 auto;padding:0 32px}
.mono,code{font-family:ui-monospace,'SF Mono',Menlo,Consolas,monospace;font-size:13px}
.num{font-variant-numeric:tabular-nums}
.eyebrow{display:block;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--green-dark)}
.report-header{background:var(--gray-600);background-image:radial-gradient(ellipse at 15% 50%,rgba(100,154,61,.18) 0%,transparent 60%),radial-gradient(ellipse at 85% 50%,rgba(53,107,99,.14) 0%,transparent 60%);color:#fff;padding:36px 0 32px}
.report-header .container{display:flex;flex-wrap:wrap;gap:16px 32px;align-items:flex-end;justify-content:space-between}
.report-header .eyebrow{color:var(--lime)}
.report-header h1{color:#fff;font-size:32px;font-weight:700;line-height:1.2;letter-spacing:-.5px;margin:6px 0 8px}
.report-header .sub{color:rgba(255,255,255,.85);font-size:15px}
.report-header .meta{color:rgba(255,255,255,.72);font-size:14px;margin-top:6px}
.report-header .meta strong{color:#fff;font-weight:600}
.headline{text-align:right}.headline .value{font-size:36px;font-weight:700;line-height:1.1;color:#fff}.headline .label{font-size:13px;color:rgba(255,255,255,.72)}
.tabs{display:flex;gap:4px;border-bottom:1px solid var(--gray-200);margin:28px 0 0;overflow-x:auto}
.tab{font:600 15px 'Montserrat',Arial,sans-serif;background:none;color:var(--gray-400);border:0;border-bottom:4px solid transparent;padding:10px 16px;margin-bottom:-1px;cursor:pointer;white-space:nowrap}
.tab[aria-selected="true"]{color:var(--text);border-bottom-color:var(--green)}
.tab:focus-visible{outline:2px solid var(--green-dark);outline-offset:2px}
.panel-title{display:none}
h2{font-size:24px;font-weight:700;color:var(--text);line-height:1.3;margin:40px 0 16px}
h3{font-size:18px;font-weight:600;color:var(--text);line-height:1.4;margin:0 0 12px}
section{margin-bottom:8px}
.grid{display:grid;gap:16px}.g2{grid-template-columns:repeat(auto-fit,minmax(320px,1fr))}.g3{grid-template-columns:repeat(auto-fit,minmax(240px,1fr))}
.card{background:#fff;border:1px solid var(--border);border-radius:var(--radius);padding:20px 22px;min-width:0}
.kpi-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px}
.kpi{background:#fff;border:1px solid var(--border);border-top:4px solid var(--green);border-radius:var(--radius);padding:20px 22px}
.kpi .value,.stat .value{font-size:36px;font-weight:700;color:var(--text);font-variant-numeric:tabular-nums;line-height:1.1}
.kpi .label,.stat .label{font-size:13px;font-weight:500;color:var(--gray-400);margin-top:6px}
.kpi .delta{font-size:13px;font-weight:600;margin-top:8px}.kpi .delta.good{color:var(--green-dark)}.kpi .delta.bad{color:var(--status-fail)}
.kpi.accent-teal{border-top-color:var(--teal)}.kpi.accent-fail{border-top-color:var(--status-fail)}
.stack{display:flex;height:34px;border-radius:var(--radius-sm);overflow:hidden;margin:14px 0 10px;background:var(--gray-100)}
.stack div{display:flex;align-items:center;padding-left:10px;color:#fff;font-weight:600;font-size:13px;white-space:nowrap}
.key{display:flex;gap:6px 18px;flex-wrap:wrap;font-size:13px;color:var(--gray-400);margin-top:8px}
.key i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px}
.caption{font-size:12px;color:var(--gray-400)}
.track{background:var(--gray-100);height:16px;border-radius:3px;overflow:hidden;display:flex}.track.thin{height:8px;margin:2px 0}
.seg{height:100%}
.cmp{margin-bottom:18px}.cmp:last-child{margin-bottom:0}.cmp-h{font-weight:600;color:var(--text);margin-bottom:4px}
.cmp-row{display:grid;grid-template-columns:90px 1fr 70px;gap:10px;align-items:center;margin:6px 0}.cmp-row .tag{color:var(--gray-400);font-size:13px}.cmp-row b{text-align:right;color:var(--text)}
.hbars{display:flex;flex-direction:column;gap:10px}
.hb{display:grid;grid-template-columns:minmax(120px,240px) 1fr 96px;gap:12px;align-items:center}
.hb-name{font-size:13px;line-height:1.3;min-width:0;overflow:hidden}.hb-name b{display:block;font-size:14px;color:var(--text);font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.hb-name span{color:var(--gray-400)}
.hb-val{font-weight:600;color:var(--text);text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}.hb-val .share{display:block;font-size:12px;font-weight:500;color:var(--gray-400)}
.hb.other .track{background:repeating-linear-gradient(45deg,var(--gray-100),var(--gray-100) 4px,#fff 4px,#fff 8px)}
.multi{display:flex;flex-direction:column}
.meter-h{display:flex;justify-content:space-between;gap:12px;margin-bottom:6px;color:var(--text)}
.scroll{overflow-x:auto}
.ch{width:100%;min-width:520px;height:auto;display:block}
.ch text{font-family:'Montserrat',Arial,sans-serif;font-size:12px;fill:var(--gray-400)}
.ch .val{fill:var(--text);font-weight:600;font-size:11px}
.ch .grid{stroke:var(--gray-200);stroke-opacity:.5;stroke-width:1}.ch .axis{stroke:var(--gray-200);stroke-width:1}
.ch .hl{fill:var(--light-green);opacity:.7}.ch .hl-label{fill:var(--teal);font-weight:600}
.spark{width:80px;height:20px;vertical-align:middle}
.ch .target{stroke:var(--gray-500);stroke-width:1.5;stroke-dasharray:5 4}.ch .target-label{fill:var(--gray-500);font-weight:600;font-size:11px}
.cal{display:block;max-width:100%;height:auto}.cal text{font-family:'Montserrat',Arial,sans-serif;font-size:11px;fill:var(--gray-400)}
.cal .cal-empty{fill:var(--gray-100)}.cal .cal-worst{stroke:var(--status-fail);stroke-width:2}
.ramp{display:inline-flex;gap:2px}.ramp i{width:12px;height:12px;border-radius:2px;margin:0}
.tile-summary{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px}
.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:10px}
.tile{border:1px solid var(--border);border-left:4px solid var(--status-skip);border-radius:var(--radius-sm);padding:10px 12px;min-width:0}
.tile.pass{border-left-color:var(--status-pass)}.tile.fail{border-left-color:var(--status-fail)}.tile.warn{border-left-color:var(--status-warn)}.tile.info{border-left-color:var(--status-info)}
.tile-h{display:flex;justify-content:space-between;gap:8px}.tile-h b{color:var(--text);font-size:14px;line-height:1.3;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;word-break:break-word}.tile-h span{font-size:13px;color:var(--text);font-weight:600}
.tile-s{margin:6px 0 2px}.tile-d{font-size:12px;color:var(--gray-400);line-height:1.4}
.timeline{list-style:none;position:relative;padding-left:4px}
.timeline li{display:grid;grid-template-columns:110px 1fr;gap:16px;padding:0 0 18px 22px;position:relative;color:var(--text)}
.timeline li::before{content:"";position:absolute;left:0;top:7px;width:10px;height:10px;border-radius:50%;background:var(--status-info)}
.timeline li::after{content:"";position:absolute;left:4px;top:20px;bottom:0;width:2px;background:var(--border)}.timeline li:last-child::after{display:none}
.timeline li.pass::before{background:var(--status-pass)}.timeline li.fail::before{background:var(--status-fail)}.timeline li.warn::before{background:var(--status-warn)}.timeline li.skip::before{background:var(--status-skip)}
.tl-date{font-size:13px;color:var(--gray-400);font-variant-numeric:tabular-nums}.timeline p{font-size:14px;color:var(--text-body);margin-top:2px}
.pill{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:600;line-height:1;padding:5px 10px;border-radius:100px;color:var(--text);background:var(--gray-100);white-space:nowrap}
.pill::before{content:"";width:8px;height:8px;border-radius:50%;background:var(--status-skip)}
.pill.pass{background:rgba(100,154,61,.14)}.pill.pass::before{background:var(--status-pass)}
.pill.fail{background:rgba(232,41,26,.10)}.pill.fail::before{background:var(--status-fail)}
.pill.warn{background:rgba(247,183,49,.18)}.pill.warn::before{background:var(--status-warn)}
.pill.info{background:rgba(39,159,234,.12)}.pill.info::before{background:var(--status-info)}
table{width:100%;border-collapse:collapse;font-size:14px}
thead th{background:var(--gray-100);color:var(--gray-500);font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;text-align:left;padding:10px 14px;border-bottom:2px solid var(--gray-200);position:sticky;top:0}
tbody td,tbody th{padding:10px 14px;border-bottom:1px solid var(--border-light);vertical-align:top;text-align:left}
tbody th{color:var(--text);font-weight:600}
tbody tr:nth-child(even){background:#FAFCF9}tbody tr:hover{background:var(--light-green)}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
.table-wrap{overflow-x:auto;border:1px solid var(--border);border-radius:var(--radius)}
.block-title h3{margin:0 0 10px}
table.heat td.hm{text-align:center;font-variant-numeric:tabular-nums;font-size:13px}table.heat td.worst{outline:2px solid var(--status-fail);outline-offset:-2px;font-weight:700}
table.heat tbody tr:nth-child(even),table.heat tbody tr:hover{background:none}
.callout{border-left:4px solid var(--green);background:var(--light-green);padding:16px 20px;border-radius:0 var(--radius-sm) var(--radius-sm) 0;color:var(--text)}
.callout strong:first-child{display:block;margin-bottom:4px}
.callout.means{margin-top:16px}
.callout.note{border-left-color:var(--teal);background:var(--gray-100)}
.callout.warning{border-left-color:var(--status-warn);background:#FFF8E8}
.callout.risk{border-left-color:var(--status-fail);background:#FDF0EF}
.findings{list-style:none;display:flex;flex-direction:column;gap:8px}
.findings li{position:relative;padding:12px 16px 12px 34px;background:#fff;border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text)}
.findings li::before{content:"";position:absolute;left:14px;top:20px;width:8px;height:8px;border-radius:50%;background:var(--teal)}
.findings li.good::before{background:var(--status-pass)}.findings li.bad::before{background:var(--status-fail)}
.prose{max-width:75ch}
.empty-state{color:var(--gray-400);font-style:italic}
.source{font-size:12px;color:var(--gray-400);margin-top:40px;max-width:90ch}
.report-footer{background:var(--gray-600);color:rgba(250,250,250,.6);font-size:13px;padding:28px 0;margin-top:48px}
@media (max-width:720px){.container{padding:0 16px}.hb{grid-template-columns:110px 1fr 80px}.headline{text-align:left}}
@media print{@page{size:Letter;margin:.5in}body{font-size:11pt}
.report-header,.report-footer,.kpi,.pill,thead th,.callout,.stack,.seg,.track,.hm{-webkit-print-color-adjust:exact;print-color-adjust:exact}
.kpi,.card,table,.callout,.findings li{break-inside:avoid}thead{display:table-header-group}tbody tr:hover{background:none}
.tabs{display:none}[role=tabpanel]{display:block!important}.panel-title{display:block;margin-top:24px}}
`;

const TAB_JS = `(function(){var t=document.querySelectorAll('[role=tab]');if(!t.length)return;function s(b){t.forEach(function(x){var on=x===b;x.setAttribute('aria-selected',on);x.tabIndex=on?0:-1;document.getElementById(x.getAttribute('aria-controls')).hidden=!on})}t.forEach(function(b,i){b.addEventListener('click',function(){s(b);try{history.replaceState(null,'','#'+b.getAttribute('aria-controls'))}catch(e){}});b.addEventListener('keydown',function(e){var d=e.key==='ArrowRight'?1:e.key==='ArrowLeft'?-1:0;if(d){var n=t[(i+d+t.length)%t.length];n.focus();s(n)}})});var h=location.hash.slice(1),f=null;t.forEach(function(x){if(x.getAttribute('aria-controls')===h)f=x});s(f||t[0])})();`;

function stamp(d: Date, timeZone?: string): string {
  try {
    return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone, timeZoneName: 'short' })
      .replace(/^(Jan|Feb|Aug|Oct|Nov|Dec) /, '$1. ').replace(/^Sep /, 'Sept. ');
  } catch {
    return d.toISOString();
  }
}

/**
 * Only the CSS rules this report uses. The agent saves the file by writing it out, so every byte costs output tokens
 * and time (a 25-35 KB report took about 1.5 min to save in Claude Desktop); the full sheet is 11 KB and a
 * report uses about half. A rule stays when every class in one of its selectors appears in the document; rules
 * without classes (elements, attributes) always stay. Measured on the four recipes: files 14-20% smaller.
 */
export function usedCss(css: string, html: string): string {
  const used = new Set<string>();
  for (const m of html.matchAll(/class="([^"]*)"/g)) for (const c of m[1].split(/\s+/)) if (c) used.add(c);
  const keep = (sel: string) => sel.split(',').some((part) => [...part.matchAll(/\.([A-Za-z][\w-]*)/g)].every((m) => used.has(m[1])));
  const rules = (text: string) => [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => keep(m[1].trim())).map((m) => `${m[1].trim()}{${m[2]}}`).join('');
  const out: string[] = [];
  for (const m of css.matchAll(/(@media[^{]*)\{((?:[^{}]*\{[^{}]*\})*)\s*\}|([^{}@]+)\{([^{}]*)\}/g)) {
    if (m[3] !== undefined) { if (keep(m[3].trim())) out.push(`${m[3].trim()}{${m[4]}}`); continue; }
    const inner = rules(m[2]);
    if (inner) out.push(`${m[1].trim()}{${inner}}`);
  }
  return out.join('\n');
}

/** The whole report as one HTML document. */
export function renderReport(spec: ReportSpec): string {
  const now = spec.generatedAt ?? new Date();
  const when = stamp(now, spec.timeZone);
  const meta = [...(spec.meta ?? []).map((m) => `<strong>${esc(m.label)}:</strong> ${esc(m.value)}`), `Generated ${esc(when)}`].join(' · ');
  const headline = spec.headline ? `<div class="headline"><div class="value">${esc(spec.headline.value)}</div>${spec.headline.label ? `<div class="label">${esc(spec.headline.label)}</div>` : ''}</div>` : '';
  let body: string;
  if (spec.tabs?.length) {
    const ids = spec.tabs.map((t, i) => `${slug(t.label)}-${i}`);
    const bar = `<div class="tabs" role="tablist">${spec.tabs.map((t, i) => `<button class="tab" role="tab" id="t-${ids[i]}" aria-controls="p-${ids[i]}" aria-selected="${i === 0}">${esc(t.label)}</button>`).join('')}</div>`;
    const panels = spec.tabs.map((t, i) => `<div id="p-${ids[i]}" role="tabpanel" aria-labelledby="t-${ids[i]}"><h2 class="panel-title">${esc(t.label)}</h2>${t.sections.map(renderSection).join('')}</div>`).join('');
    body = bar + panels;
  } else {
    body = (spec.sections ?? []).map(renderSection).join('');
  }
  const source = spec.source ? `<p class="source">${rich(spec.source)}</p>` : '';
  const page = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(spec.title)} | Digital.ai Testing</title>
<link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>%%CSS%%</style>
</head>
<body>
<header class="report-header"><div class="container"><div><span class="eyebrow">${esc(spec.eyebrow ?? 'Digital.ai Testing')}</span><h1>${esc(spec.title)}</h1>${spec.subtitle ? `<p class="sub">${esc(spec.subtitle)}</p>` : ''}<p class="meta">${meta}</p></div>${headline}</div></header>
<main class="container">${body}${source}</main>
<footer class="report-footer"><div class="container">© ${now.getFullYear()} Digital.ai Software, Inc. · Generated from Digital.ai Testing via MCP · ${esc(when)}</div></footer>
${spec.tabs?.length ? `<script>${TAB_JS}</script>\n` : ''}</body>
</html>
`;
  return page.replace('%%CSS%%', () => usedCss(CSS, page));
}
