import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  createInspectionSession,
  quitInspectionSession,
  captureScreenshot,
  getPageSource,
  findElements,
  tapElement,
  typeIntoElement,
  clearElement,
  listActiveSessions,
  getPendingReportIds,
  deleteAllTrackedReports,
} from '../api/webdriver.js';
import type { InspectionSession } from '../types/digital-ai.js';
import { checkDestructiveGuard } from '../utils/destructive-guard.js';
import { getActiveKeyType } from '../api/client.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sessionSummary(s: InspectionSession): string {
  const age = Math.round((Date.now() - s.startedAt) / 1000);
  return (
    `Handle:   ${s.handle}\n` +
    `Device:   ${s.deviceName} (${s.deviceOs} ${s.deviceVersion})\n` +
    `App:      ${s.appPackage || '(none)'}\n` +
    `Age:      ${age}s\n` +
    (s.cloudViewLink ? `Studio:   ${s.cloudViewLink}\n` : '')
  );
}

// Extract a named attribute value from an XML attribute string.
function extractAttr(attrs: string, name: string): string | null {
  const re = new RegExp(`${name}="([^"]*)"`, 'i');
  const m = re.exec(attrs);
  return m ? m[1] : null;
}

// Shorten a class name to just the leaf component (e.g. android.widget.EditText → EditText).
function shortClass(cls: string): string {
  const parts = cls.split('.');
  return parts[parts.length - 1] ?? cls;
}

// Strip the package prefix from a resource-id (e.g. com.example:id/foo → foo).
function shortId(id: string): string {
  const colonIdx = id.indexOf(':id/');
  return colonIdx >= 0 ? id.slice(colonIdx + 4) : id;
}

interface ParsedElement {
  className: string;
  resourceId: string | null;
  contentDesc: string | null;
  text: string | null;
  bounds: string | null;
  clickable: boolean;
  enabled: boolean;
  fullResourceId: string | null;
}

function parseElementTree(xml: string): {
  elements: ParsedElement[];
  totalNodes: number;
} {
  const elements: ParsedElement[] = [];
  let totalNodes = 0;

  // Match opening or self-closing tags (not closing tags, not processing instructions)
  const tagRe = /<([\w.]+)(\s[^>]*?)?(?:\s*\/?>)/g;
  let m: RegExpExecArray | null;

  while ((m = tagRe.exec(xml)) !== null) {
    const cls = m[1];
    if (cls === 'hierarchy') continue;
    const attrs = m[2] ?? '';
    totalNodes++;

    const resourceId = extractAttr(attrs, 'resource-id');
    const contentDesc = extractAttr(attrs, 'content-desc');
    const text = extractAttr(attrs, 'text');
    const bounds = extractAttr(attrs, 'bounds');
    const clickable = extractAttr(attrs, 'clickable') === 'true';
    const enabled = extractAttr(attrs, 'enabled') !== 'false';

    elements.push({
      className: cls,
      resourceId,
      contentDesc: contentDesc || null,
      text: text || null,
      bounds,
      clickable,
      enabled,
      fullResourceId: resourceId,
    });
  }

  return { elements, totalNodes };
}

function formatElementTable(elements: ParsedElement[], totalNodes: number): string {
  // Only show elements with at least one useful locator attribute
  const interesting = elements.filter(
    (e) => e.resourceId || e.contentDesc || e.text
  );

  const lines: string[] = [
    `Screen hierarchy: ${totalNodes} nodes total, ${interesting.length} with locators`,
    '',
    `${'Type'.padEnd(18)} ${'resource-id'.padEnd(28)} ${'content-desc'.padEnd(22)} ${'text'.padEnd(22)} Clk`,
    '─'.repeat(96),
  ];

  for (const e of interesting) {
    const t = shortClass(e.className).padEnd(18);
    const rid = (e.resourceId ? shortId(e.resourceId) : '-').padEnd(28);
    const desc = (e.contentDesc ?? '-').slice(0, 20).padEnd(22);
    const txt = (e.text ?? '-').slice(0, 20).padEnd(22);
    const clk = e.clickable ? '✓' : ' ';
    lines.push(`${t} ${rid} ${desc} ${txt} ${clk}`);
  }

  if (interesting.length === 0) {
    lines.push('  (no elements with resource-id, content-desc, or text found on this screen)');
  }

  return lines.join('\n');
}

// ─── Tool registration ────────────────────────────────────────────────────────

export function registerInspectionTools(server: McpServer): void {
  // ── start_inspection_session ──────────────────────────────────────────────
  server.tool(
    'start_inspection_session',
    'Start a live WebDriver session on a real Android device for interactive test building. ' +
    'Returns a session handle used by all other inspection tools. ' +
    'The session reserves a device, launches the app, and gives you screenshot + element access. ' +
    'Session creation takes 20-90 s while a device is allocated.\n\n' +
    'Typical workflow:\n' +
    '  1. find_available_device — find a healthy device in the right region\n' +
    '  2. start_inspection_session — connect with region param for reliable routing\n' +
    '  3. take_inspection_screenshot — see current screen\n' +
    '  4. get_element_tree — discover element IDs and locators\n' +
    '  5. find_elements / tap_element / type_into_element — interact and verify\n' +
    '  6. stop_inspection_session — always call this when done; auto-deletes the test report\n\n' +
    'IMPORTANT: Always call stop_inspection_session when done. Sessions left open consume ' +
    'a reserved device and create a test report in the reporter. ' +
    'Use cleanup_inspection_sessions to delete reports from sessions that were abandoned.',
    {
      deviceQuery: z
        .string()
        .optional()
        .describe(
          "Server-side device query. Default: \"@os='android' and @category='PHONE'\". " +
          "Add @region, @model, @version as needed. Example: \"@os='android' and @category='PHONE' and @model='Pixel 7'\""
        ),
      region: z
        .string()
        .optional()
        .describe(
          "Region shortcode (e.g. 'US2', 'SG1'). Appended to deviceQuery as \"and @region='X'\". " +
          'Use find_available_device first to identify a healthy region.'
        ),
      app: z
        .string()
        .optional()
        .describe(
          "Full app capability string. For cloud-hosted apps: 'cloud:com.example.app/.MainActivity'. " +
          "Triggers install+launch. Omit to attach to an already-running app."
        ),
      appPackage: z
        .string()
        .optional()
        .describe("Android package name, e.g. 'com.experitest.ExperiBank'. Required when app is provided."),
      appActivity: z
        .string()
        .optional()
        .describe("Launch activity, e.g. '.LoginActivity'. Required when app is provided."),
      noReset: z
        .boolean()
        .optional()
        .default(true)
        .describe('If false, clears app data before launching. Default true.'),
      testName: z
        .string()
        .optional()
        .describe("Name shown in the Digital.ai reporter for this inspection session. Default: '[MCP Inspection]'."),
    },
    async (args) => {
      try {
        const session = await createInspectionSession({
          deviceQuery: args.deviceQuery,
          region: args.region,
          app: args.app,
          appPackage: args.appPackage,
          appActivity: args.appActivity,
          noReset: args.noReset ?? true,
          testName: args.testName,
        });

        const structured: Record<string, unknown> = {
          handle: session.handle,
          device: {
            name: session.deviceName,
            model: session.deviceModel,
            os: session.deviceOs,
            version: session.deviceVersion,
            udid: session.deviceUDID,
          },
          appPackage: session.appPackage,
          cloudViewLink: session.cloudViewLink,
          reportUrl: session.reportUrl,
        };

        if (!session.canDeleteReport) {
          structured.authWarning =
            'Project API key detected. The reporter delete endpoint (POST /reporter/api/tests/delete) ' +
            'is CSRF-blocked for project API keys — inspection session reports will NOT be automatically ' +
            'deleted. Delete them manually from the Digital.ai reporter UI, or switch to a Cloud Admin ' +
            'JWT profile before using inspection sessions: switch_environment("default").';
        }

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(structured) }],
        };
      } catch (e) {
        return {
          content: [{ type: 'text' as const, text: `Error starting inspection session: ${(e as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  // ── stop_inspection_session ───────────────────────────────────────────────
  server.tool(
    'stop_inspection_session',
    'Stop a live inspection session and release the device. ' +
    'Automatically deletes the test report created by this session from the Digital.ai reporter. ' +
    'Always call this when done inspecting — open sessions hold a reserved device.',
    {
      handle: z
        .string()
        .describe("Session handle returned by start_inspection_session, e.g. 'A1B2C3D4'."),
    },
    async (args) => {
      try {
        const { reportDeleted, canDeleteReport, reportTestId } = await quitInspectionSession(args.handle);

        let text: string;
        if (reportDeleted) {
          text = `✅ Session ${args.handle} stopped. Device released. Probe report deleted.`;
        } else if (!canDeleteReport && reportTestId > 0) {
          text =
            `✅ Session ${args.handle} stopped. Device released.\n\n` +
            `⚠️  Report NOT deleted (test_id=${reportTestId}): the reporter delete endpoint is CSRF-blocked ` +
            `for project API keys. Delete it manually from the Digital.ai reporter UI, or switch to a ` +
            `Cloud Admin JWT profile before running inspection sessions: switch_environment("default").`;
        } else {
          text = `✅ Session ${args.handle} stopped. Device released.`;
        }

        return { content: [{ type: 'text' as const, text }] };
      } catch (e) {
        return {
          content: [{ type: 'text' as const, text: `Error stopping session: ${(e as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  // ── take_inspection_screenshot ────────────────────────────────────────────
  server.tool(
    'take_inspection_screenshot',
    'Capture a screenshot from the device in the active inspection session. ' +
    'Returns the image directly so you can see what is currently displayed on the device screen. ' +
    'Use this after navigation or interactions to verify the UI state.',
    {
      handle: z
        .string()
        .describe("Session handle from start_inspection_session."),
    },
    async (args) => {
      try {
        const { data, mimeType } = await captureScreenshot(args.handle);
        return {
          content: [
            { type: 'image' as const, data, mimeType },
            { type: 'text' as const, text: `Screenshot captured (session ${args.handle}, ${mimeType}).` },
          ],
        };
      } catch (e) {
        return {
          content: [{ type: 'text' as const, text: `Error capturing screenshot: ${(e as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  // ── get_element_tree ──────────────────────────────────────────────────────
  server.tool(
    'get_element_tree',
    'Get the UI element hierarchy from the current screen. ' +
    'Returns a formatted table of all elements that have locator attributes (resource-id, ' +
    'content-desc, or visible text), plus the raw XML source for detailed inspection. ' +
    'Use this to discover element IDs for use with find_elements, tap_element, and type_into_element.',
    {
      handle: z
        .string()
        .describe("Session handle from start_inspection_session."),
      includeRawXml: z
        .boolean()
        .optional()
        .default(false)
        .describe('Include the raw XML page source in the response. Default false (summary only).'),
    },
    async (args) => {
      try {
        const xml = await getPageSource(args.handle);
        const { elements, totalNodes } = parseElementTree(xml);
        const table = formatElementTable(elements, totalNodes);

        let text = table;
        if (args.includeRawXml) {
          const truncated = xml.length > 8000 ? xml.slice(0, 8000) + '\n... (truncated)' : xml;
          text += `\n\nRaw XML:\n${truncated}`;
        }

        return { content: [{ type: 'text' as const, text }] };
      } catch (e) {
        return {
          content: [{ type: 'text' as const, text: `Error getting element tree: ${(e as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  // ── find_elements ─────────────────────────────────────────────────────────
  server.tool(
    'find_elements',
    'Find elements on the current screen using a locator strategy and return their IDs and attributes. ' +
    'The returned elementId values are used with tap_element, type_into_element, and clear_element. ' +
    'Strategies: "xpath" (most flexible), "id" (resource-id, fastest), "accessibility id" (content-desc), ' +
    '"class name" (by widget type, often returns many).',
    {
      handle: z
        .string()
        .describe("Session handle from start_inspection_session."),
      strategy: z
        .enum(['xpath', 'id', 'accessibility id', 'class name'])
        .describe(
          "Locator strategy. 'id' matches resource-id (e.g. 'com.example:id/login'). " +
          "'accessibility id' matches content-desc. " +
          "'xpath' supports complex expressions like '//android.widget.EditText[@text=\"Username\"]'."
        ),
      selector: z
        .string()
        .describe("The locator value. Examples: 'com.example:id/login', '//android.widget.Button[@text=\"Submit\"]'."),
    },
    async (args) => {
      try {
        const elements = await findElements(args.handle, args.strategy, args.selector);

        if (elements.length === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `No elements found matching ${args.strategy}: "${args.selector}"\n\nCheck the selector with get_element_tree to confirm available locators.`,
              },
            ],
          };
        }

        const lines: string[] = [
          `Found ${elements.length} element${elements.length !== 1 ? 's' : ''} matching ${args.strategy}: "${args.selector}"\n`,
        ];

        for (let i = 0; i < elements.length; i++) {
          const e = elements[i];
          lines.push(`Element ${i + 1}:`);
          lines.push(`  elementId:    ${e.elementId}`);
          if (e.className) lines.push(`  type:         ${shortClass(e.className)}`);
          if (e.resourceId) lines.push(`  resource-id:  ${e.resourceId}`);
          if (e.contentDesc) lines.push(`  content-desc: ${e.contentDesc}`);
          lines.push(`  text:         ${e.text ?? '(empty)'}`);
          if (e.bounds) lines.push(`  bounds:       ${e.bounds}`);
          lines.push(`  clickable:    ${e.clickable ?? 'unknown'}`);
          lines.push(`  enabled:      ${e.enabled ?? 'unknown'}`);
          lines.push('');
        }

        if (elements.length === 1) {
          const e = elements[0];
          lines.push(
            `To interact:\n` +
            `  tap_element(handle="${args.handle}", elementId="${e.elementId}")\n` +
            `  type_into_element(handle="${args.handle}", elementId="${e.elementId}", text="...")`
          );
        }

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (e) {
        return {
          content: [{ type: 'text' as const, text: `Error finding elements: ${(e as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  // ── tap_element ───────────────────────────────────────────────────────────
  server.tool(
    'tap_element',
    'Tap (click) an element on the device screen. ' +
    'Use find_elements first to get the elementId, then call this to interact. ' +
    'After tapping, call take_inspection_screenshot to verify the result.',
    {
      handle: z
        .string()
        .describe("Session handle from start_inspection_session."),
      elementId: z
        .string()
        .describe("Element ID returned by find_elements."),
    },
    async (args) => {
      try {
        await tapElement(args.handle, args.elementId);
        return {
          content: [
            {
              type: 'text' as const,
              text: `✅ Tapped element ${args.elementId}.\n\nCall take_inspection_screenshot to verify the result.`,
            },
          ],
        };
      } catch (e) {
        return {
          content: [{ type: 'text' as const, text: `Error tapping element: ${(e as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  // ── type_into_element ─────────────────────────────────────────────────────
  server.tool(
    'type_into_element',
    'Type text into an input field on the device screen. ' +
    'Use find_elements to locate an EditText element, then call this. ' +
    'For fields that need clearing first, call clear_element before typing.',
    {
      handle: z
        .string()
        .describe("Session handle from start_inspection_session."),
      elementId: z
        .string()
        .describe("Element ID of an EditText field, returned by find_elements."),
      text: z
        .string()
        .describe("Text to type into the field."),
    },
    async (args) => {
      try {
        await typeIntoElement(args.handle, args.elementId, args.text);
        return {
          content: [
            {
              type: 'text' as const,
              text: `✅ Typed "${args.text}" into element ${args.elementId}.`,
            },
          ],
        };
      } catch (e) {
        return {
          content: [{ type: 'text' as const, text: `Error typing into element: ${(e as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  // ── clear_element ─────────────────────────────────────────────────────────
  server.tool(
    'clear_element',
    'Clear the text content of an input field. Use before type_into_element when the field already has content.',
    {
      handle: z
        .string()
        .describe("Session handle from start_inspection_session."),
      elementId: z
        .string()
        .describe("Element ID of the field to clear, returned by find_elements."),
    },
    async (args) => {
      try {
        await clearElement(args.handle, args.elementId);
        return {
          content: [{ type: 'text' as const, text: `✅ Cleared element ${args.elementId}.` }],
        };
      } catch (e) {
        return {
          content: [{ type: 'text' as const, text: `Error clearing element: ${(e as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  // ── list_inspection_sessions ──────────────────────────────────────────────
  server.tool(
    'list_inspection_sessions',
    'List all active inspection sessions in the current MCP server process. ' +
    'Use this to find session handles when continuing after a previous interaction, ' +
    'or to identify sessions that should be stopped.',
    {},
    async () => {
      const sessions = listActiveSessions();

      if (sessions.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'No active inspection sessions. Use start_inspection_session to begin.',
            },
          ],
        };
      }

      const lines = [`${sessions.length} active inspection session${sessions.length !== 1 ? 's' : ''}:\n`];
      for (const s of sessions) {
        lines.push(sessionSummary(s));
      }

      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    }
  );

  // ── cleanup_inspection_sessions ───────────────────────────────────────────
  server.tool(
    'cleanup_inspection_sessions',
    'Delete all test reports created by inspection sessions during this MCP server process. ' +
    'Includes reports from sessions that were stopped without a clean shutdown. ' +
    'stop_inspection_session deletes its own report automatically; this tool handles orphans. ' +
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
          content: [
            {
              type: 'text' as const,
              text: 'No tracked inspection reports to clean up.',
            },
          ],
        };
      }

      if (getActiveKeyType() !== 'jwt') {
        return {
          content: [{
            type: 'text' as const,
            text:
              `Error: Cloud Admin JWT required. The reporter delete endpoint is CSRF-blocked for project API keys. ` +
              `The ${pending.length} tracked report ID(s) are preserved — use switch_environment() to switch to a ` +
              `Cloud Admin JWT profile, then re-run cleanup_inspection_sessions.`,
          }],
          isError: true,
        };
      }

      const guard = checkDestructiveGuard(
        args.confirmDeletion,
        `Delete ${pending.length} inspection session report${pending.length !== 1 ? 's' : ''} (IDs: ${pending.join(', ')})`
      );
      if (guard) return { content: [{ type: 'text' as const, text: guard }] };

      try {
        const deleted = await deleteAllTrackedReports();
        return {
          content: [
            {
              type: 'text' as const,
              text: `✅ Deleted ${deleted.length} inspection report${deleted.length !== 1 ? 's' : ''} (IDs: ${deleted.join(', ')}).`,
            },
          ],
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
