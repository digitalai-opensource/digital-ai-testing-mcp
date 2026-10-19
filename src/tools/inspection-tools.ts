import { z } from 'zod';
import { caseInsensitiveEnum } from '../utils/schema.js';
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
  mockAuthentication,
  requireSession,
  findFirstElementId,
  listActiveSessions,
  getPendingReportIds,
  sweepTimedOutStarts,
  deleteAllTrackedReports,
  automotiveControl,
  audioControl,
  AUTOMOTIVE_RESOLUTIONS,
  INSTRUMENT_CLUSTER_CONTENT,
  getForegroundActivity,
  isSameActivity,
  listContexts,
  switchContext,
  getDeviceLog,
  getAlertInfo,
  isWebviewContext,
  sessionCapture,
  networkConnection,
  setNetworkConditions,
  injectCameraImage,
  clearWebCache,
  deviceDiagnostics,
  setAppearance,
  accessibilityAudit
} from '../api/webdriver.js';
import type { InspectionSession } from '../types/digital-ai.js';
import { checkDestructiveGuard } from '../utils/destructive-guard.js';
import { getActiveUrl } from '../api/client.js';
import { checkDeleteAllowed } from '../api/access-level.js';
import { resolveDevice } from '../utils/device-resolver.js';
import { getAllDevices } from '../api/devices.js';
import { listFiles } from '../api/repository.js';
import { validateInputPath, validateOutputPath } from '../utils/path-guard.js';
import { readFileSync, writeFileSync } from 'fs';
import { getDeploymentMode } from '../utils/deployment-mode.js';

// '-ios predicate string' is XCUITest's NSPredicate locator (e.g. "type == 'XCUIElementTypeButton' AND label == 'Login'")
// — faster and less brittle than xpath on iOS, and the form the Mobile Studio iOS Test Recorder emits. iOS on Appium
// Server only: the Appium Grid rejects it ("Locator Strategy '-ios predicate string' is not supported for this
// session", verified live 2026-10-09 on an iPhone 13 Pro Max) — use xpath or accessibility id there.
const LOCATOR_STRATEGIES = ['xpath', 'id', 'accessibility id', 'class name', '-ios predicate string', 'css selector'] as const;
type LocatorStrategy = (typeof LOCATOR_STRATEGIES)[number];

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Returns an error result if the session is a browser (web) session — used to
// guard mobile-only tools so they produce a clear message instead of a protocol error.
function requireMobileSession(
  handle: string,
  toolName: string
): { content: [{ type: 'text'; text: string }]; isError: true } | null {
  try {
    const session = requireSession(handle);
    if (session.platform === 'web') {
      return {
        content: [{
          type: 'text' as const,
          text:
            `"${toolName}" is for mobile sessions only (Android/iOS). ` +
            `For browser sessions use: navigate_to (instead of launch_app), ` +
            `browser_action("back") (instead of press_back/app_control), ` +
            `find_web_elements + tap_element/type_into_element for interactions. ` +
            `Gestures (pinch_zoom, press_key, hide_keyboard) and device_control are not available in browser sessions.`,
        }],
        isError: true,
      };
    }
  } catch {
    // requireSession will throw a "no active session" error — let the tool itself handle it
  }
  return null;
}

function sessionSummary(s: InspectionSession): string {
  const age = Math.round((Date.now() - s.startedAt) / 1000);
  const idle = Math.round((Date.now() - s.lastUsedAt) / 1000);
  const idleWarning = idle > 180 ? ' ⚠️ likely expired (Grid idle timeout ~4 min)' : '';
  return (
    `Handle:   ${s.handle}\n` +
    `Device:   ${s.deviceName} (${s.deviceOs} ${s.deviceVersion})\n` +
    `App:      ${s.appPackage || '(none)'}\n` +
    `Age:      ${age}s | Idle: ${idle}s${idleWarning}\n` +
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
    lines.push('', "Locate iOS elements with: strategy 'accessibility id' (matches name), xpath like //*[@label='...'] or //XCUIElementTypeButton, or on Appium Server projects '-ios predicate string' like \"label == '...'\".");
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
    'Returns a session handle used by all other inspection tools, plus a viewUrl — ' +
    'SHARE THE VIEW URL WITH THE USER IMMEDIATELY so they can watch the session live (read-only). ' +
    'Do NOT share the cloudViewLink — a second connection to the same device will conflict and error. ' +
    'Session creation takes 20-90 s while a device is allocated.\n\n' +
    'MODE: Use INTERACTIVE (this tool + collaborative_test_creation prompt) when the request is vague, ' +
    'the user wants to watch/drive, or exploration signals appear ("let\'s see what\'s there"). ' +
    'Use AUTONOMOUS (silent session to capture element IDs → get_test_boilerplate) when intent is specific and selectors are needed. ' +
    'NEVER fabricate selectors — get them from a live session or workspace source. ' +
    'If unsure: ask "Build it for you, or work through it together?"\n\n' +
    'WORKFLOW: list_applications (confirm version) → find_available_device (note region) → ' +
    'install_application (MUST be before session — fails while device is reserved) → ' +
    'start_inspection_session(device=<id>) → launch_app → get_element_tree/find_elements → interact → stop_inspection_session.\n\n' +
    'iOS NOTES: elements located by name/label/value (not resource-id); ' +
    'press_back performs left-edge swipe; clipboard and clear_data unavailable on Grid iOS.\n\n' +
    'AUTOMOTIVE: for Android Auto (Android phones) / CarPlay (iPhones) projection testing either pass automotiveProjection ' +
    '(projection runs for the whole session) or start a normal session and use automotive_control start/stop. ' +
    "For an Android Automotive OS emulator (the head unit IS the device — no projection) use deviceQuery \"@os='android' and @emulator='true' and @model='automotive_1024p_landscape'\" — " +
    "@emulator='true' is REQUIRED (the model alone times out) — and drive it with the normal inspection tools.\n\n" +
    'KNOWN LIMITATIONS: app/appPackage/appActivity params may return HTTP 500 — start a generic session and use launch_app instead. ' +
    'Use the device param (not hand-written deviceQuery) to target a specific device reliably.\n\n' +
    'Always call stop_inspection_session when done — open sessions consume a reserved device and create a reporter record. ' +
    'Use cleanup_inspection_sessions for abandoned sessions.',
    {
      platform: caseInsensitiveEnum(['android', 'ios'], { default: 'android' })
        .describe("Target platform. Default 'android'. Sets platformName and the default deviceQuery @os."),
      device: z
        .string()
        .optional()
        .describe(
          'PIN the session to a specific device — numeric platform ID, serial/UDID, or unambiguous device name. ' +
          'Use this to get the SAME device you selected with find_available_device and installed the app on ' +
          '(without it, the Grid picks any matching device and your install may land elsewhere). ' +
          'Confirmed working — resolves to an @serialNumber query. Overrides deviceQuery and region.'
        ),
      deviceQuery: z
        .string()
        .optional()
        .describe(
          "Server-side device query. Default: \"@os='android' and @category='PHONE'\" (or @os='iOS' when platform is ios). " +
          "Add @region, @model, @version as needed. Example: \"@os='android' and @category='PHONE' and @model='Pixel 7'\". " +
          'Max 255 characters including the region clause (platform limit — longer queries are refused before any call). ' +
          "With @emulator='true' the start waits up to 240 s (virtual devices boot inside the request). " +
          'Ignored when device is provided.'
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
        .describe(
          'If false, clears app data before launching. Default true — which means an app that was already running on the ' +
          'device RESUMES ON ITS LAST SCREEN, not on appActivity. The response reports currentActivity and a screenNote when ' +
          'they differ; pass noReset: false to replay a flow from its first screen.'
        ),
      testName: z
        .string()
        .optional()
        .describe("Name shown in the Digital.ai reporter for this inspection session. Default: '[MCP Inspection]'."),
      automotiveProjection: z
        .enum(AUTOMOTIVE_RESOLUTIONS)
        .optional()
        .describe(
          'Start the session with Android Auto (Android) / CarPlay (iOS) projection on, at this head-unit resolution. ' +
          'CarPlay supports 800x480 only. Projection then stays on for the whole session — automotive_control start/stop are refused; ' +
          'omit this and use automotive_control start instead to toggle projection mid-session. Appium Server projects only — ' +
          'an Appium Grid session accepts the capability but every projection command fails (verified). The device must also be ' +
          'attached to an Apple Silicon device host; on other devices session creation fails with a message saying so.'
        ),
      instrumentCluster: z
        .enum(INSTRUMENT_CLUSTER_CONTENT)
        .optional()
        .describe('iOS CarPlay only, with automotiveProjection: content for the instrument cluster display.'),
    },
    async (args) => {
      if (args.instrumentCluster && (args.platform !== 'ios' || !args.automotiveProjection)) {
        return { content: [{ type: 'text' as const, text: 'Error: instrumentCluster is CarPlay-only — it needs platform "ios" and automotiveProjection.' }], isError: true };
      }
      if (args.platform === 'ios' && args.automotiveProjection && args.automotiveProjection !== '800x480') {
        return { content: [{ type: 'text' as const, text: 'Error: CarPlay supports automotiveProjection "800x480" only.' }], isError: true };
      }
      try {
        // Device pinning: resolve to the serial and use an exact @serialNumber query
        // (confirmed live — routes to the requested device). Fail fast when the
        // device is not Available instead of burning a 120 s allocation timeout.
        let pinnedQuery: string | undefined;
        if (args.device) {
          let resolved = await resolveDevice(args.device);
          if (!resolved.udid) {
            // Numeric-ID passthrough skips the lookup — fetch the record for serial + status.
            const match = (await getAllDevices()).find((d) => d.id === resolved.id);
            if (!match) {
              return {
                content: [{ type: 'text' as const, text: `Error: no device found with ID ${resolved.id}. Use list_devices to browse.` }],
                isError: true,
              };
            }
            resolved = { ...resolved, udid: match.udid, deviceName: match.deviceName, displayStatus: match.displayStatus };
          }
          if (resolved.displayStatus.toLowerCase() !== 'available' && resolved.displayStatus !== 'unknown') {
            return {
              content: [{
                type: 'text' as const,
                text: `Error: device ${resolved.deviceName} is "${resolved.displayStatus}", not Available — the session would time out waiting for it. Pick another device with find_available_device, or wait for it to free up.`,
              }],
              isError: true,
            };
          }
          pinnedQuery = `@serialNumber='${resolved.udid}'`;
        }

        const session = await createInspectionSession({
          platform: args.platform ?? 'android',
          deviceQuery: pinnedQuery ?? args.deviceQuery,
          region: pinnedQuery ? undefined : args.region,
          app: args.app,
          appPackage: args.appPackage,
          appActivity: args.appActivity,
          noReset: args.noReset ?? true,
          testName: args.testName,
          automotiveProjection: args.automotiveProjection,
          instrumentCluster: args.instrumentCluster,
        });

        // Resolve the numeric platform device ID from the UDID so the user-facing
        // view URL can be emitted without a follow-up list_devices call.
        // Note: the debug URL (/3) is intentionally NOT generated — the device is
        // already reserved by this WebDriver session, and opening a second interactive
        // connection causes a conflict error.
        let deviceId: string | null = null;
        let viewUrl: string | null = null;
        if (session.deviceUDID) {
          try {
            const resolved = await resolveDevice(session.deviceUDID);
            deviceId = resolved.id;
            const base = getActiveUrl().replace(/\/+$/, '');
            viewUrl = `${base}/#/open/device/${deviceId}/1`;
          } catch {
            // Non-fatal — session is usable without the URL
          }
        }

        // Android app sessions: say which screen is actually in front. With noReset (the default) a running app resumes
        // where it was, so the caller's appActivity is a request, not a guarantee (remediation note 2026-10-14).
        let currentActivity: string | null = null;
        let screenNote: string | undefined;
        if (session.platform === 'android' && (args.app || args.appPackage)) {
          currentActivity = await getForegroundActivity(session.handle);
          if (currentActivity && args.appActivity && !isSameActivity(args.appActivity, currentActivity)) {
            screenNote =
              `The app is showing "${currentActivity}", not the requested "${args.appActivity}": noReset is ${args.noReset ?? true}, so a running app ` +
              'resumed on its last screen. Call get_element_tree before acting on this screen, or stop and start again with noReset: false ' +
              'to begin from the first screen.';
          } else if (!currentActivity) {
            screenNote = 'Could not read the foreground activity — call get_element_tree before assuming which screen is showing.';
          }
        }

        const structured: Record<string, unknown> = {
          handle: session.handle,
          platform: session.platform,
          ...(currentActivity !== null ? { currentActivity } : {}),
          ...(screenNote ? { screenNote } : {}),
          device: {
            id: deviceId,
            name: session.deviceName,
            model: session.deviceModel,
            os: session.deviceOs,
            version: session.deviceVersion,
            udid: session.deviceUDID,
          },
          appPackage: session.appPackage,
          ...(args.automotiveProjection ? { automotiveProjection: args.automotiveProjection } : {}),
          viewUrl,
          cloudViewLink: session.cloudViewLink,
          reportUrl: session.reportUrl,
          idleTimeoutNote:
            'Grid sessions expire after ~4 minutes without a command. Before pausing to ask the user something, ' +
            'call take_inspection_screenshot — it resets the idle clock AND captures the state you are asking about. ' +
            'If the user takes longer than ~4 minutes, expect a 404 on your next call: stop_inspection_session to clean up, ' +
            'start a fresh session, and re-find elements (your noted selectors stay valid; raw elementIds do not survive sessions).',
          shareWithUser: viewUrl
            ? `Share this URL with the user immediately so they can watch the session live (read-only): ${viewUrl}`
            : null,
        };

        if (!session.canDeleteReport) {
          structured.authWarning =
            'Report cleanup unavailable: the active credential is a project-level role and this project\'s allowUsersDeleteTests ' +
            'setting is off, so the platform refuses reporter deletes (403 "You have no permission to delete tests"). Inspection ' +
            'session reports will NOT be automatically deleted. Ask a Cloud Admin to enable allowUsersDeleteTests for the project, ' +
            'delete them from the Digital.ai reporter UI, or switch to a Cloud Admin profile before using inspection sessions.';
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
    'Always call this when done inspecting — open sessions hold a reserved device.\n\n' +
    'STEP CONFIRMATION GATE — when building a test interactively, NEVER call this tool (and NEVER call ' +
    'get_test_boilerplate) until the user explicitly confirms all test steps are captured. A single completed ' +
    'scenario does NOT mean the test is done. After each scenario, surface what was captured and ask: ' +
    '"I\'ve captured [description of step]. Want to add another step — for example a success path, a failure ' +
    'path, navigation to another screen, or a different scenario — or are you ready to generate the script?" ' +
    'WAIT for the answer before proceeding. Language like "let\'s start with...", "first...", or "begin by..." ' +
    'is an explicit signal that more steps are planned — NEVER finalize after only the first step when these ' +
    'phrases were used. Keep the session alive between steps: call take_inspection_screenshot periodically ' +
    'if the user is thinking (resets the idle clock without moving to the next phase).',
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
        const { reportDeleted, reportKept, canDeleteReport, reportTestId, reportUrl, reportDeleteError } =
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
        } else if (reportDeleteError && reportTestId > 0) {
          text =
            `✅ Session ${args.handle} stopped. Device released.

` +
            `⚠️  Report NOT deleted (test_id=${reportTestId}): ${reportDeleteError}. Report: ${reportUrl}`;
        } else if (!canDeleteReport && reportTestId > 0) {
          text =
            `✅ Session ${args.handle} stopped. Device released.\n\n` +
            `⚠️  Report NOT deleted (test_id=${reportTestId}): the active credential is a project-level role and this project's ` +
            `allowUsersDeleteTests setting is off, so the platform refuses reporter deletes. Ask a Cloud Admin to enable it, delete the ` +
            `report from the Digital.ai reporter UI, or switch to a Cloud Admin profile before running inspection sessions.`;
        } else {
          text = `✅ Session ${args.handle} stopped. Device released.`;
        }

        text +=
          '\n\n📌 If you have the View URL open in a browser, please close that tab now — ' +
          'the device has been released but the browser session may still appear connected.';

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

  // ── automotive_control ────────────────────────────────────────────────────
  server.tool(
    'automotive_control',
    'Android Auto / CarPlay projection in an inspection session: the phone\'s apps rendered on a car head unit. ' +
    'Actions: "start" (turn projection on at a resolution, ~20 s), "stop", "screenshot" (returns the head-unit image; ' +
    'display "cluster" = CarPlay instrument cluster), "tap" (x, y in head-unit coordinates, e.g. 0–800 × 0–480), ' +
    '"dump" (CarPlay element dump — iOS only, the platform does not implement it for Android). ' +
    'Projection needs a device attached to an Apple Silicon device host — not every device in the farm qualifies. ' +
    'Projection does not stop normal control: tap_element / take_inspection_screenshot keep working on the phone itself. ' +
    'Sessions started with automotiveProjection keep projection on for their whole lifetime (start/stop are refused) — PREFER that: ' +
    'mid-session start is not supported on every device (a Galaxy S10 / Android 12 rejects it but projects fine via the capability). ' +
    'The phone side may need Android Auto setup completed by the device admin before apps appear on the head unit. ' +
    'Not for Android Automotive OS emulators — there the head unit IS the device; use the normal inspection tools. ' +
    'Verified on Appium Server Android phones (start/stop/screenshot/tap); CarPlay-only actions follow the platform docs. ' +
    'CarPlay (iOS): the platform allows ONE start per session, even after a failed attempt — after a failed start, stop the ' +
    'session and begin a new one. The first CarPlay connection on a phone shows an iOS consent dialog ("Allow CarPlay with ' +
    '\'CarPlay Simulator\' while phone is locked?") — take_inspection_screenshot and tap Allow, then retry in a new session. ' +
    'A "deadline exceeded" error after that means the device host\'s projection service is not responding (report the host). ' +
    'NOT supported on Appium Grid projects (verified: the Grid runs these commands as JavaScript and every one fails).',
    {
      handle: z.string().describe('Session handle from start_inspection_session.'),
      action: z.enum(['start', 'stop', 'screenshot', 'tap', 'dump']).describe('What to do.'),
      resolution: z
        .enum(AUTOMOTIVE_RESOLUTIONS)
        .optional()
        .describe('start only. Head-unit resolution, default 800x480. Android Auto supports all three; CarPlay 800x480 only.'),
      clusterContent: z
        .enum(INSTRUMENT_CLUSTER_CONTENT)
        .optional()
        .describe('start only, CarPlay (iOS) only: instrument cluster content.'),
      x: z.number().int().min(0).optional().describe('tap only: x in head-unit coordinates.'),
      y: z.number().int().min(0).optional().describe('tap only: y in head-unit coordinates.'),
      display: z
        .enum(['main', 'cluster'])
        .optional()
        .describe('screenshot only: "main" (default) or "cluster" (CarPlay instrument cluster).'),
    },
    async (args) => {
      try {
        const out = await automotiveControl(args.handle, args.action, {
          resolution: args.resolution,
          clusterContent: args.clusterContent,
          x: args.x,
          y: args.y,
          display: args.display,
        });
        const content: Array<{ type: 'image'; data: string; mimeType: string } | { type: 'text'; text: string }> = [];
        if (out.image) content.push({ type: 'image' as const, data: out.image.data, mimeType: out.image.mimeType });
        content.push({ type: 'text' as const, text: out.dump ? `${out.message}\n\n${out.dump}` : out.message });
        return { content };
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  // ── audio_control ─────────────────────────────────────────────────────────
  server.tool(
    'audio_control',
    'Play audio into, or record audio from, the device in an inspection session — for voice assistants, calls, media and ' +
    'speech features. Actions: "play" (a repository audio file into the device\'s audio INPUT; with durationSeconds it plays, ' +
    'waits and stops), "stop_play", "record_start" (captures the device\'s audio OUTPUT into a new repository file), ' +
    '"record_stop" (returns the saved file; download_repository_file fetches it). ' +
    'Needs a device with an audio line — pick one with find_available_device(requireAudioLine: true); others fail with ' +
    '"Audio line is not configured". A recording is EMPTY (header only, reported as headerOnly) when the device played no ' +
    'sound while recording. Appium Server projects only (the Grid cannot run the stop commands). ' +
    'For a two-phone call / SMS / MMS test, start from the reference project https://github.com/dai-continuous-testing/UseCase-SIM-Card-Tests.',
    {
      handle: z.string().describe('Session handle from start_inspection_session.'),
      action: z.enum(['play', 'stop_play', 'record_start', 'record_stop']).describe('What to do.'),
      file: z.string().optional().describe('play only: uniqueName of an audio file in the project repository (list_repository_files), e.g. "greeting.wav".'),
      // The call sleeps for the duration — keep it inside the ~60 s MCP client timeout.
      durationSeconds: z.number().int().min(1).max(45).optional().describe('play only: play for this long (max 45 s, so the call finishes inside the client timeout), then stop. For longer clips call play, then stop_play.'),
      recordingName: z
        .string()
        .regex(/^[\w.-]{1,100}$/, 'Letters, digits, _ . - only.')
        .optional()
        .describe('record_start only: repository name for the recording. Default: a unique mcp-recording-<handle>-<time>.wav.'),
    },
    async (args) => {
      try {
        const out = await audioControl(args.handle, args.action, { file: args.file, durationSeconds: args.durationSeconds, recordingName: args.recordingName }, {
          findRepositoryFile: async (uniqueName, projectName) => (await listFiles({ uniqueName, projectName }))[0],
        });
        const content = [{ type: 'text' as const, text: out.message }];
        if (out.recording) content.push({ type: 'text' as const, text: JSON.stringify({ recording: out.recording }) });
        return { content };
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `Error: ${(e as Error).message}` }], isError: true };
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
      const mobileErr = requireMobileSession(args.handle, 'get_element_tree');
      if (mobileErr) return { ...mobileErr, content: [{ type: 'text' as const, text: `"get_element_tree" is for mobile sessions only. For browser sessions use get_page_dom to inspect the rendered DOM.` }] };
      try {
        const sess = requireSession(args.handle);
        const platform = sess.platform as 'android' | 'ios';
        const xml = await getPageSource(args.handle);
        if (isWebviewContext(sess)) {
          const html = xml.length > 12000 ? xml.slice(0, 12000) + '\n... (truncated)' : xml;
          return { content: [{ type: 'text' as const, text: `Session is in web context ${sess.currentContext} — the page source is HTML (${xml.length} chars), not a native tree. Locate with find_elements(strategy: "css selector") or xpath; switch back with webview_context(action: "native").\n\n${html}` }] };
        }
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
    'Strategies: "id" (Android resource-id, fastest), "accessibility id" (Android content-desc; on iOS it IS the name ' +
    'attribute — identifier, else label — so it matches exactly what //*[@name=\'x\'] matches, without walking the tree; ' +
    'works on the Grid too), "-ios predicate string" (iOS on Appium Server projects only — NSPredicate such as ' +
    '"type == \'XCUIElementTypeButton\' AND label == \'Login\'"; the Appium Grid rejects it), "class name" (by widget ' +
    'type, often returns many), "xpath" (most flexible, slowest — attribute matches only, never positional [1]/[2]), ' +
    '"css selector" (ONLY inside a WEBVIEW context — see webview_context). ' +
    'Prefer them in that order and copy the strategy you used into the generated test. Attributes are fetched for the first ' +
    'maxResults matches (default 20); the rest are listed by elementId — narrow the selector rather than raising it.',
    {
      handle: z
        .string()
        .describe("Session handle from start_inspection_session."),
      strategy: z
        .enum(LOCATOR_STRATEGIES)
        .describe(
          "Locator strategy. 'id' matches resource-id (e.g. 'com.example:id/login'). " +
          "'accessibility id' matches content-desc. " +
          "'xpath' supports complex expressions like '//android.widget.EditText[@text=\"Username\"]'."
        ),
      selector: z
        .string()
        .describe("The locator value. Examples: 'com.example:id/login', '//android.widget.Button[@text=\"Submit\"]'."),
      maxResults: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe(
          'Fetch attributes for at most this many matches (default 20). Every match is still returned by elementId; ' +
          'each detailed element costs ~8 requests, so prefer a narrower selector over a large value.'
        ),
    },
    async (args) => {
      try {
        const elements = await findElements(args.handle, args.strategy, args.selector, { maxEnriched: args.maxResults ?? 20 });

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

        const detailed = elements.filter((e) => e.enriched !== false);
        const idsOnly = elements.length - detailed.length;
        for (let i = 0; i < detailed.length; i++) {
          const e = detailed[i];
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
          if (e.hittable != null) lines.push(`  hittable:     ${e.hittable}${e.hittable ? '' : ' (visible but not on the hit-test path — a tap may land on what covers it)'}`);
          lines.push(`  enabled:      ${e.enabled ?? 'unknown'}`);
          lines.push('');
        }

        if (idsOnly > 0) {
          lines.push(
            `Attributes shown for ${detailed.length} of ${elements.length} (cap ${args.maxResults ?? 20} or the time budget). ` +
              `Remaining elementIds, in order (still usable with tap_element etc.):`,
            ...elements.slice(detailed.length).map((e, i) => `  ${detailed.length + i + 1}. ${e.elementId}`),
            '',
            'Narrow the selector to see their attributes (e.g. a predicate/xpath on label or text), or raise maxResults.',
            ''
          );
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
          content: [{
            type: 'text' as const,
            text:
              `Error finding elements: ${(e as Error).message}` +
              (args.strategy === '-ios predicate string' && /not supported/i.test((e as Error).message)
                ? '\n\nThis session is on the Appium Grid, which does not support iOS predicates. Use xpath (e.g. ' +
                  '//XCUIElementTypeButton[@label=\'Login\']) or accessibility id instead.'
                : ''),
          }],
          isError: true,
        };
      }
    }
  );

  // ── Resolve elementId-or-selector args shared by tap/type/clear ──────────
  const resolveTargetElement = async (args: {
    handle: string;
    elementId?: string;
    strategy?: LocatorStrategy;
    selector?: string;
  }): Promise<{ elementId: string } | { error: string }> => {
    if (args.elementId) return { elementId: args.elementId };
    if (args.strategy && args.selector) {
      const found = await findFirstElementId(args.handle, args.strategy, args.selector);
      if (!found) {
        return { error: `No element found matching ${args.strategy}: "${args.selector}". Check the locator with get_element_tree.` };
      }
      return { elementId: found };
    }
    return { error: 'Provide either elementId (from find_elements) or strategy + selector to locate the element directly.' };
  };

  const targetParams = {
    handle: z.string().describe('Session handle from start_inspection_session.'),
    elementId: z
      .string()
      .optional()
      .describe('Element ID from a previous find_elements call. Provide this OR strategy+selector.'),
    strategy: z
      .enum(LOCATOR_STRATEGIES)
      .optional()
      .describe('Locator strategy for direct one-call targeting (the find happens internally — no separate find_elements round trip needed).'),
    selector: z
      .string()
      .optional()
      .describe("Locator value for direct targeting, e.g. 'com.example:id/login' or '//XCUIElementTypeButton[@label=\"Sign In\"]'. First match is used."),
  };

  // ── tap_element ───────────────────────────────────────────────────────────
  server.tool(
    'tap_element',
    'Tap (click) an element on the device screen. ' +
    'Target it directly with strategy + selector (one call — the find happens internally), ' +
    'or pass an elementId from a previous find_elements call. ' +
    'After tapping, call take_inspection_screenshot to verify the result.',
    { ...targetParams },
    async (args) => {
      try {
        const target = await resolveTargetElement(args);
        if ('error' in target) {
          return { content: [{ type: 'text' as const, text: `Error: ${target.error}` }], isError: true };
        }
        await tapElement(args.handle, target.elementId);
        const via = args.elementId ? `element ${args.elementId}` : `${args.strategy}: "${args.selector}"`;
        return {
          content: [
            {
              type: 'text' as const,
              text: `✅ Tapped ${via}.\n\nCall take_inspection_screenshot to verify the result.`,
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
    'Target the field directly with strategy + selector (one call — the find happens internally), ' +
    'or pass an elementId from a previous find_elements call. ' +
    'For fields that need clearing first, call clear_element before typing.',
    {
      ...targetParams,
      text: z
        .string()
        .describe("Text to type into the field."),
    },
    async (args) => {
      try {
        const target = await resolveTargetElement(args);
        if ('error' in target) {
          return { content: [{ type: 'text' as const, text: `Error: ${target.error}` }], isError: true };
        }
        await typeIntoElement(args.handle, target.elementId, args.text);
        const via = args.elementId ? `element ${args.elementId}` : `${args.strategy}: "${args.selector}"`;
        return {
          content: [
            {
              type: 'text' as const,
              text: `✅ Typed "${args.text}" into ${via}.`,
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
    'Clear the text content of an input field. Use before type_into_element when the field already has content. ' +
    'Target it directly with strategy + selector, or pass an elementId from find_elements.',
    { ...targetParams },
    async (args) => {
      try {
        const target = await resolveTargetElement(args);
        if ('error' in target) {
          return { content: [{ type: 'text' as const, text: `Error: ${target.error}` }], isError: true };
        }
        await clearElement(args.handle, target.elementId);
        const via = args.elementId ? `element ${args.elementId}` : `${args.strategy}: "${args.selector}"`;
        return {
          content: [{ type: 'text' as const, text: `✅ Cleared ${via}.` }],
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
      const mobileErr = requireMobileSession(args.handle, 'launch_app');
      if (mobileErr) return mobileErr;
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
      const mobileErr = requireMobileSession(args.handle, 'press_back');
      if (mobileErr) return mobileErr;
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
      const mobileErr = requireMobileSession(args.handle, 'pinch_zoom');
      if (mobileErr) return mobileErr;
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
        .enum(LOCATOR_STRATEGIES)
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
    'iOS: HOME, VOLUME_UP, VOLUME_DOWN, POWER (physical buttons only — for ENTER type "\\n" via type_into_element; ' +
    'POWER toggles the lock: it locks an unlocked device and unlocks a locked one). ' +
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
      const mobileErr = requireMobileSession(args.handle, 'press_key');
      if (mobileErr) return mobileErr;
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
      const mobileErr = requireMobileSession(args.handle, 'hide_keyboard');
      if (mobileErr) return mobileErr;
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
    'deep_link (open a URL/URI directly — skip navigation to the screen under test), ' +
    'background (send the app to the background for `seconds` and bring it back — lifecycle/resume testing), ' +
    'is_installed (true/false for packageName), current (what is in the foreground: Android package + activity, iOS bundle id), ' +
    'install (install a repository build mid-session from appRef "cloud:<package or bundle>" / "cloud:uniqueName=<name>" — Appium Server only; ' +
    'this lifts the "install before the session" rule for Appium Server projects), ' +
    'clear_web_cache (seetest:client.hybridClearCache — drops the cache of the app\'s webviews; both modes). ' +
    'NOTE on Grid sessions: query_state/current report only the foreground activity (Android) or are unavailable (iOS); deep_link is best-effort; ' +
    'background, is_installed and install are Appium Server only. To relaunch after terminate, use launch_app.',
    {
      handle: z.string().describe('Session handle from start_inspection_session.'),
      action: z
        .enum(['terminate', 'clear_data', 'query_state', 'deep_link', 'background', 'is_installed', 'current', 'install', 'clear_web_cache'])
        .describe('Lifecycle action to perform.'),
      packageName: z
        .string()
        .optional()
        .describe('Android package name or iOS bundle identifier. Required for terminate, clear_data, query_state, is_installed; optional Android handler hint for deep_link.'),
      url: z.string().optional().describe('URL or URI scheme for deep_link, e.g. "myapp://orders/42" or "https://...".'),
      seconds: z.number().int().min(1).max(300).optional().describe('For background: how long to keep the app in the background. Default 3.'),
      appRef: z.string().optional().describe('For install: repository reference — "cloud:com.example.app" (Android may add "/.MainActivity"), "cloud:uniqueName=<name>", or "cloud:<package>:releaseVersion=<v>:buildVersion=<b>".'),
    },
    async (args) => {
      const mobileErr = requireMobileSession(args.handle, 'app_control');
      if (mobileErr) return mobileErr;
      try {
        if (args.action === 'clear_web_cache') {
          await clearWebCache(args.handle);
          return { content: [{ type: 'text' as const, text: '✅ Webview cache cleared (hybridClearCache).' }] };
        }
        const result = await appControl(args.handle, args.action, args.packageName, args.url, { seconds: args.seconds, appRef: args.appRef });
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
    'geolocation (set/reset — location-based features), alerts (get_alert reads the text and, on iOS, the button labels; ' +
    'accept/dismiss — system dialogs, Appium Server only; iOS accept/dismiss take buttonLabel to press a specific button), ' +
    'file transfer (push_file/pull_file — test fixtures like images for upload flows), ' +
    'device_info (one call: model, OS/API level, locale, time zone, battery, screen size/scale, system bars, lock state, ' +
    'light/dark appearance — Appium Server), set_appearance (style dark|light: iOS appearance / Android night mode — ' +
    'dark-mode screenshot checks), accessibility_audit (iOS: XCTest\'s built-in audit of the current screen, no extra ' +
    'dependency; Android: use includeAxeScan in get_test_boilerplate). ' +
    'Grid session limits: alerts and reset_geolocation are not supported, and iOS Grid devices reject clipboard ops ' +
    '(clear errors explain alternatives). iOS file paths may require the @bundleId:container syntax.',
    {
      handle: z.string().describe('Session handle from start_inspection_session.'),
      action: z
        .enum(['get_orientation', 'set_orientation', 'get_clipboard', 'set_clipboard', 'set_geolocation', 'reset_geolocation', 'get_alert', 'accept_alert', 'dismiss_alert', 'push_file', 'pull_file', 'device_info', 'set_appearance', 'accessibility_audit'])
        .describe('Device action to perform.'),
      orientation: z.enum(['PORTRAIT', 'LANDSCAPE']).optional().describe('For set_orientation.'),
      style: z.enum(['dark', 'light']).optional().describe('For set_appearance.'),
      text: z.string().optional().describe('For set_clipboard: the text to place on the clipboard.'),
      buttonLabel: z.string().optional().describe('For accept_alert / dismiss_alert on iOS: the exact button label to press (from get_alert), e.g. "Allow Once".'),
      latitude: z.number().optional().describe('For set_geolocation.'),
      longitude: z.number().optional().describe('For set_geolocation.'),
      remotePath: z.string().optional().describe('For push_file/pull_file: absolute device path, e.g. "/sdcard/Download/fixture.png".'),
      localPath: z.string().optional().describe(
        getDeploymentMode() === 'local'
          ? 'For push_file (source) / pull_file (destination): absolute path on your own machine — this server runs locally via the npm package, so a normal local path works directly.'
          : 'For push_file (source) / pull_file (destination): absolute path on the MCP SERVER\'s own filesystem, NOT your local machine. If the server runs in Docker/remote, push_file needs the file already present there (volume-mount), and pull_file writes to a location your local bash/file tools cannot see.'
      ),
    },
    async (args) => {
      const mobileErr = requireMobileSession(args.handle, 'device_control');
      if (mobileErr) return mobileErr;
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
          case 'device_info': {
            const d = await deviceDiagnostics(args.handle);
            return { content: [{ type: 'text' as const, text: Object.entries(d).filter(([, v]) => v !== undefined).map(([k, v]) => `  ${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join('\n') }] };
          }
          case 'set_appearance': {
            if (!args.style) return { content: [{ type: 'text' as const, text: 'Error: set_appearance requires style (dark|light).' }], isError: true };
            const now = await setAppearance(args.handle, args.style);
            if (now !== args.style) {
              return { content: [{ type: 'text' as const, text: `⚠️ Requested ${args.style} but the device reports ${now} afterwards — this device/OS build does not honour the ${requireSession(args.handle).platform === 'ios' ? 'appearance' : 'night-mode (cmd uimode)'} switch (seen on one Android phone live). Toggle dark mode in the device Settings app instead.` }], isError: true };
            }
            const original = requireSession(args.handle).originalAppearance;
            const reminder = original && original === now ? ` This is the appearance the device started with.` : ` Set it back${original ? ` to ${original}` : ''} before stopping the session.`;
            return { content: [{ type: 'text' as const, text: `✅ Appearance is now ${now}. Take a screenshot to check the themed screen.${reminder}` }] };
          }
          case 'accessibility_audit': {
            const findings = await accessibilityAudit(args.handle);
            const lines = findings.slice(0, 30).map((f, i) => `${i + 1}. ${String(f.type ?? f.auditType ?? 'issue')}: ${String(f.detailedDescription ?? f.compactDescription ?? f.elementDescription ?? '').split('\n')[0].slice(0, 200)}`);
            return { content: [{ type: 'text' as const, text: findings.length ? `${findings.length} accessibility finding(s) on this screen:\n${lines.join('\n')}${findings.length > 30 ? `\n… ${findings.length - 30} more` : ''}` : 'No accessibility findings on this screen.' }] };
          }
          case 'get_alert': {
            const a = await getAlertInfo(args.handle);
            return { content: [{ type: 'text' as const, text: `Alert text: ${JSON.stringify(a.text)}${a.buttons ? `\nButtons: ${a.buttons.map((b) => `"${b}"`).join(', ')} — press one with accept_alert + buttonLabel` : ''}` }] };
          }
          case 'accept_alert':
          case 'dismiss_alert': {
            await handleAlert(args.handle, args.action === 'accept_alert' ? 'accept' : 'dismiss', args.buttonLabel);
            return { content: [{ type: 'text' as const, text: `✅ Alert ${args.buttonLabel ? `button "${args.buttonLabel}" pressed` : args.action === 'accept_alert' ? 'accepted' : 'dismissed'}.` }] };
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
      // A start the client timed out on may have completed on the platform since — pick up its report first.
      const swept = await sweepTimedOutStarts();
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
      const sweptNote = swept.length > 0 ? ` (${swept.length} from timed-out starts: ${swept.join(', ')})` : '';

      const denied = await checkDeleteAllowed();
      if (denied) {
        return {
          content: [{
            type: 'text' as const,
            text:
              denied + ` The ${pending.length} tracked report ID(s) are preserved — switch to a Cloud Admin profile, then re-run cleanup_inspection_sessions.`,
          }],
          isError: true,
        };
      }

      const guard = checkDestructiveGuard(
        args.confirmDeletion,
        `Delete ${pending.length} inspection session report${pending.length !== 1 ? 's' : ''} (IDs: ${pending.join(', ')})${sweptNote}`
      );
      if (guard) return { content: [{ type: 'text' as const, text: guard }] };

      try {
        const { deleted, failed } = await deleteAllTrackedReports();
        const failNote = failed.length > 0
          ? ` ⚠️ ${failed.length} could not be deleted and remain tracked (IDs: ${failed.join(', ')}) — run cleanup again to retry.`
          : '';
        return {
          content: [
            {
              type: 'text' as const,
              text: `✅ Deleted ${deleted.length} inspection report${deleted.length !== 1 ? 's' : ''} (IDs: ${deleted.join(', ')}).${failNote}`,
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

  // ── webview_context ────────────────────────────────────────────────────────
  server.tool(
    'webview_context',
    'Hybrid apps: list the WebDriver contexts of an inspection session and switch between the native layer and a ' +
    'WEBVIEW_… context. In a webview, find_elements takes "css selector" (and xpath over the HTML), get_element_tree ' +
    'returns the HTML, tap/type work on the web elements. action "list" shows what is available (waits up to waitMs ' +
    'for a webview to be registered — one appears only while a screen with debuggable web content is in front); ' +
    '"switch" enters the first WEBVIEW (or the one given in name); "native" returns to NATIVE_APP — ALWAYS switch back ' +
    'before native taps, and before stop_inspection_session. Appium Server projects; the Appium Grid lists NATIVE_APP only. ' +
    'No webview listed? The app must allow web inspection (Android: WebView.setWebContentsDebuggingEnabled(true) in the ' +
    'build under test; iOS: web inspector enabled for the app) — a release build usually does not.',
    {
      handle: z.string().describe('Session handle from start_inspection_session.'),
      action: z.enum(['list', 'switch', 'native']).describe('list, switch (to name or the first WEBVIEW), or native.'),
      name: z.string().optional().describe('For switch: a context id from list, e.g. "WEBVIEW_chrome" or "WEBVIEW_12345.1". Default: the first WEBVIEW.'),
      waitMs: z.number().int().min(0).max(30000).optional().describe('How long list/switch wait for a webview to appear. Default 3000.'),
    },
    async (args) => {
      const mobileErr = requireMobileSession(args.handle, 'webview_context');
      if (mobileErr) return mobileErr;
      try {
        if (args.action === 'list') {
          const ctx = await listContexts(args.handle, args.waitMs ?? 3000);
          const current = requireSession(args.handle).currentContext ?? 'NATIVE_APP';
          const lines = ctx.map((c) => `  ${c.id === current ? '▶' : ' '} ${c.id}${c.title ? ` — "${c.title}"` : ''}${c.url ? ` ${c.url}` : ''}${c.package ? ` (${c.package})` : ''}${c.bundleId ? ` (${c.bundleId})` : ''}`);
          const hasWeb = ctx.some((c) => /^WEBVIEW/i.test(c.id));
          return { content: [{ type: 'text' as const, text: `Contexts (current: ${current}):\n${lines.join('\n')}${hasWeb ? '\n\nwebview_context(action: "switch") enters the first WEBVIEW.' : '\n\nNo WEBVIEW is registered on this screen.'}` }] };
        }
        const r = await switchContext(args.handle, args.action === 'native' ? 'native' : (args.name ?? 'auto'), args.waitMs ?? 3000);
        return { content: [{ type: 'text' as const, text: r.context === 'NATIVE_APP'
          ? `✅ Back in NATIVE_APP (contexts: ${r.available.join(', ')}).`
          : `✅ Switched to ${r.context}${r.title ? ` — "${r.title}"` : ''}${r.url ? ` ${r.url}` : ''}.\nUse find_elements(strategy: "css selector", selector: "input[name=…]") / get_element_tree (HTML); call webview_context(action: "native") when done.` }] };
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `Error (webview_context ${args.action}): ${(e as Error).message}` }], isError: true };
      }
    }
  );

  // ── get_device_log ─────────────────────────────────────────────────────────
  server.tool(
    'get_device_log',
    'Read the device log of a LIVE inspection session (Android logcat; iOS syslog — also crashlog, and on Appium Server ' +
    'performance/safariConsole/safariNetwork) to diagnose a crash, ANR or permission denial while the session is still ' +
    'open — no report download needed (get_test_log is the after-the-fact equivalent). Returns the last `tail` lines; ' +
    'pass `contains` (e.g. the package name, "FATAL", "Exception", "denied") to filter first — logs run to thousands of lines.',
    {
      handle: z.string().describe('Session handle from start_inspection_session.'),
      logType: z.string().optional().describe('Log type. Default: logcat (Android) / syslog (iOS). The error lists what the session offers.'),
      contains: z.string().optional().describe('Case-insensitive substring filter applied before the tail.'),
      tail: z.number().int().min(1).max(2000).optional().describe('Lines to return from the end (after filtering). Default 200.'),
    },
    async (args) => {
      const mobileErr = requireMobileSession(args.handle, 'get_device_log');
      if (mobileErr) return mobileErr;
      try {
        const r = await getDeviceLog(args.handle, args.logType, { tail: args.tail, contains: args.contains });
        const head = `${r.type}: ${r.totalLines} line(s) captured${args.contains ? `, ${r.lines.length} shown matching "${args.contains}"` : `, last ${r.lines.length} shown`}${r.types.length ? ` (types: ${r.types.join(', ')})` : ''}`;
        return { content: [{ type: 'text' as const, text: `${head}\n\n${r.lines.join('\n') || '(no matching lines)'}` }] };
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `Error (get_device_log): ${(e as Error).message}` }], isError: true };
      }
    }
  );

  // ── session_capture ────────────────────────────────────────────────────────
  server.tool(
    'session_capture',
    'Record part of a live inspection session into the file repository: kind "har" captures the device\'s HTTP traffic ' +
    '(startHarRecording → stopHarRecording) and kind "device_log" captures logcat/syslog for exactly the window between ' +
    'start and stop (startLoggingDevice → stopLoggingDevice). stop returns the repository file (id, size) to fetch with ' +
    'download_repository_file / get_repository_file_download_command. The HAR is a ZIP containing har.json. CAVEAT: with ' +
    'NV tunneling on for the device (every device on this tenant) the platform records NO HAR entries — the file comes ' +
    'back ~290 bytes and the response says so; use a performance transaction for network byte counts. Works on Appium ' +
    'Server and Appium Grid sessions (both verified live). For an unbounded in-session read without a file, use get_device_log.',
    {
      handle: z.string().describe('Session handle from start_inspection_session.'),
      kind: z.enum(['har', 'device_log']).describe('What to capture.'),
      action: z.enum(['start', 'stop']).describe('start or stop (one capture of each kind at a time).'),
      name: z.string().optional().describe('For start: repository file name (uniqueName; ".har"/".log" is added). Default: mcp-<kind>-<timestamp>.'),
    },
    async (args) => {
      const mobileErr = requireMobileSession(args.handle, 'session_capture');
      if (mobileErr) return mobileErr;
      try {
        const r = await sessionCapture(args.handle, args.kind, args.action, args.name);
        if (args.action === 'start') return { content: [{ type: 'text' as const, text: `✅ ${args.kind} capture started → repository file "${r.file}". Run the steps to capture, then session_capture(action: "stop").` }] };
        const where = r.repositoryFile ? `repository file "${r.file}" (id ${r.repositoryFile.id}, ${r.repositoryFile.size} bytes) — download_repository_file(fileId: ${r.repositoryFile.id})` : `repository file "${r.file}" (not listed yet — list_repository_files(uniqueName: "${r.file}") in a few seconds)`;
        return { content: [{ type: 'text' as const, text: `✅ ${args.kind} capture stopped → ${where}.${r.note ? `\n⚠️ ${r.note}` : ''}` }] };
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `Error (session_capture ${args.kind} ${args.action}): ${(e as Error).message}` }], isError: true };
      }
    }
  );

  // ── network_control ────────────────────────────────────────────────────────
  server.tool(
    'network_control',
    'Network state of the device in a live inspection session. action "get" reads whether wifi / mobile_data / ' +
    'airplane_mode / bluetooth is on; "set" switches one on or off (Android only — offline-mode and reconnect flows; ' +
    'turn it back on before stopping); "set_conditions" applies an NV network profile ("3G-average", "Monitor" = none…) ' +
    'to the device\'s traffic WITHOUT recording a transaction — for exploring an app under a slow network; durationMs 0 ' +
    'keeps it until changed; needs an ONLINE, tunneled NV server in the device\'s region (list_nv_servers) and a Project Admin ' +
    'or Cloud Admin key. Appium Server and Appium Grid sessions (seetest:client commands run on both).',
    {
      handle: z.string().describe('Session handle from start_inspection_session.'),
      action: z.enum(['get', 'set', 'set_conditions']).describe('get / set a connection, or set_conditions (NV profile).'),
      kind: z.enum(['wifi', 'mobile_data', 'airplane_mode', 'bluetooth']).optional().describe('For get/set: which connection.'),
      enabled: z.boolean().optional().describe('For set: true = on, false = off.'),
      profile: z.string().optional().describe('For set_conditions: NV profile name, e.g. "3G-average"; "Monitor" lifts shaping.'),
      durationMs: z.number().int().min(0).max(3_600_000).optional().describe('For set_conditions: how long to keep the profile; 0 (default) = until changed.'),
    },
    async (args) => {
      const mobileErr = requireMobileSession(args.handle, 'network_control');
      if (mobileErr) return mobileErr;
      try {
        if (args.action === 'set_conditions') {
          if (!args.profile) return { content: [{ type: 'text' as const, text: 'Error: set_conditions requires profile.' }], isError: true };
          return { content: [{ type: 'text' as const, text: `✅ ${await setNetworkConditions(args.handle, args.profile, args.durationMs ?? 0)}` }] };
        }
        if (!args.kind) return { content: [{ type: 'text' as const, text: 'Error: get/set require kind.' }], isError: true };
        if (args.action === 'set' && args.enabled == null) return { content: [{ type: 'text' as const, text: 'Error: set requires enabled.' }], isError: true };
        const r = await networkConnection(args.handle, args.kind, args.action === 'set' ? args.enabled : undefined);
        return { content: [{ type: 'text' as const, text: `${args.action === 'set' ? '✅ ' : ''}${r.kind}: ${r.enabled ? 'ON' : 'OFF'}` }] };
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `Error (network_control ${args.action}): ${(e as Error).message}` }], isError: true };
      }
    }
  );

  // ── inject_camera_image ────────────────────────────────────────────────────
  server.tool(
    'inject_camera_image',
    'Camera image injection: the next camera capture in the app under test returns the given image instead of the sensor ' +
    'frame — for check deposit, document/QR scan and profile-photo flows on a real device. source is "cloud:<repository ' +
    'uniqueName>" (upload the .jpg/.png with upload_repository_file first) or an http(s) URL ending in .jpg/.jpeg/.png. ' +
    'REQUIRES an instrumented build (uploaded with instrument=true, or the session started with digitalai:instrumentApp=true) — ' +
    'otherwise the platform answers "application is not instrumented". Call it BEFORE tapping the capture button.',
    {
      handle: z.string().describe('Session handle from start_inspection_session.'),
      source: z.string().describe('"cloud:<uniqueName>.png" or an http(s) URL to a .jpg/.jpeg/.png.'),
    },
    async (args) => {
      const mobileErr = requireMobileSession(args.handle, 'inject_camera_image');
      if (mobileErr) return mobileErr;
      try {
        return { content: [{ type: 'text' as const, text: `✅ ${await injectCameraImage(args.handle, args.source)}` }] };
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `Error (inject_camera_image): ${(e as Error).message}` }], isError: true };
      }
    }
  );

  // ── mock_authentication ────────────────────────────────────────────────────
  server.tool(
    'mock_authentication',
    'Pre-stage a mock biometric authentication response (Touch ID, Face ID, or fingerprint) ' +
      'for the next auth dialog in an instrumented app. ' +
      'Call this BEFORE the action that triggers the biometric prompt — the platform intercepts ' +
      'the LocalAuthentication / BiometricPrompt request and answers it automatically without user interaction. ' +
      'REQUIRES an instrumented app (uploaded with instrument=true, or manually instrumented for iOS). ' +
      'Does NOT work for system apps (App Store, Play Store) or third-party auth libraries. ' +
      'Use reply "clear" to remove the mock after the test so subsequent auth dialogs behave normally.',
    {
      handle: z.string().describe('Session handle from start_inspection_session.'),
      reply: z
        .enum(['success', 'failed', 'cancel', 'clear'])
        .describe(
          'success — auth passes silently (fingerprint/face recognised). ' +
          'failed — auth fails (wrong fingerprint / face not recognised). ' +
          'cancel — user cancels the biometric dialog. ' +
          'clear — remove mock; subsequent dialogs behave normally.'
        ),
      delay: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe(
          'Milliseconds to wait after the auth dialog appears before responding. Default 1 (the platform rejects 0).'
        ),
    },
    async (args) => {
      const mobileErr = requireMobileSession(args.handle, 'mock_authentication');
      if (mobileErr) return mobileErr;
      try {
        const result = await mockAuthentication(args.handle, args.reply, args.delay ?? 1);
        return { content: [{ type: 'text' as const, text: `✅ ${result}` }] };
      } catch (e) {
        return {
          content: [{ type: 'text' as const, text: `Error (mock_authentication): ${(e as Error).message}` }],
          isError: true,
        };
      }
    }
  );
}
