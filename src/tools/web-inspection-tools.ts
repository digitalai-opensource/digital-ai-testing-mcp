import { z } from 'zod';
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
import { checkDestructiveGuard } from '../utils/destructive-guard.js';
import { getActiveKeyType } from '../api/client.js';

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
    'There is no live view URL for browser sessions (unlike mobile sessions). ' +
    'Use take_inspection_screenshot to relay the current state to the user at each checkpoint. ' +
    'Always call stop_browser_inspection_session when done.',
    {
      inspectionBrowser: z
        .string()
        .optional()
        .describe(
          "Browser to open for this inspection session (e.g. 'chrome', 'firefox', 'MicrosoftEdge', 'safari'). " +
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
    },
    async (args) => {
      if (!args.inspectionBrowser) {
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
        const session = await createBrowserInspectionSession({
          browserName: args.inspectionBrowser,
          os: args.os,
          reportName: args.reportName,
        });

        const lines = [
          `✅ Browser inspection session started.`,
          `Handle:       ${session.handle}`,
          `Browser:      ${session.browserName ?? args.inspectionBrowser}`,
          `Version:      ${session.deviceVersion || '(unknown)'}`,
          `Report URL:   ${session.reportUrl || '(not available)'}`,
          ``,
          `SESSION NOTE: No live view URL for browser sessions (unlike mobile sessions).`,
          `Use take_inspection_screenshot to relay the page state at each step.`,
          `The inspection browser is for element discovery only — the generated test will be browser-neutral.`,
        ];

        if (args.url) {
          try {
            await navigateTo(session.handle, args.url);
            lines.push(``, `Navigated to: ${session.currentUrl || args.url}`);
          } catch (navErr) {
            lines.push(``, `⚠️  Initial navigation to "${args.url}" failed: ${(navErr as Error).message}. Session is still open.`);
          }
        }

        lines.push(``, `When done, call stop_browser_inspection_session("${session.handle}").`);

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
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
            `Note: Report (ID: ${reportTestId}) was kept — project-level keys cannot delete reporter records.`,
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
    'Shadow DOM detection is automatic: if any shadow roots are detected, a recursive walker extracts ' +
    'nested elements up to 3 levels deep. Set shadowMode to "always" to force the full walker, or ' +
    '"never" to use only the standard rendered HTML (for non-SPA pages).\n\n' +
    'Use find_web_elements to locate and verify specific elements before adding them to the test script.',
    {
      handle: z.string().describe('Session handle from start_browser_inspection_session.'),
      shadowMode: z
        .enum(['auto', 'always', 'never'])
        .optional()
        .default('auto')
        .describe(
          '"auto" (default): uses shadow DOM walker only when shadow roots are detected. ' +
          '"always": forces the full recursive shadow DOM extraction. ' +
          '"never": returns only the standard rendered HTML (fastest; use for simple non-SPA pages).'
        ),
      includeRawHtml: z
        .boolean()
        .optional()
        .default(false)
        .describe('Include the full rendered HTML in the response. Default false (structured elements only).'),
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
        } else if (result.rawHtml) {
          lines.push(`DOM extracted as raw HTML (${result.rawHtml.length} chars). ` +
            `Parse for CSS selectors or call find_web_elements to locate specific elements.`);
          if (args.includeRawHtml) {
            lines.push(``, `--- RAW HTML ---`, result.rawHtml.slice(0, 50_000));
            if (result.rawHtml.length > 50_000) {
              lines.push(`... (truncated, ${result.rawHtml.length} total chars)`);
            }
          }
        } else {
          lines.push('No elements found. The page may still be loading — try take_inspection_screenshot to check.');
        }

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
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
        const elements = await findElements(args.handle, args.strategy, args.selector);

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
          const attrs = Object.entries(el)
            .filter(([k]) => k !== 'elementId' && k !== 'ELEMENT')
            .map(([k, v]) => `${k}="${v}"`)
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
    'Cloud Admin access required (reporter delete is CSRF-blocked for project-level keys). ' +
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

      if (getActiveKeyType() !== 'jwt') {
        return {
          content: [{
            type: 'text' as const,
            text:
              `Error: Cloud Admin access required. The reporter delete endpoint is CSRF-blocked for project-level keys. ` +
              `The ${pending.length} tracked report ID(s) are preserved — use switch_environment() to switch to a ` +
              `Cloud Admin profile, then re-run cleanup_browser_inspection_sessions.`,
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
