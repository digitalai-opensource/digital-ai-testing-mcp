import { z } from 'zod';
import { canonicalBrowserName } from '../utils/browser-name.js';
import { respond, outputFormatParam } from '../utils/output-format.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  quitInspectionSession,
  findElements,
  requireSession,
  getPendingReportIds,
  deleteAllTrackedReports,
  listActiveSessions,
} from '../api/webdriver.js';
import {
  createBrowserInspectionSession,
  navigateTo,
  getCurrentUrl,
  getPageDom,
  browserNavigate,
} from '../api/browser-inspection.js';
import { readBrowserEvents } from '../api/browser-events.js';
import { checkDestructiveGuard } from '../utils/destructive-guard.js';
import { checkDeleteAllowed } from '../api/access-level.js';

function browserSessionSummary(s: ReturnType<typeof requireSession>): string {
  const age = Math.round((Date.now() - s.startedAt) / 1000);
  const idle = Math.round((Date.now() - s.lastUsedAt) / 1000);
  const idleWarning = idle > 180 ? ' ⚠️ likely expired (Grid idle timeout ~4 min)' : '';
  return (
    `Handle:   ${s.handle}\n` +
    `Browser:  ${s.browserName ?? s.deviceName}\n` +
    `URL:      ${s.currentUrl || '(no navigation yet)'}\n` +
    `Age:      ${age}s | Idle: ${idle}s${idleWarning}\n`
  );
}

export function registerWebInspectionTools(server: McpServer): void {

  // ── start_browser_inspection_session ──────────────────────────────────────
  server.tool(
    'start_browser_inspection_session',
    'Reserve a browser from the Digital.ai Selenium Grid for interactive web test creation. ' +
    'An AI agent drives this session, captures screenshots, discovers element selectors from the live DOM ' +
    '(including React/Angular/Vue shadow DOM), and builds verified Selenium test scripts. ' +
    '\n\nIMPORTANT: If inspectionBrowser is omitted, call list_available_browsers first and ask the user ' +
    'which browser to use — do not default silently. The browser chosen is the inspection vehicle only; ' +
    'the generated test will be platform-neutral (browser-neutral RemoteWebDriver) unless the user ' +
    'explicitly requests browser-specific code.\n\n' +
    'There is no live view URL for desktop browser sessions (unlike mobile sessions). ' +
    'Use take_inspection_screenshot to relay the current state to the user at each checkpoint. ' +
    'Mobile web: set mobilePlatform ("android" → Chrome on a cloud phone, "ios" → Safari) to inspect a site as phones ' +
    'render it; every browser tool (navigate_to, get_page_dom, find_web_elements, tap/type) works the same. ' +
    'Always call stop_browser_inspection_session when done.',
    {
      inspectionBrowser: z
        .string()
        .optional()
        .describe(
          "Browser to open for this inspection session: 'chrome', 'firefox', 'MicrosoftEdge', 'safari' or 'opera' (names as list_available_browsers returns them; case variants and 'edge' are normalised). " +
          "If omitted, call list_available_browsers and ask the user to choose. " +
          "This is the session browser for element discovery — the generated test is browser-neutral."
        ),
      os: z
        .string()
        .optional()
        .describe("Operating system filter, e.g. 'Windows 10', 'macOS'. Optional."),
      url: z
        .string()
        .optional()
        .describe('URL to navigate to immediately after the session opens. Optional.'),
      reportName: z
        .string()
        .optional()
        .describe("Name shown in the Digital.ai reporter for this session. Default: '[MCP Browser Inspection] <browser>'."),
      acceptInsecureCerts: z
        .boolean()
        .optional()
        .describe(
          'Load sites whose TLS certificate is self-signed, expired or from an untrusted CA (typical for staging/dev ' +
          'environments). Without it Chrome/Edge/Safari show a privacy-warning page and Firefox refuses the navigation ' +
          '("insecure certificate"). Set it only when the user is testing such a site. Pass the same option to ' +
          'get_web_test_boilerplate so the generated test can reach it too.'
        ),
      captureBrowserLog: z
        .boolean()
        .optional()
        .describe(
          'Capture console messages, uncaught JavaScript errors and failed network requests (4xx/5xx, fetch errors) for ' +
          'get_browser_log. Default true on chrome, MicrosoftEdge, firefox and opera (WebDriver BiDi); not available on ' +
          'safari or mobile browsers. Set false only if the user asks for a plain session.'
        ),
      mobilePlatform: z
        .enum(['android', 'ios'])
        .optional()
        .describe(
          'Open the browser on a cloud phone instead of a desktop: "android" = Chrome, "ios" = Safari (inspectionBrowser ' +
          'is then not needed). Allocating a phone takes about 25–55 s. Works on Appium Server and Appium Grid projects. ' +
          'iOS Safari ignores acceptInsecureCerts (verified on real iPhones and a simulator).'
        ),
      deviceQuery: z
        .string()
        .optional()
        .describe('mobilePlatform only: XPath device query, e.g. "@os=\'android\' and @model=\'Pixel 7\'". Default: any phone of that platform.'),
      region: z
        .string()
        .optional()
        .describe('mobilePlatform only: restrict to a region, e.g. "US2" (from find_available_device).'),
      outputFormat: outputFormatParam,
    },
    async (args) => {
      if ((args.deviceQuery || args.region) && !args.mobilePlatform) {
        return { content: [{ type: 'text' as const, text: 'Error: deviceQuery and region apply to mobile browsers only — set mobilePlatform ("android" or "ios").' }], isError: true };
      }
      if (!args.inspectionBrowser && !args.mobilePlatform) {
        return {
          content: [{
            type: 'text' as const,
            text:
              'No browser specified. Please call list_available_browsers to see the available options, ' +
              'then call start_browser_inspection_session again with inspectionBrowser set.\n\n' +
              'Note: The inspection browser is only used for element discovery during this session. ' +
              'The generated test script will be browser-neutral (runs on any browser via a config setting).',
          }],
        };
      }
      try {
        const mobile = args.mobilePlatform ? { platform: args.mobilePlatform, deviceQuery: args.deviceQuery, region: args.region } : undefined;
        const expected = args.mobilePlatform === 'ios' ? 'safari' : 'chrome';
        if (mobile && args.inspectionBrowser && canonicalBrowserName(args.inspectionBrowser) !== expected) {
          return { content: [{ type: 'text' as const, text: `Error: on ${args.mobilePlatform} the browser is ${expected} — omit inspectionBrowser or set it to "${expected}".` }], isError: true };
        }
        const session = await createBrowserInspectionSession({
          browserName: mobile ? expected : canonicalBrowserName(args.inspectionBrowser!) ?? args.inspectionBrowser!,
          os: args.os,
          reportName: args.reportName,
          acceptInsecureCerts: args.acceptInsecureCerts,
          captureEvents: args.captureBrowserLog,
          mobile,
        });

        // Structured like start_inspection_session — the handle is what every later call needs (UAT 2026-10-10 run 3).
        const structured: Record<string, unknown> = {
          handle: session.handle,
          browserName: session.browserName ?? args.inspectionBrowser,
          browserVersion: session.deviceVersion || null,
          reportUrl: session.reportUrl || null,
          browserLog: session.browserEvents ?? 'off',
          ...(session.mobileOs ? {
            device: { name: session.deviceName, model: session.deviceModel || null, os: session.deviceOs, osVersion: session.deviceVersion || null, serialNumber: session.deviceUDID || null },
            mobileStudioUrl: session.cloudViewLink,
            protocol: session.sessionFormat,
          } : {}),
          ...(session.mobileOs === 'ios' && args.acceptInsecureCerts ? { warning: 'iOS Safari ignores acceptInsecureCerts — a self-signed site will still show "This Connection Is Not Private".' } : {}),
          sessionNote: session.mobileOs
            ? 'Mobile browser session — mobileStudioUrl shows the phone live; take_inspection_screenshot relays the page.'
            : 'No live view URL for browser sessions — use take_inspection_screenshot to relay the page state. ' +
              'The inspection browser is for element discovery only; the generated test is browser-neutral.',
          next: `stop_browser_inspection_session("${session.handle}") when done`,
        };
        const lines = [
          `✅ ${session.mobileOs ? 'Mobile browser' : 'Browser'} inspection session started.`,
          `Handle:       ${session.handle}`,
          `Browser:      ${session.browserName ?? args.inspectionBrowser}`,
          ...(session.mobileOs
            ? [`Device:       ${session.deviceName}${session.deviceModel ? ` (${session.deviceModel})` : ''}, ${session.deviceOs} ${session.deviceVersion}`,
              ...(session.cloudViewLink ? [`Live view:    ${session.cloudViewLink}`] : [])]
            : [`Version:      ${session.deviceVersion || '(unknown)'}`]),
          ...(session.mobileOs === 'ios' && args.acceptInsecureCerts ? [`⚠️ iOS Safari ignores acceptInsecureCerts — a self-signed site still shows its warning page.`] : []),
          `Report URL:   ${session.reportUrl || '(not available)'}`,
          `Browser log:  ${session.browserEvents === 'on' ? 'capturing console messages, JS errors and failed requests — read with get_browser_log' : session.browserEvents ?? 'off'}`,
          ``,
          ...(session.mobileOs
            ? [`SESSION NOTE: Use take_inspection_screenshot (or the live view) to relay the page state at each step.`]
            : [`SESSION NOTE: No live view URL for browser sessions (unlike mobile sessions).`,
              `Use take_inspection_screenshot to relay the page state at each step.`,
              `The inspection browser is for element discovery only — the generated test will be browser-neutral.`]),
        ];

        if (args.url) {
          try {
            await navigateTo(session.handle, args.url);
            lines.push(``, `Navigated to: ${session.currentUrl || args.url}`);
            structured.currentUrl = session.currentUrl || args.url;
          } catch (navErr) {
            lines.push(``, `⚠️  Initial navigation to "${args.url}" failed: ${(navErr as Error).message}. Session is still open.`);
            structured.navigationError = (navErr as Error).message;
          }
        }

        lines.push(``, `When done, call stop_browser_inspection_session("${session.handle}").`);

        return respond(args.outputFormat, structured, lines.join('\n'));
      } catch (e) {
        return {
          content: [{ type: 'text' as const, text: `Error starting browser session: ${(e as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  // ── stop_browser_inspection_session ───────────────────────────────────────
  server.tool(
    'stop_browser_inspection_session',
    'Close a browser inspection session and (by default) delete its probe report from the Digital.ai reporter. ' +
    'Always call this when done — open sessions hold a Grid browser slot. ' +
    'Pass keepReport: true to preserve the session video for later download via download_test_attachments.',
    {
      handle: z.string().describe('Session handle from start_browser_inspection_session.'),
      keepReport: z
        .boolean()
        .optional()
        .default(false)
        .describe('Preserve the session report (and recorded video) instead of deleting it. Default false.'),
    },
    async (args) => {
      try {
        const { reportDeleted, reportKept, canDeleteReport, reportTestId, reportUrl } =
          await quitInspectionSession(args.handle, args.keepReport ?? false);

        const lines = ['✅ Browser inspection session closed.'];
        if (reportDeleted) {
          lines.push(`Probe report deleted (ID: ${reportTestId}).`);
        } else if (reportKept) {
          lines.push(
            `Report preserved (ID: ${reportTestId}).`,
            `Report URL: ${reportUrl}`,
            `Use download_test_attachments(${reportTestId}) to retrieve the recorded session video.`
          );
        } else if (!canDeleteReport) {
          lines.push(
            `Note: Report (ID: ${reportTestId}) was kept — this project's allowUsersDeleteTests setting is off, so a project-level role cannot delete reporter records (a Cloud Admin can enable it).`,
            `Report URL: ${reportUrl}`
          );
        }
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (e) {
        return {
          content: [{ type: 'text' as const, text: `Error stopping browser session: ${(e as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  // ── navigate_to ───────────────────────────────────────────────────────────
  server.tool(
    'navigate_to',
    'Navigate a browser inspection session to a URL. Waits for the page to reach readyState "complete" ' +
    '(up to 30 seconds). Call take_inspection_screenshot after navigating to verify the page loaded correctly.',
    {
      handle: z.string().describe('Session handle from start_browser_inspection_session.'),
      url: z.string().describe('URL to navigate to, e.g. "https://example.com/login".'),
    },
    async (args) => {
      try {
        const session = requireSession(args.handle);
        if (session.platform !== 'web') {
          return {
            content: [{
              type: 'text' as const,
              text: '"navigate_to" is for browser sessions only. Use launch_app for mobile sessions.',
            }],
            isError: true,
          };
        }
        await navigateTo(args.handle, args.url);
        const current = session.currentUrl || args.url;
        return {
          content: [{
            type: 'text' as const,
            text: `✅ Navigated to: ${current}\nCall take_inspection_screenshot to verify the page loaded as expected.`,
          }],
        };
      } catch (e) {
        return {
          content: [{ type: 'text' as const, text: `Error navigating: ${(e as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  // ── get_page_dom ──────────────────────────────────────────────────────────
  server.tool(
    'get_page_dom',
    'Extract the interactive elements from the current browser page, including React/Angular/Vue components ' +
    'that render via Shadow DOM. Returns element tags, IDs, names, data-testid attributes, aria-labels, ' +
    'roles, text, and hrefs — the attributes needed to build CSS/XPath selectors for Selenium tests.\n\n' +
    'By default the interactive elements are extracted on every page; when shadow roots are detected the walker also ' +
    'descends into them (up to 3 levels deep) and hasShadowDom is true. Set shadowMode to "never" to get only the ' +
    'rendered HTML instead (fastest).\n\n' +
    'Use find_web_elements to locate and verify specific elements before adding them to the test script.',
    {
      handle: z.string().describe('Session handle from start_browser_inspection_session.'),
      shadowMode: z
        .enum(['auto', 'always', 'never'])
        .optional()
        .default('auto')
        .describe(
          '"auto" (default) and "always": extract the interactive elements, descending into shadow roots when present. ' +
          '"never": return only the rendered HTML (no element list; fastest).'
        ),
      includeRawHtml: z
        .boolean()
        .optional()
        .default(false)
        .describe('Also include the full rendered HTML. Default false (structured elements only).'),
      outputFormat: z
        .enum(['human', 'json'])
        .optional()
        .default('human')
        .describe('"human" (default): readable element list. "json": { url, title, hasShadowDom, elements, rawHtml? } for tool chaining.'),
    },
    async (args) => {
      try {
        const session = requireSession(args.handle);
        if (session.platform !== 'web') {
          return {
            content: [{
              type: 'text' as const,
              text: '"get_page_dom" is for browser sessions only. Use get_element_tree for mobile sessions.',
            }],
            isError: true,
          };
        }
        const result = await getPageDom(
          args.handle,
          (args.shadowMode ?? 'auto') as 'auto' | 'always' | 'never',
          args.includeRawHtml ?? false
        );
        const rawHtmlForJson = result.rawHtml && result.rawHtml.length > 50_000 ? `${result.rawHtml.slice(0, 50_000)}…` : result.rawHtml;
        const structured = {
          url: result.url, title: result.title, hasShadowDom: result.hasShadowDom,
          elementCount: result.elements?.length ?? 0, elements: result.elements ?? [],
          ...(rawHtmlForJson ? { rawHtml: rawHtmlForJson, rawHtmlLength: result.rawHtml!.length } : {}),
        };

        const lines: string[] = [
          `URL:          ${result.url}`,
          `Title:        ${result.title}`,
          `Shadow DOM:   ${result.hasShadowDom ? 'detected — shadow walker used' : 'none detected — standard DOM'}`,
          ``,
        ];

        if (result.elements && result.elements.length > 0) {
          lines.push(`Interactive elements (${result.elements.length} found):`);
          for (const el of result.elements) {
            const attrs: string[] = [`<${el.tag}`];
            if (el.id) attrs.push(`id="${el.id}"`);
            if (el.name) attrs.push(`name="${el.name}"`);
            if (el.type) attrs.push(`type="${el.type}"`);
            if (el.dataTestId) attrs.push(`data-testid="${el.dataTestId}"`);
            if (el.ariaLabel) attrs.push(`aria-label="${el.ariaLabel}"`);
            if (el.role) attrs.push(`role="${el.role}"`);
            if (el.placeholder) attrs.push(`placeholder="${el.placeholder}"`);
            if (el.text) attrs.push(`text="${el.text}"`);
            if (el.href) attrs.push(`href="${el.href}"`);
            const shadowMarker = el.shadowChildren && el.shadowChildren.length > 0
              ? ` [${el.shadowChildren.length} shadow children]`
              : '';
            lines.push(`  ${attrs.join(' ')}>${shadowMarker}`);
          }
        } else if (!result.rawHtml) {
          lines.push('No interactive elements found. The page may still be loading — try take_inspection_screenshot to check.');
        }
        // Raw HTML is printed whenever it was requested or is the only content (shadowMode "never") — never just
        // announced by length with nothing to read.
        if (result.rawHtml) {
          lines.push(``, `--- RAW HTML (${result.rawHtml.length} chars) ---`, result.rawHtml.slice(0, 50_000));
          if (result.rawHtml.length > 50_000) {
            lines.push(`... (truncated, ${result.rawHtml.length} total chars)`);
          }
        }

        // This tool defaults to 'human' (unlike outputFormatParam) — the UAT suite and existing callers rely on it.
        return respond(args.outputFormat ?? 'human', structured, lines.join('\n'));
      } catch (e) {
        return {
          content: [{ type: 'text' as const, text: `Error extracting page DOM: ${(e as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  // ── browser_action ────────────────────────────────────────────────────────
  server.tool(
    'browser_action',
    'Perform a browser navigation action or retrieve the current URL. ' +
    'Actions: "back" (navigate back), "forward" (navigate forward), "refresh" (reload the page), ' +
    '"get_current_url" (return the current page URL without navigating).',
    {
      handle: z.string().describe('Session handle from start_browser_inspection_session.'),
      action: z
        .enum(['back', 'forward', 'refresh', 'get_current_url'])
        .describe('Browser action to perform.'),
    },
    async (args) => {
      try {
        const session = requireSession(args.handle);
        if (session.platform !== 'web') {
          return {
            content: [{
              type: 'text' as const,
              text: '"browser_action" is for browser sessions only. Use press_back or app_control for mobile sessions.',
            }],
            isError: true,
          };
        }

        if (args.action === 'get_current_url') {
          const url = await getCurrentUrl(args.handle);
          return { content: [{ type: 'text' as const, text: `Current URL: ${url}` }] };
        }

        await browserNavigate(args.handle, args.action as 'back' | 'forward' | 'refresh');
        const url = session.currentUrl || '(unknown)';
        return {
          content: [{
            type: 'text' as const,
            text: `✅ browser_action "${args.action}" completed.\nCurrent URL: ${url}\nCall take_inspection_screenshot to verify the result.`,
          }],
        };
      } catch (e) {
        return {
          content: [{ type: 'text' as const, text: `Error performing browser action: ${(e as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  // ── find_web_elements ─────────────────────────────────────────────────────
  server.tool(
    'find_web_elements',
    'Find elements in the current browser page by CSS selector, XPath, id, name, or link text. ' +
    'CSS selectors are the recommended strategy for web automation: ' +
    '"#login-btn" (by id), ".submit-button" (by class), "input[name=\'email\']" (by attribute), ' +
    '"[data-testid=\'submit\']" (by test id). ' +
    'Returns element IDs you can pass to tap_element, type_into_element, and clear_element.',
    {
      handle: z.string().describe('Session handle from start_browser_inspection_session.'),
      strategy: z
        .enum(['css selector', 'xpath', 'id', 'name', 'link text', 'partial link text', 'tag name'])
        .describe(
          'Locator strategy. "css selector" (recommended for web), "xpath", "id", "name", "link text", "partial link text", "tag name".'
        ),
      selector: z
        .string()
        .describe(
          'The locator value. CSS examples: "#submit", ".btn-primary", "input[name=\'email\']", "[data-testid=\'login\']".'
        ),
    },
    async (args) => {
      try {
        const session = requireSession(args.handle);
        if (session.platform !== 'web') {
          return {
            content: [{
              type: 'text' as const,
              text: '"find_web_elements" is for browser sessions only. Use find_elements for mobile sessions.',
            }],
            isError: true,
          };
        }
        const elements = await findElements(args.handle, args.strategy, args.selector, { maxEnriched: 20 });

        if (elements.length === 0) {
          return {
            content: [{
              type: 'text' as const,
              text:
                `No elements found for ${args.strategy} = "${args.selector}".\n` +
                `Try get_page_dom to inspect available elements, or take_inspection_screenshot to see the current page state.`,
            }],
          };
        }

        const lines = [
          `Found ${elements.length} element${elements.length !== 1 ? 's' : ''} (${args.strategy} = "${args.selector}"):`,
        ];
        for (const el of elements) {
          // findElements reads web elements as tag (className), id (resourceId), class (contentDesc), text, bounds.
          const attrs = el.enriched === false
            ? '(attributes not fetched — beyond the first 20 matches; narrow the selector to see them)'
            : ([['tag', el.className], ['id', el.resourceId], ['class', el.contentDesc], ['text', el.text], ['bounds', el.bounds]] as const)
              .filter(([, v]) => v != null && v !== '')
              .map(([k, v]) => `${k}="${String(v).replace(/\s+/g, ' ').slice(0, 120)}"`)
              .join(' ');
          lines.push(`  ID: ${el.elementId}  ${attrs}`);
        }
        lines.push(``, `Pass the element ID to tap_element, type_into_element, or clear_element.`);

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (e) {
        return {
          content: [{ type: 'text' as const, text: `Error finding elements: ${(e as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  // ── get_browser_log ───────────────────────────────────────────────────────
  server.tool(
    'get_browser_log',
    'Read what a browser inspection session captured since it started (or since the last clear): console messages ' +
    '(console.log/info/warn/error), uncaught JavaScript errors, and failed network requests (HTTP 4xx/5xx and fetch ' +
    'errors — successful requests are only counted). Use it to explain a blank or broken page, a button that does ' +
    'nothing, or a failing API call. Captured over WebDriver BiDi on chrome, MicrosoftEdge, firefox and opera; ' +
    'safari sessions have no capture. Newest entries last.',
    {
      handle: z.string().describe('Session handle from start_browser_inspection_session.'),
      kind: z.enum(['all', 'console', 'network']).optional().default('all')
        .describe('"console" = console messages and uncaught JS errors; "network" = failed requests; "all" (default).'),
      errorsOnly: z.boolean().optional().default(false).describe('Only error-level entries (console.error, JS errors, failed requests).'),
      clear: z.boolean().optional().default(false).describe('Empty the buffer after reading — call before an action to see only what that action caused.'),
      maxEntries: z.number().int().min(1).max(500).optional().default(50).describe('Newest N matching entries (default 50).'),
      outputFormat: outputFormatParam,
    },
    async (args) => {
      try {
        const session = requireSession(args.handle);
        if (session.platform !== 'web') {
          return { content: [{ type: 'text' as const, text: 'get_browser_log is for browser sessions. For a mobile device use get_device_log.' }], isError: true };
        }
        const r = readBrowserEvents(args.handle, { kind: args.kind, errorsOnly: args.errorsOnly, clear: args.clear, maxEntries: args.maxEntries });
        if (!r) {
          return {
            content: [{ type: 'text' as const, text: `No browser log for session ${args.handle}: capture is ${session.browserEvents ?? 'off'}. ` +
              'Start a new session on chrome, MicrosoftEdge, firefox or opera (captureBrowserLog defaults to true) to capture it.' }],
            isError: true,
          };
        }
        const fmt = (e: (typeof r.events)[number]) => {
          const t = new Date(e.time).toISOString().slice(11, 23);
          const label = e.kind === 'network' ? `network ${e.method ?? ''}`.trim() : e.kind === 'javascript' ? 'js-error' : `console.${e.level}`;
          return `[${t}] ${label.padEnd(16)} ${e.text}${e.url ? `  (${e.url})` : ''}`;
        };
        const header = `${r.matched} matching entr${r.matched === 1 ? 'y' : 'ies'}` +
          (r.matched > r.events.length ? ` (newest ${r.events.length} shown)` : '') +
          ` · ${r.okRequests} successful request${r.okRequests === 1 ? '' : 's'} not listed` +
          (r.dropped ? ` · ${r.dropped} older entries dropped (buffer keeps 500)` : '') +
          (args.clear ? ' · buffer cleared' : '') +
          (r.socketClosed ? ` · ⚠️ capture stopped: ${r.socketClosed}` : '');
        const human = r.events.length ? `${header}\n${r.events.map(fmt).join('\n')}` : `${header}\nNothing captured${args.errorsOnly ? ' at error level' : ''}.`;
        return respond(args.outputFormat, { handle: args.handle, ...r }, human);
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  // ── list_browser_inspection_sessions ──────────────────────────────────────
  server.tool(
    'list_browser_inspection_sessions',
    'List all active browser inspection sessions in the current MCP server process. ' +
    'Use this to find session handles when continuing after a previous interaction, ' +
    'or to identify sessions that should be stopped.',
    {},
    async () => {
      const sessions = listActiveSessions().filter((s) => s.platform === 'web');

      if (sessions.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: 'No active browser inspection sessions. Use start_browser_inspection_session to begin.',
          }],
        };
      }

      const lines = [`${sessions.length} active browser inspection session${sessions.length !== 1 ? 's' : ''}:\n`];
      for (const s of sessions) {
        lines.push(browserSessionSummary(s));
      }

      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    }
  );

  // ── cleanup_browser_inspection_sessions ───────────────────────────────────
  server.tool(
    'cleanup_browser_inspection_sessions',
    'Delete all test reports created by browser inspection sessions during this MCP server process. ' +
    'Includes reports from browser sessions that were closed without calling stop_browser_inspection_session. ' +
    'stop_browser_inspection_session deletes its own report automatically; this tool handles orphans. ' +
    'Cloud Admin, or a project-level role whose project has allowUsersDeleteTests enabled (access level is detected from the API). ' +
    'Requires confirmDeletion: true.',
    {
      confirmDeletion: z
        .boolean()
        .optional()
        .describe('Must be true to proceed. Safety guard prevents accidental deletion.'),
    },
    async (args) => {
      const pending = getPendingReportIds();

      if (pending.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: 'No tracked browser inspection reports to clean up.',
          }],
        };
      }

      const denied = await checkDeleteAllowed();
      if (denied) {
        return {
          content: [{
            type: 'text' as const,
            text:
              denied + ` The ${pending.length} tracked report ID(s) are preserved — switch to a Cloud Admin profile, then re-run cleanup_browser_inspection_sessions.`,
          }],
          isError: true,
        };
      }

      const guard = checkDestructiveGuard(
        args.confirmDeletion,
        `Delete ${pending.length} browser inspection report${pending.length !== 1 ? 's' : ''} (IDs: ${pending.join(', ')})`
      );
      if (guard) return { content: [{ type: 'text' as const, text: guard }] };

      try {
        const { deleted, failed } = await deleteAllTrackedReports();
        const failNote = failed.length > 0
          ? ` ⚠️ ${failed.length} could not be deleted and remain tracked (IDs: ${failed.join(', ')}) — run cleanup again to retry.`
          : '';
        return {
          content: [{
            type: 'text' as const,
            text: `✅ Deleted ${deleted.length} browser inspection report${deleted.length !== 1 ? 's' : ''} (IDs: ${deleted.join(', ')}).${failNote}`,
          }],
        };
      } catch (e) {
        return {
          content: [{ type: 'text' as const, text: `Error during cleanup: ${(e as Error).message}` }],
          isError: true,
        };
      }
    }
  );
}
