/**
 * render_report — branded self-contained HTML from a compact spec. Pure renderer checks plus the tool through an
 * in-memory MCP transport (no network, files in a temp folder).
 */
import { describe, it, afterAll, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { renderReport, usedCss, chooseOrientation, fmt, dataDecimals, noEmDash, statusTone, type ReportSpec } from '../src/utils/report-render.js';
import { registerReportTools, setReportRootsProvider, setLocalClientProvider, sandboxCopyCommand, readSpec, BLOCK_FIELDS } from '../src/tools/report-tools.js';
import { reportFolderStatusLine } from '../src/utils/report-folder.js';
import { setUiCapabilityProvider, noteViewRead, resetReportViewForTests, REPORT_META_KEY } from '../src/utils/report-view.js';
import { connectTools } from './helpers/offline.js';

const weekly: ReportSpec = {
  title: 'Usage Summary',
  meta: [{ label: 'Project', value: 'demo' }],
  tabs: [
    {
      label: 'Overview',
      sections: [
        {
          title: 'Weekly Testing Hours',
          blocks: [{
            type: 'bar', stacked: true, categories: ['9/7', '9/14', '9/21', '9/28'],
            series: [{ name: 'Manual', values: [16.5, 34.2, 39.8, 11.3] }, { name: 'Automation', values: [8, 4.7, 1.3, 0.2] }],
            highlight: { from: '9/14', label: 'Last 30 days' }, partial: ['9/28'],
          }],
          whatItMeans: 'Hours dipped in the last week — the partial week explains most of it.',
        },
      ],
    },
    { label: 'Devices', sections: [{ title: 'Device Usage', blocks: [{ type: 'bar', unit: 'hrs', showShare: true, shareTotal: 200, categories: ['mn-006|iPhone 16 Pro', 'mn-021|Google Pixel 8'], series: [{ name: 'Hours', values: [40, 30] }] }], whatItMeans: 'Two phones carry a third of the hours.' }] },
  ],
  source: 'Source: test data.',
  generatedAt: new Date('2026-11-23T21:49:00Z'),
  timeZone: 'America/Los_Angeles',
};

describe('report renderer', () => {
  const html = renderReport(weekly);

  it('is one self-contained file: inline styles and script, no external script or image, font link only', () => {
    assert.match(html, /^<!DOCTYPE html>/);
    assert.match(html, /<style>[\s\S]+--green:#649A3D/);
    assert.doesNotMatch(html, /<script[^>]+src=/);
    assert.doesNotMatch(html, /<img /);
    const external = [...html.matchAll(/(?:href|src)="(https?:[^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(external, ['https://fonts.googleapis.com/css2?family=Montserrat:wght@400;500;600;700&display=swap']);
    assert.match(html, /font-family:'Montserrat','Gotham',Arial,sans-serif/, 'falls back to Arial offline');
  });

  it('draws tabs with panels, a print rule that shows every panel, and links to a tab by its id', () => {
    assert.equal((html.match(/role="tab"/g) ?? []).length, 2);
    assert.equal((html.match(/role="tabpanel"/g) ?? []).length, 2);
    assert.match(html, /@media print\{[^}]*\}?[\s\S]*\[role=tabpanel\]\{display:block!important\}/);
    assert.match(html, /location\.hash/);
  });

  it('shades the highlighted window, lightens partial periods, and says what the section means', () => {
    assert.match(html, /class="hl"/);
    assert.match(html, /class="hl-label">Last 30 days</);
    assert.match(html, /opacity="0\.45"/);
    assert.match(html, /<strong>What it means<\/strong>Hours dipped in the last week, the partial week explains most of it\./);
  });

  it('never prints an em dash, escapes agent text, and allows only **bold**', () => {
    assert.doesNotMatch(html, /—/);
    const evil = renderReport({ title: 'A — B', sections: [{ title: '<script>alert(1)</script>', blocks: [{ type: 'text', text: '**bold** <b>raw</b>' }] }] });
    assert.doesNotMatch(evil, /<script>alert/);
    assert.match(evil, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(evil, /<strong>bold<\/strong> &lt;b&gt;raw&lt;\/b&gt;/);
    assert.match(evil, /<h1>A, B<\/h1>/);
    assert.equal(noEmDash('x — y—z'), 'x, y, z');
  });

  it('shares are taken against shareTotal and labels split into name and detail', () => {
    assert.match(html, /<b>mn-006<\/b><span>iPhone 16 Pro<\/span>/);
    assert.match(html, /40 hrs<span class="share">20\.0%<\/span>/);
  });

  it('footer carries the generation year and a time zone', () => {
    assert.match(html, /© 2026 Digital\.ai Software, Inc\./);
    assert.match(html, /Nov\. 23, 2026, 1:49 PM PST/);
  });

  it('picks the orientation from the data shape', () => {
    assert.equal(chooseOrientation({ categories: ['2026-11-01', '2026-11-02'] }), 'vertical');
    assert.equal(chooseOrientation({ categories: ['Jan', 'Feb', 'Mar'] }), 'vertical');
    assert.equal(chooseOrientation({ categories: ['Android', 'iOS'] }), 'vertical');
    assert.equal(chooseOrientation({ categories: ['Samsung Galaxy S24 Plus', 'iPhone 16 Pro'] }), 'horizontal', 'long labels read better as rows');
    assert.equal(chooseOrientation({ categories: 'abcdefghij'.split('') }), 'horizontal', 'many categories');
    assert.equal(chooseOrientation({ categories: ['Samsung Galaxy S24 Plus'], orientation: 'vertical' }), 'vertical', 'explicit wins');
  });

  it('bar labels carry the precision and the unit of the data', () => {
    const bar = (values: number[], extra: Record<string, unknown> = {}) => renderReport({ title: 't', sections: [{ title: 's', blocks: [
      { type: 'bar', orientation: 'vertical', categories: ['Android', 'iOS'], series: [{ name: 'Pass rate', values }], ...extra }], whatItMeans: 'x' }] });
    const labels = (html: string) => [...html.matchAll(/class="val">([^<]*)</g)].map((m) => m[1]);
    // 91.5 and 84.2 with unit % were printed "92" and "84" beside a text that said "7.3 points".
    assert.deepEqual(labels(bar([91.5, 84.2], { unit: '%' })), ['91.5%', '84.2%']);
    assert.deepEqual(labels(bar([3, 12])), ['3', '12'], 'a whole count is not printed 3.0');
    assert.deepEqual(labels(bar([4.25, 10], { unit: 'hrs' })), ['4.25 hrs', '10.00 hrs']);
    assert.deepEqual(labels(bar([91.5, 84.2], { unit: '%', decimals: 0 })), ['92%', '84%'], 'an explicit decimals still wins');
    assert.equal(dataDecimals([1, 2.5, null, 3.125]), 2);
    assert.equal(dataDecimals([1, 2]), 0);
  });

  it('keeps the precision a number arrives with', () => {
    assert.equal(fmt(723.6, { unit: 'hrs' }), '723.6 hrs');
    assert.equal(fmt(1284), '1,284');
    assert.equal(fmt(7.6, { unit: '%' }), '7.6%');
    assert.equal(fmt(2 / 3), '0.67');
    assert.equal(fmt(null), '');
  });

  it('maps status words to tones', () => {
    assert.deepEqual(['Passed', 'Failed', 'Error', 'Flaky', 'Running', 'Skipped', 'Offline', 'Available'].map(statusTone),
      ['pass', 'fail', 'fail', 'warn', 'info', 'skip', 'fail', 'pass']);
  });

  it('draws percentages against 100 in compare blocks', () => {
    const c = renderReport({ title: 't', sections: [{ title: 's', blocks: [{ type: 'compare', groups: [{ title: 'Automation share', rows: [{ label: '90 days', value: 3, display: '3.0%' }, { label: '30 days', value: 7.6, display: '7.6%' }] }] }] }] });
    assert.match(c, /width:3\.00%/);
    assert.match(c, /width:7\.60%/);
  });

  it('renders every other block type, and an empty state instead of an empty chart', () => {
    const all = renderReport({
      title: 'All blocks', sections: [{
        title: 'Everything', columns: 2, blocks: [
          { type: 'kpis', items: [{ value: '92.4%', label: 'Pass rate', delta: '▲ 3.1 points', accent: 'teal' }] },
          { type: 'line', categories: ['Mon', 'Tue', 'Wed'], series: [{ name: 'Pass rate', values: [90, null, 95] }], target: { value: 95, label: 'Goal 95%' }, area: true },
          { type: 'meter', label: 'Device licenses', value: 92, max: 100, warnAt: 80, failAt: 95 },
          { type: 'heatmap', rows: ['Pixel 8'], columns: ['Mon', 'Tue'], values: [[1, 9]], highBad: true },
          { type: 'calendar', days: [{ date: '2026-11-01', value: 3 }, { date: '2026-11-02', value: 12 }, { date: '2026-11-03', value: null }] },
          { type: 'tiles', items: [{ name: 'Pixel 8', status: 'Available' }, { name: 'iPhone 13', status: 'Offline', detail: 'since 2 days' }] },
          { type: 'timeline', events: [{ date: 'Nov. 3', title: 'Release 4.2', tone: 'pass' }] },
          { type: 'table', columns: [{ key: 'n', label: 'Test' }, { key: 's', label: 'Status', format: 'status' }, { key: 'd', label: 'Duration', format: 'number', unit: 's' }, { key: 't', label: 'Trend', format: 'spark' }],
            rows: [{ n: 'Login', s: 'Failed', d: 42.8, t: [1, 3, 2, 5] }], maxRows: 1 },
          { type: 'callout', tone: 'risk', title: 'Risk', text: 'One device fails every run.' },
          { type: 'findings', items: ['Plain', { text: 'Good news', tone: 'good' }] },
          { type: 'bar', title: 'Nothing yet', categories: [], series: [{ name: 'x', values: [] }] },
        ],
      }],
    });
    for (const marker of ['class="kpi accent-teal"', 'class="target"', 'Goal 95%', 'class="meter"', 'var(--status-warn)', 'td class="hm worst"', 'class="cal"', 'class="tile fail"',
      'class="timeline"', 'pill fail', 'class="spark"', 'callout risk', 'findings', 'No data for this period.']) {
      assert.ok(all.includes(marker), marker);
    }
    assert.ok(all.indexOf('class="tile fail"') < all.indexOf('class="tile pass"'), 'tiles: worst first');
    const mixed = renderReport({ title: 't', sections: [{ title: 's', blocks: [{ type: 'tiles', items: [
      { name: 'a', status: 'Offline' }, { name: 'b', status: 'Error' }, { name: 'c', status: 'Offline' }, { name: 'd', status: 'Cleanup' }, { name: 'e', status: 'Unauthorized' }] }] }] });
    const summary = /<div class="tile-summary">(.*?)<\/div>/.exec(mixed)![1];
    assert.match(summary, /2 Offline/);
    assert.match(summary, /1 Error/, 'each status under its own name, not "3 Offline"');
    assert.match(summary, /1 Cleanup.*1 Unauthorized/);
  });
});

describe('CSS trimming', () => {
  it('keeps element rules and the rules of classes in use, drops the rest, inside @media too', () => {
    const css = 'body{a:1}.kpi{b:2}.heat td{c:3}.tab[aria-selected="true"]{d:4}.x,.kpi .value{e:5}@media print{.heat{f:6}.kpi{g:7}}@media (max-width:1px){.heat{h:8}}';
    const out = usedCss(css, '<div class="kpi"><span class="value">1</span></div>');
    assert.equal(out, 'body{a:1}\n.kpi{b:2}\n.x,.kpi .value{e:5}\n@media print{.kpi{g:7}}');
  });

  it('a one-section report carries far less than the whole sheet and no tab script', () => {
    const html = renderReport({ title: 'T', sections: [{ title: 'S', blocks: [{ type: 'kpis', items: [{ value: '1', label: 'L' }] }] }] });
    const css = /<style>([\s\S]*?)<\/style>/.exec(html)![1];
    assert.ok(css.includes('.kpi{'), 'used block styles stay');
    assert.ok(!css.includes('.heat') && !css.includes('.timeline') && !css.includes('.tile{'), 'unused block styles go');
    assert.ok(css.includes('.report-header{') && css.includes('@media print'), 'page chrome and print stay');
    assert.ok(!html.includes('<script>'), 'no tabs, no script');
  });
});

describe('reading a report spec: a near miss costs a note, not a second call', () => {
  const kpi = [{ value: 408, label: 'Apps' }, { value: 100, label: 'Recent' }];
  const wrap = (b: unknown) => ({ title: 'T', tabs: [{ label: 'Overview', sections: [{ title: 'At a Glance', blocks: [b] }] }] });
  const read = (b: unknown) => readSpec(wrap(b));
  const at = 'tabs.0.sections.0.blocks.0';

  it('a valid block with one key the spec does not know is drawn, and the key is named (seen in Claude Desktop 2026-11-25)', () => {
    const r = read({ type: 'kpis', items: kpi, kpis: 4 });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual(r.notes, [`${at}: left out "kpis" (not a field here; it is not in the report). A kpis block takes: items.`]);
    assert.deepEqual((r.spec.tabs![0].sections[0].blocks[0] as { items: unknown }).items, kpi);
    assert.match(renderReport(r.spec), />408</);
    const input = wrap({ type: 'kpis', items: kpi, kpis: 4 });
    readSpec(input);
    assert.equal((input.tabs[0].sections[0].blocks[0] as { kpis?: number }).kpis, 4, 'the caller\'s object is not changed');
  });

  it('a habitual field name is read as the field the block takes, and said so', () => {
    const cases: Array<[unknown, string[]]> = [
      [{ type: 'kpis', kpis: kpi }, [`${at}: read "kpis" as "items".`]],
      [{ type: 'tiles', tiles: [{ name: 'a', status: 'Available' }] }, [`${at}: read "tiles" as "items".`]],
      [{ type: 'share', segments: [{ label: 'a', value: 1 }] }, [`${at}: read "segments" as "parts".`]],
      [{ type: 'table', columns: [{ key: 'a', label: 'A' }], data: [{ a: 1 }] }, [`${at}: read "data" as "rows".`]],
      [{ type: 'bar', labels: ['a'], series: [{ name: 's', data: [1] }] }, [`${at}: read "labels" as "categories".`, `${at}.series.0: read "data" as "values".`]],
      [{ type: 'callout', body: 'x' }, [`${at}: read "body" as "text".`]],
    ];
    for (const [block, notes] of cases) {
      const r = read(block);
      assert.equal(r.ok, true, JSON.stringify(block));
      if (r.ok) { assert.deepEqual(r.notes, notes); assert.match(renderReport(r.spec), /<h1>T<\/h1>/); }
    }
    const both = read({ type: 'kpis', items: kpi, cards: [{ value: 1, label: 'other' }] });
    assert.ok(both.ok && /left out "cards"/.test(both.notes[0]), 'the field is there already: the other name is not read over it');
    const wrongKind = read({ type: 'callout', body: 42 });
    assert.equal(wrongKind.ok, false, 'a number is not a text');
  });

  it('unknown keys anywhere are left out and named; an exact spec has no note', () => {
    const r = readSpec({ title: 'T', theme: 'dark', sections: [{ title: 'S', layout: 'grid', blocks: [{ type: 'kpis', items: [{ value: 1, label: 'a', icon: 'star' }] }] }] });
    assert.equal(r.ok, true);
    if (r.ok) assert.deepEqual(r.notes.sort(), ['(spec): left out "theme" (not a field here; it is not in the report).', 'sections.0.blocks.0.items.0: left out "icon" (not a field here; it is not in the report).',
      'sections.0: left out "layout" (not a field here; it is not in the report).'].sort());
    const exact = read({ type: 'kpis', items: kpi });
    assert.ok(exact.ok && exact.notes.length === 0);
  });

  it('what leaves nothing to draw is still an error, with the fields the block takes', () => {
    const missing = read({ type: 'bar', series: [{ name: 's', values: [1] }] });
    assert.equal(missing.ok, false);
    if (!missing.ok) {
      assert.match(missing.errors[0], /blocks\.0\.categories: Invalid input: expected array/);
      assert.match(missing.errors.at(-1)!, /^A bar block takes: title, categories, series, /);
    }
    const noType = read({ kpis: kpi });
    assert.ok(!noType.ok && /blocks\.0\.type: Invalid discriminator value/.test(noType.errors[0]));
    const mixed = read({ type: 'bar', series: [{ name: 's', values: [1] }], colour: 'red' });
    assert.ok(!mixed.ok && mixed.errors.some((e) => /Unrecognized key: "colour"/.test(e)), 'with a real error, every problem is listed together');
    assert.deepEqual(Object.keys(BLOCK_FIELDS).sort(), ['bar', 'calendar', 'callout', 'compare', 'findings', 'heatmap', 'kpis', 'line', 'meter', 'share', 'table', 'text', 'tiles', 'timeline']);
    assert.deepEqual(BLOCK_FIELDS.kpis, ['items']);
  });
});

describe('render_report tool', () => {
  it('draws a near-miss spec in ONE call and lists what it read differently under "Check"', async () => {
    const tools = await connectTools(registerReportTools);
    const out = join(mkdtempSync(join(tmpdir(), 'dai-report-near-')), 'near.html');
    const spec = { title: 'Apps by Platform', sections: [{ title: 'At a Glance', blocks: [{ type: 'kpis', items: [{ value: 408, label: 'Apps' }], kpis: 4 }] },
      { title: 'By Platform', whatItMeans: 'Android leads.', blocks: [{ type: 'bar', labels: ['Android', 'iOS'], series: [{ name: 'Apps', data: [250, 158] }] }] }] };
    const r = await tools.call('render_report', { spec, outputPath: out });
    assert.notEqual(r.res.isError, true, r.text);
    assert.match(readFileSync(out, 'utf8'), /<h1>Apps by Platform<\/h1>/);
    assert.match(r.text, /\nCheck:\n- /);
    assert.match(r.text, /- sections\.0\.blocks\.0: left out "kpis" \(not a field here; it is not in the report\)\. A kpis block takes: items\./);
    assert.match(r.text, /- sections\.1\.blocks\.0: read "labels" as "categories"\./);
    assert.match(r.text, /- sections\.1\.blocks\.0\.series\.0: read "data" as "values"\./);
    rmSync(dirname(out), { recursive: true, force: true });
    await tools.close();
  });

  const dir = mkdtempSync(join(tmpdir(), 'dai-report-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('writes the file, answers briefly, and flags a data section without whatItMeans', async () => {
    const tools = await connectTools(registerReportTools);
    const out = join(dir, 'r.html');
    const spec = { title: 'Pass Rate', sections: [{ title: 'By OS', blocks: [{ type: 'bar', categories: ['Android', 'iOS'], series: [{ name: 'Pass', values: [90, 85] }] }] }] };
    const r = await tools.call('render_report', { spec, outputPath: out });
    assert.notEqual(r.res.isError, true, r.text);
    assert.ok(existsSync(out));
    assert.match(readFileSync(out, 'utf8'), /<h1>Pass Rate<\/h1>/);
    assert.match(r.text, /Report saved where the user asked: .*r\.html/);
    assert.match(r.text, /By OS: no whatItMeans/);
    assert.ok(r.text.length < 1200, 'the answer stays small — the report lives in the file');
    await tools.close();
  });

  it('names the exact field of an invalid spec, and refuses a relative or non-HTML path', async () => {
    const tools = await connectTools(registerReportTools);
    let r = await tools.call('render_report', { spec: { title: 'x', sections: [{ title: 'y', blocks: [{ type: 'bar', categories: ['a'], series: [{ name: 's', values: 'one' }] }] }] }, outputPath: join(dir, 'bad.html') });
    assert.equal(r.res.isError, true);
    assert.match(r.text, /sections\.0\.blocks\.0\.series\.0\.values: Invalid input: expected array/);
    assert.match(r.text, /A bar block takes: title, categories, series, /, 'the error says what the block takes');
    r = await tools.call('render_report', { spec: { title: 'x', sections: [{ title: 'y', blocks: [{ type: 'pie' }] }] }, outputPath: join(dir, 'bad.html') });
    assert.equal(r.res.isError, true);
    assert.match(r.text, /sections\.0\.blocks\.0\.type/);
    r = await tools.call('render_report', { spec: { title: 'x', tabs: [{ label: 't', sections: [{ title: 'y', blocks: [{ type: 'text', text: 'a' }] }] }], sections: [{ title: 'y', blocks: [{ type: 'text', text: 'a' }] }] }, outputPath: join(dir, 'b.html') });
    assert.match(r.text, /either "tabs" or "sections"/);
    r = await tools.call('render_report', { spec: { title: 'x', sections: [{ title: 'y', blocks: [{ type: 'text', text: 'a' }] }] }, outputPath: 'relative.html' });
    assert.match(r.text, /must be an absolute path/);
    r = await tools.call('render_report', { spec: { title: 'x', sections: [{ title: 'y', blocks: [{ type: 'text', text: 'a' }] }] }, outputPath: join(dir, 'r.txt') });
    assert.match(r.text, /must end in \.html/);
    await tools.close();
  });

  describe('delivery without outputPath', () => {
    type C = Array<{ type: string; text?: string; resource?: { uri: string; mimeType: string; text: string } }>;
    const spec = { title: 'Small Report', sections: [{ title: 'Note', blocks: [{ type: 'text', text: 'hello' }] }] };
    const saved: Record<string, string | undefined> = {};
    const setEnv = (vars: Record<string, string | undefined>) => {
      for (const [k, v] of Object.entries(vars)) { if (!(k in saved)) saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    };
    const call = async () => {
      const tools = await connectTools(registerReportTools);
      const r = await tools.call('render_report', { spec });
      await tools.close();
      assert.notEqual(r.res.isError, true, r.text);
      const content = r.res.content as unknown as C;
      return { text: String(content[0].text), attachment: content.find((c) => c.type === 'resource')?.resource };
    };
    beforeEach(() => { setReportRootsProvider(null); setEnv({ MCP_REPORT_DIR: undefined, MCP_DEPLOYMENT_MODE: 'local', TMP: dir, TEMP: dir, TMPDIR: dir }); });
    afterEach(() => { setReportRootsProvider(null); for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; delete saved[k]; } });

    it('local, nothing configured: a temp file to COPY; in a sandbox with no folder the agent ASKS instead of writing it out', async () => {
      const r = await call();
      const m = /It is saved at (.+?\.html) \(temporary/.exec(r.text);
      assert.ok(m, r.text);
      assert.equal(dirname(m[1]), join(dir, 'digital-ai-testing-reports'));
      assert.match(readFileSync(m[1], 'utf8'), /<h1>Small Report<\/h1>/);
      assert.match(r.text, process.platform === 'win32' ? /Copy-Item -LiteralPath ".+" -Destination "<folder>"/ : /cp ".+" "<folder>\/"/);
      assert.match(r.text, /1\. Your shell can reach that path[\s\S]*2\. If the user added a folder[\s\S]*3\. Neither .*do NOT write the report out/);
      assert.match(r.text, /Add a folder to this conversation \(Add folder\)[\s\S]*'write it here'[\s\S]*attach: true/);
      assert.equal(r.attachment, undefined, 'no HTML attached: nothing invites writing it out');
    });

    it('two different reports with one title in the same minute get two names (the second used to replace the first)', async () => {
      const tools = await connectTools(registerReportTools);
      const other = { title: 'Small Report', sections: [{ title: 'Note', blocks: [{ type: 'text', text: 'another project' }] }] };
      const names: string[] = [];
      // Up to two rounds: a minute boundary between the two calls gives different names for another reason.
      for (let round = 0; round < 2 && new Set(names.slice(-2)).size < 2; round++) {
        names.length = 0;
        for (const s of [spec, other]) names.push(/Report ready: (\S+\.html)/.exec((await tools.call('render_report', { spec: s })).text)![1]);
      }
      assert.notEqual(names[0], names[1]);
      const folder = join(dir, 'digital-ai-testing-reports');
      assert.match(readFileSync(join(folder, names[0]), 'utf8'), /hello/);
      assert.match(readFileSync(join(folder, names[1]), 'utf8'), /another project/);
      const again = /Report ready: (\S+\.html)/.exec((await tools.call('render_report', { spec: other })).text)![1];
      assert.ok(again === names[1] || !names.includes(again), 'the same report again keeps its name within the minute');
      await tools.close();
    });

    it('"write it here": create_report fileName + attach returns the report to write out', async () => {
      const tools = await connectTools(registerReportTools);
      const first = await tools.call('render_report', { spec });
      const name = /Report ready: (\S+\.html)/.exec(first.text)![1];
      const r = await tools.call('create_report', { fileName: name, attach: true });
      assert.notEqual(r.res.isError, true, r.text);
      assert.match(r.text, /attached as text\/html, as asked\. Save it UNCHANGED/);
      const res = (r.res.content as unknown as C).find((c) => c.type === 'resource')!.resource!;
      assert.match(res.text, /<h1>Small Report<\/h1>/);
      await tools.close();
    });

    it('a sandboxed agent can have the server write the delivered report into a folder the user added (fileName + outputPath)', async () => {
      const tools = await connectTools(registerReportTools);
      const first = await tools.call('render_report', { spec });
      const name = /Report ready: (\S+\.html)/.exec(first.text)![1];
      assert.match(first.text, new RegExp(`call create_report with fileName: "${name.replace(/[.]/g, '\.')}" and outputPath`));
      const shared = join(dir, 'added-folder', name);
      const r = await tools.call('create_report', { fileName: name, outputPath: shared });
      assert.notEqual(r.res.isError, true, r.text);
      assert.match(r.text, /Report saved where the user asked: .*added-folder.*\n.*NEXT STEP, before you answer: if you have an outputs folder/);
      assert.match(readFileSync(shared, 'utf8'), /<h1>Small Report<\/h1>/);
      assert.equal((r.res.content as unknown as C).some((c) => c.type === 'resource'), false, 'no attachment');
      assert.match((await tools.call('create_report', { fileName: name })).text, /fileName needs outputPath/);
      assert.match((await tools.call('create_report', { fileName: 'nope.html', outputPath: join(dir, 'x.html') })).text, /No report "nope\.html" was delivered/);
      await tools.close();
    });

    it('MCP_REPORT_DIR: saved there, the agent only names it, no attachment', async () => {
      const target = join(dir, 'configured');
      setEnv({ MCP_REPORT_DIR: target });
      const r = await call();
      assert.match(r.text, /Report saved: .*configured.*small-report-\d{8}-\d{4}\.html .* in the folder set for reports \(MCP_REPORT_DIR\)/);
      // One exact command instead of a judgment: asked whether it "can reach" a Windows path, a sandboxed agent skipped the copy.
      const name = /(small-report-\d{8}-\d{4}(?:-\d+)?\.html)/.exec(r.text)![1];
      assert.ok(r.text.includes(sandboxCopyCommand(name)), r.text);
      assert.match(sandboxCopyCommand(name), /^f=\$\(find \/ -maxdepth 8 -name "small-report-.*\.html" .*head -1\); if \[ -n "\$f" \]; then cp "\$f" \/mnt\/user-data\/outputs\/ && echo COPIED; else echo NOT-ADDED; fi$/);
      assert.match(r.text, /COPIED → give the user the link[\s\S]*NOT-ADDED → the folder is not added[\s\S]*Add folder[\s\S]*attach: true/);
      assert.match(r.text, /no sandbox\) → skip the command/);
      assert.equal(readdirSync(target).filter((n) => n.endsWith('.html')).length, 1);
      assert.equal(r.attachment, undefined);
    });

    it('the report folder set with setup (profiles.json reportDir): saved there; a sandboxed agent is told how to get a link', async () => {
      const storeDir = join(dir, 'store');
      const target = join(dir, 'setup-reports');
      mkdirSync(storeDir, { recursive: true });
      writeFileSync(join(storeDir, 'profiles.json'), JSON.stringify({ version: 1, profiles: {}, reportDir: target }));
      setEnv({ MCP_CREDENTIAL_STORE: 'on', MCP_CREDENTIAL_STORE_DIR: storeDir });
      const r = await call();
      assert.match(r.text, /Report saved: .*setup-reports.* in the report folder set with setup/);
      assert.match(r.text, /run this ONE command as it is[\s\S]*find \/ -maxdepth 8[\s\S]*NOT-ADDED[\s\S]*Add folder[\s\S]*attach: true/);
      assert.equal(readdirSync(target).filter((n) => n.endsWith('.html')).length, 1);
      assert.equal(r.attachment, undefined);
    });

    it('a client on this machine gets the path and nothing about a sandbox; get_server_info names the folder', async () => {
      const target = join(dir, 'configured-local');
      setEnv({ MCP_REPORT_DIR: target });
      assert.equal(reportFolderStatusLine(), `Report folder: ${target} (MCP_REPORT_DIR)`);
      setLocalClientProvider(() => true);
      try {
        const r = await call();
        assert.match(r.text, /Report saved: .*configured-local.* in the folder set for reports \(MCP_REPORT_DIR\)\.\nIt is already saved: do not re-create or paste it\. Tell the user the full path/);
        assert.ok(!/find \/|outputs folder|sandbox|Claude Desktop/.test(r.text), r.text);
      } finally {
        setLocalClientProvider(null);
      }
      setEnv({ MCP_REPORT_DIR: undefined });
      assert.match(reportFolderStatusLine(), /^Report folder: not set \(reports go to the folder the client shares, else a temporary file/);
    });

    it('a folder the client shares (roots): saved in its digital-ai-reports folder, no attachment', async () => {
      const ws = join(dir, 'workspace');
      mkdirSync(ws, { recursive: true });
      setReportRootsProvider(async () => [pathToFileURL(ws).href]);
      const r = await call();
      assert.match(r.text, /in the folder shared with this conversation/);
      assert.ok(!/outputs folder|Claude Desktop/.test(r.text), 'a client that shares its workspace is on this machine');
      const saved = readdirSync(join(ws, 'digital-ai-reports'));
      assert.equal(saved.filter((n) => n.endsWith('.html')).length, 1);
      assert.ok(saved.includes('.gitignore'), 'a report folder inside the project is never committed');
      assert.equal(r.attachment, undefined);
    });

    describe('a client that renders the inline view (MCP Apps)', () => {
      type Meta = { fileName: string; html?: string; savedTo?: string };
      const callWithMeta = async () => {
        const tools = await connectTools(registerReportTools);
        const r = await tools.call('render_report', { spec });
        await tools.close();
        return { text: r.text, meta: (r.res as unknown as { _meta?: Record<string, Meta> })._meta?.[REPORT_META_KEY], attachment: (r.res.content as unknown as C).find((c) => c.type === 'resource') };
      };
      afterEach(() => resetReportViewForTests());

      it('the answer says it is shown and asks the agent for nothing, from the first report on; the HTML rides in _meta', async () => {
        setUiCapabilityProvider(() => true); // the view has not been fetched yet: Claude Desktop fetches it when the first result arrives
        const r = await callWithMeta();
        assert.match(r.text, /^✅ Report ready: small-report-\d{8}-\d{4}(-\d+)?\.html \(\d+ KB\)\. It is DISPLAYED to the user right now, inline in this conversation/);
        assert.match(r.text, /Do NOT copy, save, attach, link, re-create or paste the report, and run no command for it/);
        assert.match(r.text, /Only if the user says they cannot see it: create_report fileName: "small-report-.*\.html", attach: true/);
        assert.ok(!/find \/|Copy-Item|cp "|Add a folder|outputs folder/.test(r.text), 'no copy step, no question');
        assert.match(String(r.meta?.html), /<h1>Small Report<\/h1>/);
        assert.equal(r.attachment, undefined);
      });

      it('with a report folder it also says where the file is', async () => {
        setEnv({ MCP_REPORT_DIR: join(dir, 'inline-configured') });
        setUiCapabilityProvider(() => true);
        noteViewRead();
        const r = await callWithMeta();
        assert.match(r.text, /DISPLAYED to the user[\s\S]*It is also saved at .*inline-configured.*\.html \(the folder set for reports \(MCP_REPORT_DIR\)\)\.[\s\S]*Tell the user it is shown above and where it is saved/);
        assert.match(String(r.meta?.savedTo), /inline-configured/);
        assert.equal(readdirSync(join(dir, 'inline-configured')).filter((n) => n.endsWith('.html')).length, 1);
      });

      it('no report folder and no folder added: still shown, and the agent is not told to ask or to write it out', async () => {
        setUiCapabilityProvider(() => true);
        const r = await callWithMeta();
        assert.match(r.text, /DISPLAYED to the user/);
        assert.ok(!/temporary|write it here|Add a folder|It is also saved/.test(r.text), r.text);
        assert.match(r.text, /Tell the user it is shown above, then the highlights/);
        assert.equal(readdirSync(join(dir, 'digital-ai-testing-reports')).filter((n) => n === r.meta!.fileName).length, 1, 'the temporary copy is still kept for a day');
      });

      it('a client without views gets the file name in _meta and never the HTML', async () => {
        const r = await callWithMeta();
        assert.match(String(r.meta?.fileName), /^small-report-.*\.html$/);
        assert.equal(r.meta?.html, undefined);
        assert.ok(!/DISPLAYED/.test(r.text));
      });

      it('the view of a conversation reopened after a restart gets its report from the saved file', async () => {
        const folder = join(dir, 'digital-ai-testing-reports');
        mkdirSync(folder, { recursive: true });
        writeFileSync(join(folder, 'kept-from-yesterday.html'), '<!DOCTYPE html><html><body><h1>Kept</h1></body></html>');
        const tools = await connectTools(registerReportTools);
        const r = await tools.call('create_report', { fileName: 'kept-from-yesterday.html', attach: true });
        assert.match(String((r.res.content as unknown as C).find((c) => c.type === 'resource')?.resource?.text), /<h1>Kept<\/h1>/);
        for (const bad of ['..\\..\\secrets.html', '../x.html', 'C:\\Windows\\win.html', 'notes.txt']) {
          const refused = await tools.call('create_report', { fileName: bad, attach: true });
          assert.equal(refused.res.isError, true, bad);
          assert.match(refused.text, /No report/);
        }
        await tools.close();
      });
    });

    it('Docker without MCP_REPORT_DIR: the attachment only, nothing written', async () => {
      setEnv({ MCP_DEPLOYMENT_MODE: 'docker', TMP: join(dir, 'docker-tmp'), TEMP: join(dir, 'docker-tmp'), TMPDIR: join(dir, 'docker-tmp') });
      const r = await call();
      assert.match(r.text, /Save the attached text\/html resource UNCHANGED as "small-report-\d{8}-\d{4}\.html" in the user's outputs/);
      assert.ok(r.attachment);
      assert.equal(existsSync(join(dir, 'docker-tmp')), false);
    });
  });
});
