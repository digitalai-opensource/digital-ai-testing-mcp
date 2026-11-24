/**
 * The inline report view (MCP Apps): the view's HTML, the script that runs in the client's frame (against a fake App
 * class and document), which tools name the view, and when an answer may say the report is shown inline.
 * The view was rendered live in headless Chrome with the reference host bridge under a deny-by-default content policy
 * (2026-11-24): report drawn, tabs switch, download request sent.
 */
import { describe, it, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import {
  viewMain, inlineAppsClient, reportViewHtml, reportViewUnavailable, toolUiMeta, declaresUi, viewActive, noteViewRead, setUiCapabilityProvider,
  reportViewStatusLine, setAppsClientSourceForTests, resetReportViewForTests, REPORT_VIEW_URI, REPORT_VIEW_TOOLS, VIEW_MIME_TYPE, UI_EXTENSION_ID,
} from '../src/utils/report-view.js';
import { REGISTERED_TOOLS } from '../src/tools/meta-tools.js';
import { registerReportTools } from '../src/tools/report-tools.js';
import { connectTools } from './helpers/offline.js';

afterEach(() => { setAppsClientSourceForTests(undefined); resetReportViewForTests(); });

// ── A document and an App class just large enough for the view's script ─────────────────────────────────────────────

interface FakeEl { id: string; textContent: string; className: string; hidden: boolean; innerHTML: string; children: FakeEl[]; attrs: Record<string, string>;
  listeners: Record<string, () => unknown>; addEventListener(type: string, fn: () => unknown): void; appendChild(el: FakeEl): void; setAttribute(k: string, v: string): void; remove(): void }

function fakeDocument() {
  const make = (id = ''): FakeEl => ({
    id, textContent: '', className: '', hidden: true, innerHTML: '', children: [], attrs: {}, listeners: {},
    addEventListener(type, fn) { this.listeners[type] = fn; },
    appendChild(el) { this.children.push(el); },
    setAttribute(k, v) { this.attrs[k] = v; },
    remove() { /* not tracked */ },
  });
  const els = new Map(['dai-bar', 'dai-name', 'dai-status', 'dai-full', 'dai-dl', 'dai-msg', 'dai-report'].map((id) => [id, make(id)]));
  const head = make('head');
  // The parser the view uses on the report: styles, scripts and the body, pulled out with patterns.
  class DOMParser {
    parseFromString(html: string) {
      let rest = html;
      const take = (tag: string) => {
        const found: Array<{ textContent: string; remove(): void }> = [];
        rest = rest.replace(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'g'), (_all, text: string) => { found.push({ textContent: text, remove() { /* already taken out */ } }); return ''; });
        return found;
      };
      const styles = take('style'), scripts = take('script');
      const body = /<body[^>]*>([\s\S]*)<\/body>/.exec(rest)?.[1] ?? rest;
      return { querySelectorAll: (sel: string) => (sel === 'style' ? styles : sel === 'script' ? scripts : []), body: { innerHTML: body } };
    }
  }
  return {
    els, head,
    doc: {
      getElementById: (id: string) => els.get(id), createElement: () => make(), head, querySelectorAll: () => [] as FakeEl[],
      defaultView: { DOMParser },
    },
  };
}

function fakeApp(opts: { capabilities?: Record<string, unknown>; context?: Record<string, unknown>; serverHtml?: string | null } = {}) {
  const log = { calls: [] as unknown[], downloads: [] as Array<{ contents: Array<{ resource: { uri: string; mimeType: string; text: string } }> }>, teardown: 0, connected: 0 };
  class App {
    ontoolinput?: (p: unknown) => void;
    ontoolresult?: (r: unknown) => void;
    ontoolcancelled?: () => void;
    static last: App;
    constructor(public info: { name: string; version: string }) { App.last = this; }
    async connect() { log.connected++; }
    getHostCapabilities() { return opts.capabilities ?? { downloadFile: {}, serverTools: {} }; }
    getHostContext() { return opts.context ?? { displayMode: 'inline', availableDisplayModes: ['inline', 'fullscreen'] }; }
    async callServerTool(p: unknown) {
      log.calls.push(p);
      if (opts.serverHtml === null) return { isError: true, content: [{ type: 'text', text: 'No report "x.html" was delivered' }] };
      return { content: [{ type: 'text', text: 'attached' }, { type: 'resource', resource: { uri: 'report:///x', mimeType: 'text/html', text: opts.serverHtml ?? REPORT } }] };
    }
    async downloadFile(p: (typeof log.downloads)[number]) { log.downloads.push(p); return {}; }
    async requestTeardown() { log.teardown++; }
    async requestDisplayMode(p: { mode: string }) { return p; }
  }
  return { App, log };
}

const REPORT = '<!DOCTYPE html><html><head><style>h1{color:green}</style></head><body><h1>Weekly</h1><script>window.tabs=1</script></body></html>';
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('the view script', () => {
  it('draws the report a result carries, with its styles and scripts, and offers the download', async () => {
    const { doc, els, head } = fakeDocument();
    const { App, log } = fakeApp();
    viewMain(App, doc, '9.9.9');
    assert.equal(App.last.info.version, '9.9.9');
    assert.equal(log.connected, 1);
    App.last.ontoolinput!({});
    assert.equal(els.get('dai-msg')!.textContent, 'Preparing the report…');
    App.last.ontoolresult!({ content: [{ type: 'text', text: 'x' }], _meta: { 'digital-ai-testing/report': { fileName: 'weekly.html', html: REPORT } } });
    assert.equal(log.calls.length, 0, 'the HTML came with the result: no call back to the server');
    assert.equal(els.get('dai-report')!.innerHTML, '<h1>Weekly</h1>');
    assert.equal(head.children[0].textContent, 'h1{color:green}');
    assert.equal(els.get('dai-report')!.children[0].textContent, 'window.tabs=1', 'the report script is added again so that it runs');
    assert.equal(els.get('dai-name')!.textContent, 'weekly.html');
    assert.equal(els.get('dai-bar')!.className, 'on');
    assert.equal(els.get('dai-dl')!.hidden, false);
    assert.equal(els.get('dai-full')!.hidden, false);
    assert.equal(els.get('dai-msg')!.textContent, '');

    await els.get('dai-dl')!.listeners.click();
    assert.equal(log.downloads[0].contents[0].resource.uri, 'file:///weekly.html');
    assert.equal(log.downloads[0].contents[0].resource.mimeType, 'text/html');
    assert.equal(log.downloads[0].contents[0].resource.text, REPORT);
    assert.equal(els.get('dai-status')!.textContent, 'Download started.');
  });

  it('with only a file name (in _meta or in the text) it asks the server for the HTML', async () => {
    for (const result of [
      { content: [], _meta: { 'digital-ai-testing/report': { fileName: 'weekly-20261124-1058.html' } } },
      { content: [{ type: 'text', text: '✅ Report saved: C:\\Users\\Someone\\MCP Reports\\weekly-20261124-1058.html (20 KB, one self-contained HTML file), in the report folder.' }] },
      { content: [{ type: 'text', text: '✅ Report ready: weekly-20261124-1058.html (20 KB).' }] },
    ]) {
      const { doc, els } = fakeDocument();
      const { App, log } = fakeApp();
      viewMain(App, doc, '1');
      App.last.ontoolresult!(result);
      await tick();
      assert.deepEqual(log.calls, [{ name: 'create_report', arguments: { fileName: 'weekly-20261124-1058.html', attach: true } }]);
      assert.equal(els.get('dai-report')!.innerHTML, '<h1>Weekly</h1>');
    }
  });

  it('a report the server no longer has: says so and names where it was saved', async () => {
    const { doc, els } = fakeDocument();
    const { App } = fakeApp({ serverHtml: null });
    viewMain(App, doc, '1');
    App.last.ontoolresult!({ content: [], _meta: { 'digital-ai-testing/report': { fileName: 'x.html', savedTo: 'C:\\Reports\\x.html' } } });
    await tick();
    assert.match(els.get('dai-msg')!.textContent, /could not be shown here \(No report "x\.html" was delivered\)\. It is saved at C:\\Reports\\x\.html\./);
    assert.equal(els.get('dai-bar')!.className, '');
  });

  it('an answer without a report (an estimate, a job status, an error) shows nothing and asks the client to remove the frame', () => {
    const { doc, els } = fakeDocument();
    const { App, log } = fakeApp();
    viewMain(App, doc, '1');
    App.last.ontoolinput!({});
    App.last.ontoolresult!({ content: [{ type: 'text', text: 'This report will take about 80 s. Run it in the background?' }] });
    assert.equal(els.get('dai-msg')!.textContent, '');
    assert.equal(els.get('dai-report')!.innerHTML, '');
    assert.equal(log.teardown, 1);
  });

  it('no download where the client does not offer it', () => {
    const { doc, els } = fakeDocument();
    const { App } = fakeApp({ capabilities: {}, context: { displayMode: 'inline', availableDisplayModes: ['inline'] } });
    viewMain(App, doc, '1');
    App.last.ontoolresult!({ content: [], _meta: { 'digital-ai-testing/report': { fileName: 'a.html', html: REPORT } } });
    assert.equal(els.get('dai-dl')!.hidden, true);
    assert.equal(els.get('dai-full')!.hidden, true);
  });
});

describe('the view HTML', () => {
  it('turns the browser client module into a script that defines its exports', () => {
    const lib = inlineAppsClient('var a=1,b=class{};const t="</script><!--";export{a as VERSION,b as App};\n');
    assert.ok(lib);
    assert.match(lib, /const __mcpApps=\{VERSION:a,App:b\};$/);
    assert.ok(!/<\/script/i.test(lib) && !lib.includes('<!--'), 'nothing in it can end or re-open the script element');
    assert.equal(inlineAppsClient('var a=1;'), null, 'no export clause: not the file we know');
    assert.equal(inlineAppsClient('var a=1;export{a as Other};'), null, 'no App export');
  });

  it('is one page with the pinned client inlined: one script, nothing loaded from the network', () => {
    const html = reportViewHtml();
    assert.ok(html, reportViewUnavailable() ?? '');
    assert.equal((html.match(/<script/g) ?? []).length, 1);
    assert.equal((html.match(/<\/script>/g) ?? []).length, 1);
    assert.ok(!/<script[^>]+src=|<link|@import|https?:\/\/unpkg|https?:\/\/cdn/i.test(html.slice(0, 2000) + html.slice(-6000)), 'no external script, style or font');
    assert.match(html, /const __mcpApps=\{/);
    assert.match(html, /\(function viewMain\([\s\S]+\)\(__mcpApps\.App, document, "\d+\.\d+\.\d+[^"]*"\);<\/script>/);
    for (const id of ['dai-bar', 'dai-name', 'dai-status', 'dai-full', 'dai-dl', 'dai-msg', 'dai-report']) assert.ok(html.includes(`id="${id}"`), id);
    assert.equal(reportViewUnavailable(), null);
  });

  it('without the client package there is no view: no tool names one and the status line says why', () => {
    setAppsClientSourceForTests(null);
    assert.equal(reportViewHtml(), null);
    assert.equal(toolUiMeta('create_report'), undefined);
    assert.match(reportViewStatusLine(), /^Inline report view: off \(the MCP Apps client package is not installed\)/);
    setAppsClientSourceForTests('var x=1;');
    assert.match(reportViewStatusLine(), /off \(the MCP Apps client package has an unexpected shape\)/);
  });
});

describe('which tools and which clients', () => {
  it('every report tool names the view, in both spellings, and no other tool does', () => {
    for (const name of REPORT_VIEW_TOOLS) {
      assert.ok((REGISTERED_TOOLS as readonly string[]).includes(name), `${name} is a registered tool`);
      assert.deepEqual(toolUiMeta(name), { ui: { resourceUri: REPORT_VIEW_URI }, 'ui/resourceUri': REPORT_VIEW_URI });
    }
    for (const name of REGISTERED_TOOLS.filter((n) => !REPORT_VIEW_TOOLS.includes(n))) assert.equal(toolUiMeta(name), undefined, name);
  });

  it('a client supports views when its capabilities name the extension with the view MIME type', () => {
    assert.equal(declaresUi({ extensions: { [UI_EXTENSION_ID]: { mimeTypes: [VIEW_MIME_TYPE] } } }), true);
    assert.equal(declaresUi({ extensions: { [UI_EXTENSION_ID]: {} } }), true);
    assert.equal(declaresUi({ extensions: { [UI_EXTENSION_ID]: { mimeTypes: ['text/plain'] } } }), false);
    assert.equal(declaresUi({ roots: {} }), false);
    assert.equal(declaresUi(undefined), false);
  });

  it('an answer says "shown inline" for a client that declared views, from its first report on', () => {
    assert.equal(viewActive(), false);
    setUiCapabilityProvider(() => true);
    // Claude Desktop fetches the view only when the first result arrives: waiting for that fetch sent every first report
    // of a server run down the old route (the agent wrote the file out under a report already on screen).
    assert.equal(viewActive(), true, 'declared is enough: the view need not have been fetched yet');
    assert.match(reportViewStatusLine(), /this client supports MCP Apps; view not loaded yet/);
    noteViewRead();
    assert.equal(viewActive(), true);
    assert.match(reportViewStatusLine(), /this client supports MCP Apps; view loaded 1 time, last \d+ s ago/);
    setUiCapabilityProvider(() => false);
    assert.equal(viewActive(), false, 'a fetch by a client that did not declare views changes nothing');
    assert.match(reportViewStatusLine(), /did not declare MCP Apps support/);
    setUiCapabilityProvider(() => { throw new Error('not connected'); });
    assert.equal(viewActive(), false);
  });

  it('the view is a resource with the MCP Apps MIME type, and reading it is counted', async () => {
    const tools = await connectTools(registerReportTools);
    const listed = (await tools.client.listResources()).resources.find((r) => r.uri === REPORT_VIEW_URI);
    assert.equal(listed?.mimeType, VIEW_MIME_TYPE);
    assert.match(reportViewStatusLine(), /view not loaded yet/);
    const read = await tools.client.readResource({ uri: REPORT_VIEW_URI });
    assert.equal(read.contents[0].mimeType, VIEW_MIME_TYPE);
    assert.match(String((read.contents[0] as { text?: string }).text), /^<!DOCTYPE html>/);
    assert.match(reportViewStatusLine(), /view loaded 1 time/);
    await tools.close();
  });
});
