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
  swipeScreen,
  getWindowSize,
  launchApp,
  pressBack,
  longPress,
  doubleTap,
  dragAndDrop,
  pinchZoom,
  scrollToElement,
  pressKey,
  isKeyboardShown,
  hideKeyboard,
  appControl,
  getOrientation,
  setOrientation,
  getClipboard,
  setClipboard,
  setGeolocation,
  resetGeolocation,
  handleAlert,
  pushFileToDevice,
  pullFileFromDevice,
  requireSession,
  listActiveSessions,
  getPendingReportIds,
  deleteAllTrackedReports,
} from '../api/webdriver.js';
import type { InspectionSession } from '../types/digital-ai.js';
import { checkDestructiveGuard } from '../utils/destructive-guard.js';
import { getActiveKeyType, getActiveUrl } from '../api/client.js';
import { resolveDevice } from '../utils/device-resolver.js';
import { validateInputPath, validateOutputPath } from '../utils/path-guard.js';
import { readFileSync, writeFileSync } from 'fs';

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
  // iOS attributes
  name: string | null;
  label: string | null;
  value: string | null;
}

function parseElementTree(
  xml: string,
  platform: 'android' | 'ios'
): {
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
    if (cls === 'hierarchy' || cls === 'AppiumAUT' || cls === 'node') continue;
    const attrs = m[2] ?? '';
    totalNodes++;

    if (platform === 'ios') {
      // XCUI XML: locators live in name/label/value; geometry in x/y/width/height.
      const name = extractAttr(attrs, 'name');
      const label = extractAttr(attrs, 'label');
      const value = extractAttr(attrs, 'value');
      const visible = extractAttr(attrs, 'visible') !== 'false';
      const enabled = extractAttr(attrs, 'enabled') !== 'false';
      const x = extractAttr(attrs, 'x');
      const y = extractAttr(attrs, 'y');
      const w = extractAttr(attrs, 'width');
      const h = extractAttr(attrs, 'height');
      const bounds =
        x != null && y != null && w != null && h != null
          ? `[${x},${y}][${Number(x) + Number(w)},${Number(y) + Number(h)}]`
          : null;

      elements.push({
        className: cls,
        resourceId: null,
        contentDesc: null,
        text: null,
        bounds,
        clickable: visible,
        enabled,
        fullResourceId: null,
        name: name || null,
        label: label || null,
        value: value || null,
      });
      continue;
    }

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
      name: null,
      label: null,
      value: null,
    });
  }

  return { elements, totalNodes };
}

function formatElementTable(
  elements: ParsedElement[],
  totalNodes: number,
  platform: 'android' | 'ios'
): string {
  if (platform === 'ios') {
    const interesting = elements.filter((e) => e.name || e.label || e.value);
    const lines: string[] = [
      `Screen hierarchy: ${totalNodes} nodes total, ${interesting.length} with locators`,
      '',
      `${'Type'.padEnd(22)} ${'name'.padEnd(26)} ${'label'.padEnd(26)} ${'value'.padEnd(18)} Vis`,
      '─'.repeat(98),
    ];
    for (const e of interesting) {
      const t = shortClass(e.className).replace(/^XCUIElementType/, '').padEnd(22);
      const n = (e.name ?? '-').slice(0, 24).padEnd(26);
      const l = (e.label ?? '-').slice(0, 24).padEnd(26);
      const v = (e.value ?? '-').slice(0, 16).padEnd(18);
      const vis = e.clickable ? '✓' : ' ';
      lines.push(`${t} ${n} ${l} ${v} ${vis}`);
    }
    if (interesting.length === 0) {
      lines.push('  (no elements with name, label, or value found on this screen)');
    }
    lines.push('', "Locate iOS elements with: strategy 'accessibility id' or 'name' (matches name), or xpath like //*[@label='...'] or //XCUIElementTypeButton.");
    return lines.join('\n');
  }

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
    'Start a live WebDriver session on a real Android or iOS device for interactive test building. ' +
    'Returns a session handle used by all other inspection tools, plus viewUrl/debugUrl — ' +
    'SHARE BOTH URLS WITH THE USER IMMEDIATELY so they can watch (viewUrl) or interact (debugUrl) in real time. ' +
    'The session reserves a device and gives you screenshot + element + gesture access. ' +
    'Session creation takes 20-90 s while a device is allocated.\n\n' +
    'Typical workflow:\n' +
    '  1. find_available_device — find a healthy device (region preference is automatic)\n' +
    '  2. install_application — BEFORE starting the session; install fails while the device is reserved\n' +
    '  3. start_inspection_session — connect with region param for reliable routing; share viewUrl/debugUrl\n' +
    '  4. launch_app — foreground the app (Android: packageName + mainActivity from get_application_info; iOS: bundleIdentifier)\n' +
    '  5. take_inspection_screenshot / get_element_tree — see the screen, discover locators\n' +
    '  6. find_elements / tap_element / type_into_element / swipe_screen / press_back — interact and verify\n' +
    '  7. stop_inspection_session — always call this when done; auto-deletes the test report\n\n' +
    'iOS NOTES: elements are located by name/label/value (not resource-id); ' +
    'press_back performs the left-edge back swipe; clipboard and clear_data are unavailable on iOS Grid sessions.\n\n' +
    'KNOWN LIMITATIONS: (a) the app/appPackage/appActivity params return HTTP 500 on some deployments — ' +
    'if that happens, start a generic session (no app params) and use launch_app instead; ' +
    '(b) targeting a specific device via @serialNumber or @model in deviceQuery can time out — ' +
    'prefer generic queries (@os + @category) scoped with the region param; ' +
    'the deviceQuery field support here is narrower than list_devices.\n\n' +
    'IMPORTANT: Always call stop_inspection_session when done. Sessions left open consume ' +
    'a reserved device and create a test report in the reporter. ' +
    'Use cleanup_inspection_sessions to delete reports from sessions that were abandoned.',
    {
      platform: z
        .enum(['android', 'ios'])
        .optional()
        .default('android')
        .describe("Target platform. Default 'android'. Sets platformName and the default deviceQuery @os."),
      deviceQuery: z
        .string()
        .optional()
        .describe(
          "Server-side device query. Default: \"@os='android' and @category='PHONE'\" (or @os='iOS' when platform is ios). " +
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
          platform: args.platform ?? 'android',
          deviceQuery: args.deviceQuery,
          region: args.region,
          app: args.app,
          appPackage: args.appPackage,
          appActivity: args.appActivity,
          noReset: args.noReset ?? true,
          testName: args.testName,
        });

        // Resolve the numeric platform device ID from the UDID so the user-facing
        // view/debug URLs can be emitted without a follow-up list_devices call.
        let deviceId: string | null = null;
        let viewUrl: string | null = null;
        let debugUrl: string | null = null;
        if (session.deviceUDID) {
          try {
            const resolved = await resolveDevice(session.deviceUDID);
            deviceId = resolved.id;
            const base = getActiveUrl().replace(/\/+$/, '');
            viewUrl = `${base}/#/open/device/${deviceId}/1`;
            debugUrl = `${base}/#/open/device/${deviceId}/3`;
          } catch {
            // Non-fatal — session is usable without the URLs
          }
        }

        const structured: Record<string, unknown> = {
          handle: session.handle,
          platform: session.platform,
          device: {
            id: deviceId,
            name: session.deviceName,
            model: session.deviceModel,
            os: session.deviceOs,
            version: session.deviceVersion,
            udid: session.deviceUDID,
          },
          appPackage: session.appPackage,
          viewUrl,
          debugUrl,
          cloudViewLink: session.cloudViewLink,
          reportUrl: session.reportUrl,
          shareWithUser: viewUrl
            ? `Emit these URLs to the user immediately so they can follow along: watch live at ${viewUrl} or interact in debug mode at ${debugUrl}`
            : null,
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
    'By default deletes the test report created by this session from the Digital.ai reporter. ' +
    'Pass keepReport: true to preserve it — the platform records video of every session, and the kept ' +
    "report's video is retrievable via download_test_attachments (useful for documenting a verified flow). " +
    'Always call this when done inspecting — open sessions hold a reserved device.',
    {
      handle: z
        .string()
        .describe("Session handle returned by start_inspection_session, e.g. 'A1B2C3D4'."),
      keepReport: z
        .boolean()
        .optional()
        .default(false)
        .describe('Preserve the session report (and its platform-recorded video) instead of deleting it. Default false.'),
    },
    async (args) => {
      try {
        const { reportDeleted, reportKept, canDeleteReport, reportTestId, reportUrl } =
          await quitInspectionSession(args.handle, args.keepReport ?? false);

        let text: string;
        if (reportKept) {
          text =
            `✅ Session ${args.handle} stopped. Device released. Report KEPT (test_id=${reportTestId}).\n` +
            `Report: ${reportUrl}\n` +
            `The platform-recorded session video is attached to this report — retrieve it with ` +
            `download_test_attachments once processing completes (usually within a minute).`;
        } else if (reportDeleted) {
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
        const platform = requireSession(args.handle).platform;
        const xml = await getPageSource(args.handle);
        const { elements, totalNodes } = parseElementTree(xml, platform);
        const table = formatElementTable(elements, totalNodes, platform);

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
          if (e.name) lines.push(`  name:         ${e.name}`);
          if (e.label) lines.push(`  label:        ${e.label}`);
          if (e.value) lines.push(`  value:        ${e.value}`);
          if (e.text != null || (!e.name && !e.label)) lines.push(`  text:         ${e.text ?? '(empty)'}`);
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

  // ── swipe_screen ──────────────────────────────────────────────────────────
  server.tool(
    'swipe_screen',
    'Swipe/scroll on the device screen. Use a named direction for common gestures ' +
    '(scrolling lists, opening the app drawer, dismissing overlays), or explicit coordinates for precision. ' +
    'Direction is the FINGER movement: "up" moves the finger up, which scrolls content DOWN/forward ' +
    '(and opens the app drawer from the home screen). ' +
    'Works on both Appium 1.x (JWP touch actions) and Appium 2/3 (W3C actions) agents automatically.',
    {
      handle: z.string().describe('Session handle from start_inspection_session.'),
      direction: z
        .enum(['up', 'down', 'left', 'right'])
        .optional()
        .describe('Finger movement direction. Swipes from 80% to 20% of the screen along the axis, centered on the other axis. Provide this OR explicit coordinates.'),
      startX: z.number().int().optional().describe('Explicit start X (pixels). All four coordinates required together.'),
      startY: z.number().int().optional().describe('Explicit start Y (pixels).'),
      endX: z.number().int().optional().describe('Explicit end X (pixels).'),
      endY: z.number().int().optional().describe('Explicit end Y (pixels).'),
      durationMs: z
        .number()
        .int()
        .optional()
        .default(300)
        .describe('Gesture duration in ms. 300 = normal swipe, 100 = fast fling, 600+ = slow drag. Default 300.'),
    },
    async (args) => {
      try {
        let { startX, startY, endX, endY } = args;
        const hasCoords = [startX, startY, endX, endY].every((v) => v != null);

        if (!args.direction && !hasCoords) {
          return {
            content: [{ type: 'text' as const, text: 'Error: provide either direction or all four of startX/startY/endX/endY.' }],
            isError: true,
          };
        }

        if (args.direction && !hasCoords) {
          const { width, height } = await getWindowSize(args.handle);
          const midX = Math.round(width / 2);
          const midY = Math.round(height / 2);
          switch (args.direction) {
            case 'up':
              startX = midX; endX = midX;
              startY = Math.round(height * 0.8); endY = Math.round(height * 0.2);
              break;
            case 'down':
              startX = midX; endX = midX;
              startY = Math.round(height * 0.2); endY = Math.round(height * 0.8);
              break;
            case 'left':
              startY = midY; endY = midY;
              startX = Math.round(width * 0.8); endX = Math.round(width * 0.2);
              break;
            case 'right':
              startY = midY; endY = midY;
              startX = Math.round(width * 0.2); endX = Math.round(width * 0.8);
              break;
          }
        }

        const mechanism = await swipeScreen(
          args.handle,
          startX!,
          startY!,
          endX!,
          endY!,
          args.durationMs ?? 300
        );
        return {
          content: [{
            type: 'text' as const,
            text:
              `✅ Swiped ${args.direction ?? ''} (${startX},${startY}) → (${endX},${endY}) over ${args.durationMs ?? 300}ms [${mechanism}].\n\n` +
              `Call take_inspection_screenshot to verify the result.`,
          }],
        };
      } catch (e) {
        return {
          content: [{ type: 'text' as const, text: `Error swiping: ${(e as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  // ── launch_app ────────────────────────────────────────────────────────────
  server.tool(
    'launch_app',
    'Launch an installed app on the device in an inspection session — the equivalent of tapping its icon. ' +
    'Android: ALWAYS pass the activity (get mainActivity from get_application_info(appId); guessing ".MainActivity" often fails, ' +
    'and Grid sessions cannot launch by package name alone). ' +
    'iOS: pass the bundleIdentifier as packageName — no activity exists or is needed. ' +
    'Use this instead of navigating to the app via home screen / app drawer / search.',
    {
      handle: z.string().describe('Session handle from start_inspection_session.'),
      packageName: z.string().describe("Android package name (e.g. 'com.digitalai.sampleapp') or iOS bundle identifier (e.g. 'com.digitalai.sample')."),
      activity: z
        .string()
        .optional()
        .describe("Android launch activity, e.g. '.LoginActivity' — from get_application_info mainActivity; effectively required on Android Grid sessions. Ignored on iOS."),
    },
    async (args) => {
      try {
        const result = await launchApp(args.handle, args.packageName, args.activity);
        return {
          content: [{
            type: 'text' as const,
            text: `✅ ${result}.\n\nCall take_inspection_screenshot to verify the app is in the foreground.`,
          }],
        };
      } catch (e) {
        return {
          content: [{
            type: 'text' as const,
            text:
              `Error launching app: ${(e as Error).message}\n\n` +
              `If the app is not installed, install it first (install_application requires the device to be ` +
              `unreserved — stop this session, install, then start a new session). ` +
              `If the activity is wrong, get the correct one from get_application_info(appId).`,
          }],
          isError: true,
        };
      }
    }
  );

  // ── press_back ────────────────────────────────────────────────────────────
  server.tool(
    'press_back',
    'Navigate back one screen. Android: presses the Back button (also dismisses keyboards and dialogs). ' +
    'iOS: performs the left-edge back swipe (the platform convention — iOS has no Back button).',
    {
      handle: z.string().describe('Session handle from start_inspection_session.'),
    },
    async (args) => {
      try {
        const result = await pressBack(args.handle);
        return {
          content: [{
            type: 'text' as const,
            text: `✅ ${result}.\n\nCall take_inspection_screenshot to verify the result.`,
          }],
        };
      } catch (e) {
        return {
          content: [{ type: 'text' as const, text: `Error pressing back: ${(e as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  // ── long_press ────────────────────────────────────────────────────────────
  server.tool(
    'long_press',
    'Long-press an element or screen coordinate — opens context menus, triggers press-and-hold actions. ' +
    'Provide elementId (from find_elements) or explicit x/y coordinates.',
    {
      handle: z.string().describe('Session handle from start_inspection_session.'),
      elementId: z.string().optional().describe('Element ID from find_elements. Provide this OR x/y.'),
      x: z.number().int().optional().describe('X coordinate (pixels).'),
      y: z.number().int().optional().describe('Y coordinate (pixels).'),
      durationMs: z.number().int().optional().default(1500).describe('Hold duration in ms. Default 1500.'),
    },
    async (args) => {
      try {
        await longPress(args.handle, { elementId: args.elementId, x: args.x, y: args.y }, args.durationMs ?? 1500);
        return {
          content: [{ type: 'text' as const, text: `✅ Long-pressed for ${args.durationMs ?? 1500}ms.\n\nCall take_inspection_screenshot to verify the result.` }],
        };
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `Error long-pressing: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  // ── double_tap ────────────────────────────────────────────────────────────
  server.tool(
    'double_tap',
    'Double-tap an element or screen coordinate — zoom into images/maps, trigger double-tap actions. ' +
    'Provide elementId (from find_elements) or explicit x/y coordinates.',
    {
      handle: z.string().describe('Session handle from start_inspection_session.'),
      elementId: z.string().optional().describe('Element ID from find_elements. Provide this OR x/y.'),
      x: z.number().int().optional().describe('X coordinate (pixels).'),
      y: z.number().int().optional().describe('Y coordinate (pixels).'),
    },
    async (args) => {
      try {
        await doubleTap(args.handle, { elementId: args.elementId, x: args.x, y: args.y });
        return {
          content: [{ type: 'text' as const, text: `✅ Double-tapped.\n\nCall take_inspection_screenshot to verify the result.` }],
        };
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `Error double-tapping: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  // ── drag_and_drop ─────────────────────────────────────────────────────────
  server.tool(
    'drag_and_drop',
    'Press and hold at a start point, drag to an end point, and release — reorder lists, move sliders, drag items between containers. ' +
    'Use find_elements bounds to compute coordinates.',
    {
      handle: z.string().describe('Session handle from start_inspection_session.'),
      startX: z.number().int().describe('Drag start X (pixels).'),
      startY: z.number().int().describe('Drag start Y (pixels).'),
      endX: z.number().int().describe('Drop X (pixels).'),
      endY: z.number().int().describe('Drop Y (pixels).'),
      holdMs: z.number().int().optional().default(600).describe('Initial hold before moving (ms). Default 600.'),
      moveMs: z.number().int().optional().default(1200).describe('Movement duration (ms). Default 1200.'),
    },
    async (args) => {
      try {
        await dragAndDrop(args.handle, args.startX, args.startY, args.endX, args.endY, args.holdMs ?? 600, args.moveMs ?? 1200);
        return {
          content: [{ type: 'text' as const, text: `✅ Dragged (${args.startX},${args.startY}) → (${args.endX},${args.endY}).\n\nCall take_inspection_screenshot to verify the result.` }],
        };
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `Error dragging: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  // ── pinch_zoom ────────────────────────────────────────────────────────────
  server.tool(
    'pinch_zoom',
    'Two-finger pinch gesture — zoom in (fingers diverge) or out (fingers converge) on maps and images. ' +
    'Defaults to the screen center. NOTE: Appium Server (OSS) project sessions only — the Appium Grid rejects multi-touch.',
    {
      handle: z.string().describe('Session handle from start_inspection_session.'),
      direction: z.enum(['in', 'out']).describe("'in' = zoom in (fingers spread apart), 'out' = zoom out (fingers converge)."),
      centerX: z.number().int().optional().describe('Gesture center X. Default: screen center.'),
      centerY: z.number().int().optional().describe('Gesture center Y. Default: screen center.'),
      distance: z.number().int().optional().default(300).describe('Distance each finger travels (pixels). Default 300.'),
    },
    async (args) => {
      try {
        await pinchZoom(args.handle, args.direction, args.centerX, args.centerY, args.distance ?? 300);
        return {
          content: [{ type: 'text' as const, text: `✅ Pinch-zoomed ${args.direction}.\n\nCall take_inspection_screenshot to verify the result.` }],
        };
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `Error pinch-zooming: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  // ── scroll_to_element ─────────────────────────────────────────────────────
  server.tool(
    'scroll_to_element',
    'Scroll until an element becomes visible, swiping repeatedly and stopping when found or when the end of the ' +
    'scrollable content is reached (screen stops changing). Returns the element ID ready for tap/type. ' +
    'Much faster than manual swipe + screenshot loops for finding content below the fold.',
    {
      handle: z.string().describe('Session handle from start_inspection_session.'),
      strategy: z
        .enum(['xpath', 'id', 'accessibility id', 'class name'])
        .describe('Locator strategy (same as find_elements).'),
      selector: z.string().describe('The locator value to search for while scrolling.'),
      direction: z
        .enum(['up', 'down'])
        .optional()
        .default('up')
        .describe("Finger movement per swipe. 'up' (default) scrolls content forward/down; 'down' scrolls back toward the top."),
      maxSwipes: z.number().int().optional().default(8).describe('Maximum swipes before giving up. Default 8.'),
    },
    async (args) => {
      try {
        const result = await scrollToElement(args.handle, args.strategy, args.selector, args.direction ?? 'up', args.maxSwipes ?? 8);
        if (result.found && result.element) {
          const e = result.element;
          const lines = [
            `✅ Found after ${result.swipesUsed} swipe${result.swipesUsed !== 1 ? 's' : ''}:`,
            `  elementId:    ${e.elementId}`,
            e.resourceId ? `  resource-id:  ${e.resourceId}` : '',
            e.text ? `  text:         ${e.text}` : '',
            e.bounds ? `  bounds:       ${e.bounds}` : '',
            '',
            `To interact: tap_element(handle="${args.handle}", elementId="${e.elementId}")`,
          ].filter(Boolean);
          return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
        }
        const reason = result.reachedEnd
          ? `reached the end of the scrollable content after ${result.swipesUsed} swipes`
          : `gave up after ${result.swipesUsed} swipes (maxSwipes)`;
        return {
          content: [{ type: 'text' as const, text: `Element not found — ${reason}.\n\nVerify the selector with get_element_tree, or try direction="${(args.direction ?? 'up') === 'up' ? 'down' : 'up'}".` }],
        };
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `Error scrolling to element: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  // ── press_key ─────────────────────────────────────────────────────────────
  server.tool(
    'press_key',
    'Press a device key. Android: ENTER to submit forms/search, HOME, APP_SWITCH, volume, or any raw keycode. ' +
    'iOS: HOME, VOLUME_UP, VOLUME_DOWN, POWER (physical buttons only — for ENTER type "\\n" via type_into_element). ' +
    'Complements press_back (which has its own tool).',
    {
      handle: z.string().describe('Session handle from start_inspection_session.'),
      key: z
        .enum(['HOME', 'BACK', 'ENTER', 'TAB', 'DELETE', 'APP_SWITCH', 'SEARCH', 'MENU', 'VOLUME_UP', 'VOLUME_DOWN', 'POWER'])
        .optional()
        .describe('Named key. Provide this OR keycode. iOS supports HOME, VOLUME_UP, VOLUME_DOWN, POWER.'),
      keycode: z.number().int().optional().describe('Raw Android keycode (e.g. 66 = ENTER). Android only. Provide this OR key.'),
    },
    async (args) => {
      try {
        if (!args.key && args.keycode == null) {
          return { content: [{ type: 'text' as const, text: 'Error: provide either key (named) or keycode (number).' }], isError: true };
        }
        const pressed = await pressKey(args.handle, args.key, args.keycode);
        return {
          content: [{ type: 'text' as const, text: `✅ Pressed ${pressed}.\n\nCall take_inspection_screenshot to verify the result.` }],
        };
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `Error pressing key: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  // ── hide_keyboard ─────────────────────────────────────────────────────────
  server.tool(
    'hide_keyboard',
    'Hide the on-screen keyboard if it is open. Safer than press_back (which navigates when no keyboard is shown). ' +
    'Use when the keyboard covers an element you need to tap.',
    {
      handle: z.string().describe('Session handle from start_inspection_session.'),
    },
    async (args) => {
      try {
        const shown = await isKeyboardShown(args.handle);
        if (!shown) {
          return { content: [{ type: 'text' as const, text: 'Keyboard is not shown — nothing to hide.' }] };
        }
        await hideKeyboard(args.handle);
        return { content: [{ type: 'text' as const, text: '✅ Keyboard hidden.' }] };
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `Error hiding keyboard: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  // ── app_control ───────────────────────────────────────────────────────────
  server.tool(
    'app_control',
    'Control app lifecycle in an inspection session: terminate (force-stop), clear_data (reset to first-launch state — Android only; ' +
    'iOS requires uninstall/reinstall), query_state (installed/background/foreground), ' +
    'deep_link (open a URL/URI directly — skip navigation to the screen under test). ' +
    'NOTE on Grid sessions: query_state reports only the foreground activity (Android) or is unavailable (iOS); deep_link is best-effort. ' +
    'To relaunch after terminate, use launch_app.',
    {
      handle: z.string().describe('Session handle from start_inspection_session.'),
      action: z
        .enum(['terminate', 'clear_data', 'query_state', 'deep_link'])
        .describe('Lifecycle action to perform.'),
      packageName: z
        .string()
        .optional()
        .describe('Android package name or iOS bundle identifier. Required for terminate, clear_data, query_state; optional Android handler hint for deep_link.'),
      url: z.string().optional().describe('URL or URI scheme for deep_link, e.g. "myapp://orders/42" or "https://...".'),
    },
    async (args) => {
      try {
        const result = await appControl(args.handle, args.action, args.packageName, args.url);
        return { content: [{ type: 'text' as const, text: `✅ ${result}` }] };
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `Error (${args.action}): ${(e as Error).message}` }], isError: true };
      }
    }
  );

  // ── device_control ────────────────────────────────────────────────────────
  server.tool(
    'device_control',
    'Device-level controls for an inspection session: orientation (get/set — rotation testing), clipboard (get/set — paste flows), ' +
    'geolocation (set/reset — location-based features), alerts (accept/dismiss — system dialogs, Appium Server only), ' +
    'and file transfer (push_file/pull_file — test fixtures like images for upload flows). ' +
    'Grid session limits: alerts and reset_geolocation are not supported, and iOS Grid devices reject clipboard ops ' +
    '(clear errors explain alternatives). iOS file paths may require the @bundleId:container syntax.',
    {
      handle: z.string().describe('Session handle from start_inspection_session.'),
      action: z
        .enum(['get_orientation', 'set_orientation', 'get_clipboard', 'set_clipboard', 'set_geolocation', 'reset_geolocation', 'accept_alert', 'dismiss_alert', 'push_file', 'pull_file'])
        .describe('Device action to perform.'),
      orientation: z.enum(['PORTRAIT', 'LANDSCAPE']).optional().describe('For set_orientation.'),
      text: z.string().optional().describe('For set_clipboard: the text to place on the clipboard.'),
      latitude: z.number().optional().describe('For set_geolocation.'),
      longitude: z.number().optional().describe('For set_geolocation.'),
      remotePath: z.string().optional().describe('For push_file/pull_file: absolute device path, e.g. "/sdcard/Download/fixture.png".'),
      localPath: z.string().optional().describe('For push_file (source) / pull_file (destination): local file path visible to the MCP server process (volume-mount when running in Docker).'),
    },
    async (args) => {
      try {
        switch (args.action) {
          case 'get_orientation': {
            const o = await getOrientation(args.handle);
            return { content: [{ type: 'text' as const, text: `Orientation: ${o}` }] };
          }
          case 'set_orientation': {
            if (!args.orientation) return { content: [{ type: 'text' as const, text: 'Error: set_orientation requires orientation.' }], isError: true };
            await setOrientation(args.handle, args.orientation);
            return { content: [{ type: 'text' as const, text: `✅ Orientation set to ${args.orientation}.\n\nCall take_inspection_screenshot to verify the layout.` }] };
          }
          case 'get_clipboard': {
            const text = await getClipboard(args.handle);
            return { content: [{ type: 'text' as const, text: text ? `Clipboard: "${text}"` : 'Clipboard is empty.' }] };
          }
          case 'set_clipboard': {
            if (args.text == null) return { content: [{ type: 'text' as const, text: 'Error: set_clipboard requires text.' }], isError: true };
            await setClipboard(args.handle, args.text);
            return { content: [{ type: 'text' as const, text: `✅ Clipboard set (${args.text.length} chars). Long-press an input field to paste.` }] };
          }
          case 'set_geolocation': {
            if (args.latitude == null || args.longitude == null) {
              return { content: [{ type: 'text' as const, text: 'Error: set_geolocation requires latitude and longitude.' }], isError: true };
            }
            await setGeolocation(args.handle, args.latitude, args.longitude);
            return { content: [{ type: 'text' as const, text: `✅ Location set to ${args.latitude}, ${args.longitude}.` }] };
          }
          case 'reset_geolocation': {
            await resetGeolocation(args.handle);
            return { content: [{ type: 'text' as const, text: '✅ Simulated location cleared — device uses its real location again.' }] };
          }
          case 'accept_alert':
          case 'dismiss_alert': {
            await handleAlert(args.handle, args.action === 'accept_alert' ? 'accept' : 'dismiss');
            return { content: [{ type: 'text' as const, text: `✅ Alert ${args.action === 'accept_alert' ? 'accepted' : 'dismissed'}.` }] };
          }
          case 'push_file': {
            if (!args.remotePath || !args.localPath) {
              return { content: [{ type: 'text' as const, text: 'Error: push_file requires remotePath and localPath.' }], isError: true };
            }
            const inputError = validateInputPath(args.localPath);
            if (inputError) return { content: [{ type: 'text' as const, text: inputError }], isError: true };
            const data = readFileSync(args.localPath).toString('base64');
            await pushFileToDevice(args.handle, args.remotePath, data);
            return { content: [{ type: 'text' as const, text: `✅ Pushed ${args.localPath} → ${args.remotePath} (${Math.round(data.length * 0.75)} bytes).` }] };
          }
          case 'pull_file': {
            if (!args.remotePath || !args.localPath) {
              return { content: [{ type: 'text' as const, text: 'Error: pull_file requires remotePath and localPath.' }], isError: true };
            }
            const outputError = validateOutputPath(args.localPath);
            if (outputError) return { content: [{ type: 'text' as const, text: outputError }], isError: true };
            const b64 = await pullFileFromDevice(args.handle, args.remotePath);
            const buf = Buffer.from(b64, 'base64');
            writeFileSync(args.localPath, buf);
            return { content: [{ type: 'text' as const, text: `✅ Pulled ${args.remotePath} → ${args.localPath} (${buf.length} bytes).` }] };
          }
        }
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `Error (${args.action}): ${(e as Error).message}` }], isError: true };
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
