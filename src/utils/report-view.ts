/**
 * The inline report view (MCP Apps): a client that supports MCP Apps (Claude Desktop) renders a finished report INSIDE the
 * conversation, with a Download button. Nothing is copied, linked or written out by the agent.
 *
 * Why: the agent of Claude Desktop works in a cloud sandbox. A file this server saves on the user's machine reaches the
 * chat only when the agent copies it out of a folder added to the conversation, or writes the whole HTML out again
 * (~1 min, ~6,000 output tokens for 20 KB). Every earlier route depended on the agent following text. A view is rendered
 * by the client itself: the report tools name a ui:// resource, the client loads it in a sandboxed frame and passes the
 * tool result to it.
 *
 * The frame has a deny-by-default content policy: only inline scripts and styles run, so the MCP Apps browser client is
 * inlined from the pinned client package (never loaded from a CDN). No package, or a client without MCP Apps → nothing
 * changes: the tools carry no view and the answers are the text they were before.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { getServerVersion } from './version.js';

/** MIME type an MCP Apps view must have (MCP Apps specification). */
export const VIEW_MIME_TYPE = 'text/html;profile=mcp-app';
/** The extension a client names in its capabilities when it renders MCP Apps views. */
export const UI_EXTENSION_ID = 'io.modelcontextprotocol/ui';
export const REPORT_VIEW_URI = 'ui://digital-ai-testing/report-view.html';
/** Key of the report's details in a tool result's _meta (read by the view; _meta is not shown to the model). */
export const REPORT_META_KEY = 'digital-ai-testing/report';

/** Every tool whose answer can be a finished report. */
export const REPORT_VIEW_TOOLS = ['render_report', 'create_report', 'create_test_summary_report', 'create_failure_analysis_report',
  'create_device_health_report', 'create_usage_summary_report'];

/* eslint-disable @typescript-eslint/no-explicit-any -- the view runs in the client's frame: its App class and DOM are not typed here */

/**
 * The view's whole program. It is serialized with toString() into the view's HTML, so it must not reference anything
 * outside its own parameters. Tests run it against a fake App and document.
 */
export function viewMain(App: any, doc: any, version: string): void {
  const $ = (id: string) => doc.getElementById(id);
  const app = new App({ name: 'Digital.ai Testing report', version });
  let shown: { fileName: string; html: string } | null = null;
  let busy = false;
  const say = (text: string) => { $('dai-msg').textContent = text; };

  const reportOf = (result: any): { fileName: string; html?: string; savedTo?: string } | null => {
    const meta = result?._meta?.['digital-ai-testing/report'];
    if (meta?.fileName) return meta;
    const text = (result?.content ?? []).filter((c: any) => c?.type === 'text').map((c: any) => c.text).join('\n');
    const found = /Report (?:ready|saved)[^\n]*?([A-Za-z0-9._-]+\.html)/.exec(text);
    return found ? { fileName: found[1] } : null;
  };

  const render = (fileName: string, html: string) => {
    const parsed = new doc.defaultView.DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('style[data-report]').forEach((s: any) => s.remove());
    parsed.querySelectorAll('style').forEach((s: any) => {
      const style = doc.createElement('style');
      style.setAttribute('data-report', '');
      style.textContent = s.textContent;
      doc.head.appendChild(style);
    });
    const scripts: string[] = [];
    parsed.querySelectorAll('script').forEach((s: any) => { scripts.push(s.textContent); s.remove(); });
    const target = $('dai-report');
    target.innerHTML = parsed.body.innerHTML;
    // A script set through innerHTML does not run (the report's tab switcher): add each one as a new element.
    for (const code of scripts) {
      const script = doc.createElement('script');
      script.textContent = code;
      target.appendChild(script);
    }
    shown = { fileName, html };
    $('dai-name').textContent = fileName;
    $('dai-bar').className = 'on';
    $('dai-dl').hidden = !app.getHostCapabilities?.()?.downloadFile;
    $('dai-full').hidden = !(app.getHostContext?.()?.availableDisplayModes ?? []).includes('fullscreen');
    say('');
  };

  const load = async (fileName: string, savedTo?: string) => {
    if (shown?.fileName === fileName) return;
    say('Loading the report…');
    try {
      const result = await app.callServerTool({ name: 'create_report', arguments: { fileName, attach: true } });
      const html = (result?.content ?? []).find((c: any) => c?.type === 'resource')?.resource?.text;
      if (!html) throw new Error(String((result?.content ?? []).find((c: any) => c?.type === 'text')?.text ?? 'the server sent no report').slice(0, 300));
      render(fileName, html);
    } catch (e: any) {
      say(`The report could not be shown here (${e?.message ?? e}).${savedTo ? ` It is saved at ${savedTo}.` : ''}`);
    }
  };

  // Handlers before connect(): the first notifications must not be missed.
  app.ontoolinput = () => { if (!shown) say('Preparing the report…'); };
  app.ontoolcancelled = () => { if (!shown) say(''); };
  app.ontoolresult = (result: any) => {
    const report = reportOf(result);
    if (!report) {
      // An estimate, a job status or an error: nothing to show. Ask the client to take the empty frame away.
      if (!shown) { say(''); try { void app.requestTeardown?.()?.catch?.(() => {}); } catch { /* not offered by this client */ } }
      return;
    }
    if (report.html) render(report.fileName, report.html);
    else void load(report.fileName, report.savedTo);
  };

  $('dai-dl').addEventListener('click', async () => {
    if (!shown || busy) return;
    busy = true;
    let status = 'Download started.';
    try {
      const res = await app.downloadFile(
        { contents: [{ type: 'resource', resource: { uri: `file:///${shown.fileName}`, mimeType: 'text/html', text: shown.html } }] },
        { timeout: 600_000 });
      if (res?.isError) status = 'The download did not finish.';
    } catch {
      status = 'The download could not be confirmed.';
    }
    busy = false;
    $('dai-status').textContent = status;
  });

  $('dai-full').addEventListener('click', async () => {
    try {
      const now = app.getHostContext?.()?.displayMode;
      const res = await app.requestDisplayMode({ mode: now === 'fullscreen' ? 'inline' : 'fullscreen' });
      $('dai-full').textContent = res?.mode === 'fullscreen' ? 'Exit full screen' : 'Full screen';
    } catch { /* the client keeps the current size */ }
  });

  Promise.resolve(app.connect()).catch((e: any) => say(`The report view could not connect to the app (${e?.message ?? e}).`));
}

/* eslint-enable @typescript-eslint/no-explicit-any */

const SHELL_CSS = 'html,body{margin:0}' +
  '#dai-bar{display:none;position:sticky;top:0;z-index:50;gap:10px;align-items:center;padding:8px 14px;background:#fff;border-bottom:1px solid #C1C5CD;font:13px Arial,Helvetica,sans-serif;color:#232E40}' +
  '#dai-bar.on{display:flex}#dai-name{font-weight:700;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}#dai-status{color:#677485}' +
  '#dai-bar button{font:inherit;font-weight:700;padding:6px 14px;border-radius:6px;border:1px solid #4d7a2d;background:#4d7a2d;color:#fff;cursor:pointer}' +
  '#dai-bar button.ghost{background:#fff;color:#4d7a2d}#dai-bar button[hidden]{display:none}' +
  '#dai-msg{padding:10px 14px;font:13px Arial,Helvetica,sans-serif;color:#677485}#dai-msg:empty{display:none}' +
  '@media print{#dai-bar{display:none!important}}';

/**
 * The MCP Apps browser client as a script that defines `__mcpApps` (its exports) instead of exporting them: a module
 * inlined in a page cannot be imported from. null when the package is missing or its shape changed.
 */
export function inlineAppsClient(source: string): string | null {
  let converted = false;
  const lib = source.replace(/export\s*\{([^{}]*)\}\s*;?\s*$/, (_all, list: string) => {
    converted = true;
    const pairs = list.split(',').map((part) => part.trim()).filter(Boolean).map((part) => {
      const [local, exported] = part.split(/\s+as\s+/);
      return `${exported ?? local}:${local}`;
    });
    return `const __mcpApps={${pairs.join(',')}};`;
  });
  if (!converted || !/[{,]App:/.test(lib)) return null;
  // The text sits inside a <script> element: neither sequence may end or re-open it.
  return lib.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');
}

let cached: { html: string | null; error?: string } | undefined;
let sourceForTests: string | null | undefined;

/** Tests: a stand-in for the browser client's source (null = the package is missing); undefined restores the real one. */
export function setAppsClientSourceForTests(source: string | null | undefined): void {
  sourceForTests = source;
  cached = undefined;
}

function appsClientSource(): string | null {
  if (sourceForTests !== undefined) return sourceForTests;
  try {
    return readFileSync(createRequire(import.meta.url).resolve('@modelcontextprotocol/ext-apps/app-with-deps'), 'utf8');
  } catch {
    return null;
  }
}

/** The view's HTML, or null when it cannot be built (then no tool names a view). Built once. */
export function reportViewHtml(): string | null {
  if (cached) return cached.html;
  const source = appsClientSource();
  const lib = source == null ? null : inlineAppsClient(source);
  if (lib == null) {
    cached = { html: null, error: source == null ? 'the MCP Apps client package is not installed' : 'the MCP Apps client package has an unexpected shape' };
    return null;
  }
  const html = '<!DOCTYPE html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    `<meta name="color-scheme" content="light"><title>Digital.ai Testing report</title><style>${SHELL_CSS}</style></head>\n<body>` +
    '<div id="dai-bar"><span id="dai-name"></span><span id="dai-status" role="status"></span>' +
    '<button id="dai-full" class="ghost" type="button" hidden>Full screen</button><button id="dai-dl" type="button" hidden>Download</button></div>' +
    '<div id="dai-msg" role="status"></div><div id="dai-report"></div>\n' +
    `<script type="module">${lib}\n(${viewMain.toString()})(__mcpApps.App, document, ${JSON.stringify(getServerVersion())});</script>\n</body></html>`;
  cached = { html };
  return html;
}

/** Why there is no view, for get_server_info; null when there is one. */
export function reportViewUnavailable(): string | null {
  if (!cached) reportViewHtml();
  return cached?.html ? null : cached?.error ?? 'not built';
}

/** _meta for a tool's definition: the report tools name the view. undefined for every other tool and when there is no view. */
export function toolUiMeta(name: string): Record<string, unknown> | undefined {
  if (!REPORT_VIEW_TOOLS.includes(name) || reportViewHtml() == null) return undefined;
  // Both spellings: `ui.resourceUri` is the specification's, the flat key is what earlier clients read.
  return { ui: { resourceUri: REPORT_VIEW_URI }, 'ui/resourceUri': REPORT_VIEW_URI };
}

// ── What this client does with the view ────────────────────────────────────────────────────────────────────────────

let uiCapability: () => boolean = () => false;
let reads = 0;
let lastReadAt = 0;

/** index.ts: whether the connected client declared MCP Apps support. */
export function setUiCapabilityProvider(fn: () => boolean): void { uiCapability = fn; }

/** True when a client's capabilities name the MCP Apps extension with the view MIME type. */
export function declaresUi(capabilities: unknown): boolean {
  const ext = (capabilities as { extensions?: Record<string, { mimeTypes?: unknown }> } | undefined)?.extensions?.[UI_EXTENSION_ID];
  return !!ext && (!Array.isArray(ext.mimeTypes) || ext.mimeTypes.includes(VIEW_MIME_TYPE));
}

/** The connected client declared MCP Apps support (it may still not render a view in every mode: see viewActive). */
export function clientDeclaresUi(): boolean {
  try { return uiCapability(); } catch { return false; }
}

/** The client read the view resource (it does so to render it). Counted for get_server_info only. */
export function noteViewRead(): void { reads++; lastReadAt = Date.now(); }

/**
 * The client shows reports inline: it declared MCP Apps. Claude Desktop renders the view in a task with tools loaded on
 * demand (verified live 2026-11-24: report drawn, tabs, Full screen, Download dialog).
 * A first version also required that the client had already fetched the view, so that a declaration alone could not claim a view
 * that is not there. But Desktop fetches the view only when the first result arrives, so the first report after every
 * server start took the old route although the view was drawn: with a report folder the agent gave the path and an
 * "add the folder" tip, and without one it wrote the whole file out again (1 min 24 s) under a report already on screen.
 * The first report of a session is the usual case, so the declaration decides; the answer keeps one line for a user who
 * says they see nothing.
 */
export function viewActive(): boolean {
  try { return reportViewHtml() != null && uiCapability(); } catch { return false; }
}

/** One line for get_server_info / check_connectivity. */
export function reportViewStatusLine(): string {
  const why = reportViewUnavailable();
  if (why) return `Inline report view: off (${why})`;
  let declared = false;
  try { declared = uiCapability(); } catch { /* not connected yet */ }
  const fetched = reads ? `view loaded ${reads} time${reads === 1 ? '' : 's'}, last ${Math.round((Date.now() - lastReadAt) / 1000)} s ago` : 'view not loaded yet';
  return `Inline report view: ${declared ? 'this client supports MCP Apps' : 'this client did not declare MCP Apps support'}; ${fetched}`;
}

export function resetReportViewForTests(): void { reads = 0; lastReadAt = 0; uiCapability = () => false; }
