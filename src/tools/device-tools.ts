import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  getAllDevices,
  getDevicesByQuery,
  getDevice,
  editDevice,
  releaseDevice,
  rebootDevice,
  resetDeviceUsb,
  downloadIosAppContainer,
  startDeviceWebControl,
  openMobileStudio,
  createMobileManualTest,
  getDeviceTags,
  addDeviceTag,
  removeDeviceTag,
  removeAllDeviceTags,
  getDeviceCaCertificates,
} from '../api/devices.js';
import { checkDestructiveGuard } from '../utils/destructive-guard.js';
import { validateOutputPath } from '../utils/path-guard.js';
import { applyMaxResults, appendTruncationNotice } from '../utils/pagination.js';
import { formatDeviceList, formatDeviceHealthSummary } from '../utils/response-formatter.js';
import { resolveDevice, formatResolvedDevice } from '../utils/device-resolver.js';
import { outputFormatParam, respond } from '../utils/output-format.js';

const MODE_MAP: Record<string, 0 | 1 | 2 | 3> = {
  manual: 0,
  view: 1,
  automation: 2,
  debug: 3,
};

export function registerDeviceTools(server: McpServer): void {
  server.tool(
    'list_devices',
    "Lists all devices you have access to with their current status, OS, model, and agent. Optionally filter by region or model (client-side), or use the query syntax for server-side filtering.",
    {
      query: z
        .string()
        .optional()
        .describe(
          "Server-side device query filter using @ syntax. " +
          "CONFIRMED WORKING fields: " +
          "@os ('android'/'iOS', case-insensitive), " +
          "@version (decimal required — '14.0' works, '14' matches nothing; supports =, >, <, !=), " +
          "@category ('PHONE'/'TABLET' — UPPERCASE required, lowercase returns nothing), " +
          "@region (e.g. 'US2', 'SG1'), " +
          "@serialNumber (exact device serial/UDID), " +
          "@name (exact device display name), " +
          "@model (exact model code or display name), " +
          "@modelName (exact human-readable model name), " +
          "@emulator ('true'/'false'). " +
          "BROKEN fields (silently return 0 results — do not use in query): " +
          "@manufacturer, @tag, @deviceName, @id, @udid, @status, @agentName, @region+manufacturer combined. " +
          "For manufacturer, tag, model substring, or region filtering prefer the dedicated params below — those apply client-side and always work."
        ),
      region: z
        .string()
        .optional()
        .describe("Filter by region code (partial match, case-insensitive, client-side). E.g. 'US2', 'SG', 'EU'."),
      model: z
        .string()
        .optional()
        .describe("Filter by device model or name (partial match, case-insensitive, client-side). E.g. 'iPhone 13', 'Pixel 6'."),
      sortBy: z
        .enum(['deviceName', 'deviceOs', 'osVersion', 'manufacturer', 'displayStatus', 'agentName', 'region'])
        .optional()
        .describe('Sort results by this field (client-side). Default: no sort (platform order).'),
      sortOrder: z
        .enum(['asc', 'desc'])
        .optional()
        .default('asc')
        .describe("Sort direction: 'asc' or 'desc'. Default: 'asc'."),
      maxResults: z
        .number()
        .optional()
        .default(50)
        .describe('Maximum number of results to return (default: 50, max: 500).'),
      outputFormat: outputFormatParam,
    },
    async ({ query, region, model, sortBy, sortOrder, maxResults, outputFormat }) => {
      try {
        let devices = query ? await getDevicesByQuery(query) : await getAllDevices();
        if (region) {
          const q = region.toLowerCase();
          devices = devices.filter(d => d.region.toLowerCase().includes(q));
        }
        if (model) {
          const q = model.toLowerCase();
          devices = devices.filter(d =>
            d.model.toLowerCase().includes(q) ||
            (d.modelName ?? '').toLowerCase().includes(q) ||
            d.deviceName.toLowerCase().includes(q)
          );
        }
        if (sortBy) {
          devices = [...devices].sort((a, b) => {
            const av = String(a[sortBy as keyof typeof a] ?? '').toLowerCase();
            const bv = String(b[sortBy as keyof typeof b] ?? '').toLowerCase();
            return sortOrder === 'desc' ? bv.localeCompare(av) : av.localeCompare(bv);
          });
        }
        const filterDesc = [
          query ? `query="${query}"` : '',
          region ? `region~"${region}"` : '',
          model ? `model~"${model}"` : '',
        ].filter(Boolean).join(', ');
        const paged = applyMaxResults(devices, maxResults);
        const structured = {
          devices: paged.items.map(d => ({
            id: d.id,
            name: d.deviceName,
            osType: d.deviceOs,
            osVersion: d.osVersion,
            model: d.model,
            manufacturer: d.manufacturer,
            deviceCategory: d.deviceCategory,
            displayStatus: d.displayStatus,
            region: d.region,
            tags: d.tags,
          })),
        };
        const header = filterDesc
          ? `Found ${paged.total} device(s) matching [${filterDesc}]:\n\n`
          : `Found ${paged.total} device(s):\n\n`;
        const humanText = appendTruncationNotice(header + formatDeviceList(paged.items), paged);
        return respond(outputFormat, structured, humanText);
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  server.tool(
    'get_device_detail',
    "Gets the full profile of a specific device including device groups, agent connection details, and complete status history. Cloud Admin only. Accepts numeric device ID, serial number, UDID, or device name — MCP resolves the identifier automatically.",
    {
      deviceId: z.string().describe('Numeric device ID, serial number, UDID, or device name (e.g. "39031FDJH00B3U", "iPhone 15 Pro", or "12345").'),
      outputFormat: outputFormatParam,
    },
    async ({ deviceId, outputFormat }) => {
      try {
        const resolved = await resolveDevice(deviceId);
        const d = await getDevice(resolved.id);
        const tags = d.tags && d.tags.length > 0 ? d.tags.join(', ') : 'none';
        const groups = d.deviceGroups
          ? Object.entries(d.deviceGroups)
              .map(([id, name]) => `${name} (ID: ${id})`)
              .join(', ')
          : 'none';
        const humanText = [
          `📱 Device: ${d.deviceName} (ID: ${d.id})`,
          `OS: ${d.deviceOs} ${d.osVersion}`,
          `Model: ${d.model}${d.modelName ? ` (${d.modelName})` : ''}`,
          `Manufacturer: ${d.manufacturer}`,
          `Status: ${d.displayStatus}`,
          `Category: ${d.deviceCategory}`,
          `Agent: ${d.agentName} (${d.agentIp})`,
          `Region: ${d.region}`,
          `Current User: ${d.currentUser || 'none'}`,
          `Tags: ${tags}`,
          `Device Groups: ${groups}`,
          `Is Emulator: ${d.isEmulator}`,
          `UDID: ${d.udid}`,
          `Status Age: ${d.statusAgeInMinutes} minutes`,
          `Last Used: ${d.lastUsedDateTime}`,
          d.phoneNumber1 ? `Phone: ${d.phoneNumber1}` : '',
          d.screenWidth && d.screenHeight ? `Screen: ${d.screenWidth}x${d.screenHeight}` : '',
        ]
          .filter(Boolean)
          .join('\n');
        return respond(outputFormat, d, humanText);
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  server.tool(
    'edit_device',
    "Updates a device's display name, internal notes, or category (Phone, Tablet, Watch). Cloud Admin only. Accepts numeric device ID, serial number, UDID, or device name.",
    {
      deviceId: z.string().describe('Numeric device ID, serial number, UDID, or device name.'),
      name: z.string().optional().describe('New display name for the device.'),
      notes: z.string().optional().describe('Internal notes about the device.'),
      category: z
        .enum(['PHONE', 'TABLET', 'WATCH', 'UNKNOWN'])
        .optional()
        .describe("Device category: 'PHONE', 'TABLET', 'WATCH', or 'UNKNOWN'."),
    },
    async ({ deviceId, name, notes, category }) => {
      try {
        const resolved = await resolveDevice(deviceId);
        await editDevice(resolved.id, { name, notes, category });
        return {
          content: [{ type: 'text', text: `✅ ${formatResolvedDevice(resolved, deviceId)} updated successfully.` }],
        };
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  server.tool(
    'release_device',
    'Releases a device from its current user, making it available to others. Useful when a device is stuck in a reserved state. Available to all users for their own sessions. Accepts numeric device ID, serial number, UDID, or device name.',
    {
      deviceId: z.string().describe('Numeric device ID, serial number, UDID, or device name.'),
    },
    async ({ deviceId }) => {
      try {
        const resolved = await resolveDevice(deviceId);
        await releaseDevice(resolved.id);
        return {
          content: [
            { type: 'text', text: `✅ ${formatResolvedDevice(resolved, deviceId)} released and is now available.` },
          ],
        };
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  server.tool(
    'reboot_device',
    'Reboots a device remotely. Use when a device is unresponsive or misbehaving. Cloud Admin only. The device will be briefly unavailable while it restarts. Accepts numeric device ID, serial number, UDID, or device name.',
    {
      deviceId: z.string().describe('Numeric device ID, serial number, UDID, or device name.'),
    },
    async ({ deviceId }) => {
      try {
        const resolved = await resolveDevice(deviceId);
        await rebootDevice(resolved.id);
        return {
          content: [
            {
              type: 'text',
              text: `✅ Reboot command sent to ${formatResolvedDevice(resolved, deviceId)}. The device will be briefly unavailable during restart.`,
            },
          ],
        };
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  server.tool(
    'reset_device_usb',
    'Resets the USB connection for a device. Try this before rebooting — it often resolves connectivity issues without a full restart. Cloud Admin only. Accepts numeric device ID, serial number, UDID, or device name.',
    {
      deviceId: z.string().describe('Numeric device ID, serial number, UDID, or device name.'),
    },
    async ({ deviceId }) => {
      try {
        const resolved = await resolveDevice(deviceId);
        await resetDeviceUsb(resolved.id);
        return {
          content: [
            { type: 'text', text: `✅ USB reset command sent to ${formatResolvedDevice(resolved, deviceId)}.` },
          ],
        };
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  server.tool(
    'start_device_web_control',
    "Opens a browser-based control session for a specific device. Mode options: 'manual' (interactive testing), 'view' (watch only), 'automation' (automated test mode), 'debug' (debug mode — requires the Digital.ai Grid to be running as the same user who calls this API). Returns a session URL. Cloud Admin only. Accepts numeric device ID, serial number, UDID, or device name.",
    {
      deviceId: z.string().describe('Numeric device ID, serial number, UDID, or device name.'),
      mode: z
        .enum(['manual', 'view', 'automation', 'debug'])
        .describe("Session mode: 'manual' (interactive), 'view' (watch only), 'automation' (automated), 'debug' (requires Grid running as same user)."),
      emulatorInstanceName: z
        .string()
        .optional()
        .describe('Optional emulator instance name (for emulator devices only).'),
    },
    async ({ deviceId, mode, emulatorInstanceName }) => {
      try {
        const resolved = await resolveDevice(deviceId);
        const type = MODE_MAP[mode];
        const result = await startDeviceWebControl(resolved.id, type, emulatorInstanceName);
        const text = [
          `✅ Web control session started.`,
          `Session URL: ${result.regularLink}`,
          result.externalLink ? `External URL: ${result.externalLink}` : '',
          `Mode: ${mode}`,
        ]
          .filter(Boolean)
          .join('\n');
        return { content: [{ type: 'text', text }] };
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  server.tool(
    'open_mobile_studio',
    "Opens Mobile Studio (the browser-based device control interface) for a device matching the query. Available to all users. Returns a session link.",
    {
      deviceQuery: z
        .string()
        .describe("Device query expression. Example: \"@os='iOS'\", \"@id='123'\"."),
    },
    async ({ deviceQuery }) => {
      try {
        const result = await openMobileStudio(deviceQuery);
        return {
          content: [
            {
              type: 'text',
              text: `✅ Mobile Studio session opened.\nSession URL: ${result.link}`,
            },
          ],
        };
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  server.tool(
    'create_mobile_manual_test',
    "Creates a structured manual test session for a mobile device. Returns a session link for the tester and a report_api_id. IMPORTANT: the report_api_id is only resolvable via get_test_by_report_id AFTER the session ends — querying it while the session is active will return 404. The session URL hostname is regional (e.g. sgregion, ukregion) and reflects which agent controls the device; this is expected.",
    {
      deviceQuery: z
        .string()
        .describe("Device query expression to select the target device. Example: \"@os='Android'\"."),
      testName: z.string().describe('Name of the test session (appears in the report).'),
      testSteps: z
        .array(
          z.object({
            name: z.string().max(255).describe('Step name (max 255 characters).'),
            description: z.string().optional().describe('What to do in this step.'),
            expectedResult: z.string().optional().describe('What the expected outcome is.'),
            attachment: z.string().optional().describe('URL to an attachment or screenshot.'),
          })
        )
        .describe('Ordered list of test steps.'),
    },
    async ({ deviceQuery, testName, testSteps }) => {
      try {
        const result = await createMobileManualTest(deviceQuery, testName, testSteps);
        return {
          content: [
            {
              type: 'text',
              text: [
                `✅ Manual test session created: "${testName}"`,
                `Session URL: ${result.link}`,
                `Report ID (report_api_id): ${result.report_api_id}`,
                `Steps: ${testSteps.length}`,
                ``,
                `Note: the session URL hostname is regional and reflects the device's agent location.`,
                `Use get_test_by_report_id with the report_api_id AFTER closing the session to retrieve results.`,
              ].join('\n'),
            },
          ],
        };
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  server.tool(
    'download_ios_app_container',
    "Downloads the app data container from an iOS device as a ZIP file (useful for inspecting app state after a test). The device must be reserved and the app must be a debug build. Cloud Admin only. iOS only. Accepts numeric device ID, serial number, UDID, or device name.",
    {
      deviceId: z.string().describe('Numeric device ID, serial number, UDID, or iOS device name.'),
      bundleId: z
        .string()
        .describe('iOS bundle identifier, e.g. com.mycompany.myapp.'),
      localPath: z.string().describe('Local file path where the ZIP file will be saved.'),
    },
    async ({ deviceId, bundleId, localPath }) => {
      const pathErr = validateOutputPath(localPath);
      if (pathErr) return { content: [{ type: 'text', text: `Error: ${pathErr}` }], isError: true };
      try {
        const resolved = await resolveDevice(deviceId);
        await downloadIosAppContainer(resolved.id, bundleId, localPath);
        return {
          content: [
            {
              type: 'text',
              text: `✅ App container for ${bundleId} downloaded to: ${localPath}`,
            },
          ],
        };
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  server.tool(
    'get_device_tags',
    'Gets all tags currently assigned to a device. Available to all users. Accepts numeric device ID, serial number, UDID, or device name.',
    {
      deviceId: z.string().describe('Numeric device ID, serial number, UDID, or device name.'),
      outputFormat: outputFormatParam,
    },
    async ({ deviceId, outputFormat }) => {
      try {
        const resolved = await resolveDevice(deviceId);
        const tags = await getDeviceTags(resolved.id);
        const label = formatResolvedDevice(resolved, deviceId);
        const structured = { deviceId: resolved.id, tags };
        const humanText =
          tags.length > 0
            ? `Tags on ${label}: ${tags.join(', ')}`
            : `${label} has no tags.`;
        return respond(outputFormat, structured, humanText);
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  server.tool(
    'add_device_tag',
    'Assigns a tag to a device (max 10 total). ' +
    'Use this to label, mark, or categorize a device — for example, tagging devices with a POC identifier during create_poc (Step 5). ' +
    'Tags may only contain letters, digits, and underscores — no spaces or special characters. Not case-sensitive. ' +
    'Accepts numeric device ID, serial number, UDID, or device name. Available to Cloud Admin and Project Admin.',
    {
      deviceId: z.string().describe('Numeric device ID, serial number, UDID, or device name.'),
      tag: z
        .string()
        .regex(/^[a-zA-Z0-9_]+$/)
        .describe('Tag value — letters, digits, and underscores only. No spaces.'),
    },
    async ({ deviceId, tag }) => {
      try {
        const resolved = await resolveDevice(deviceId);
        await addDeviceTag(resolved.id, tag);
        return {
          content: [{ type: 'text', text: `✅ Tag "${tag}" added to ${formatResolvedDevice(resolved, deviceId)}.` }],
        };
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  server.tool(
    'remove_device_tag',
    'Removes a specific tag from a device. Available to Cloud Admin and Project Admin. Requires confirmDeletion: true. Accepts numeric device ID, serial number, UDID, or device name.',
    {
      deviceId: z.string().describe('Numeric device ID, serial number, UDID, or device name.'),
      tag: z.string().describe('The tag value to remove.'),
      confirmDeletion: z
        .boolean()
        .describe('Must be true to confirm this destructive, irreversible operation. No changes are made without this.'),
    },
    async ({ deviceId, tag, confirmDeletion }) => {
      try {
        const resolved = await resolveDevice(deviceId);
        const guard = checkDestructiveGuard(
          confirmDeletion,
          `Remove tag "${tag}" from ${formatResolvedDevice(resolved, deviceId)}`
        );
        if (guard) return { content: [{ type: 'text', text: guard }] };
        await removeDeviceTag(resolved.id, tag);
        return {
          content: [{ type: 'text', text: `✅ Tag "${tag}" removed from ${formatResolvedDevice(resolved, deviceId)}.` }],
        };
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  server.tool(
    'remove_all_device_tags',
    'Removes all tags from a device at once. Available to Cloud Admin and Project Admin. Requires confirmDeletion: true. Accepts numeric device ID, serial number, UDID, or device name.',
    {
      deviceId: z.string().describe('Numeric device ID, serial number, UDID, or device name.'),
      confirmDeletion: z
        .boolean()
        .describe('Must be true to confirm this destructive, irreversible operation. No changes are made without this.'),
    },
    async ({ deviceId, confirmDeletion }) => {
      try {
        const resolved = await resolveDevice(deviceId);
        const guard = checkDestructiveGuard(
          confirmDeletion,
          `Remove all tags from ${formatResolvedDevice(resolved, deviceId)}`
        );
        if (guard) return { content: [{ type: 'text', text: guard }] };
        await removeAllDeviceTags(resolved.id);
        return {
          content: [{ type: 'text', text: `✅ All tags removed from ${formatResolvedDevice(resolved, deviceId)}.` }],
        };
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  server.tool(
    'get_device_ca_certificates',
    'Lists the CA (Certificate Authority) certificates installed on an Android device. Useful for verifying that network capture or proxy certificates are correctly installed. Android only. Cloud Admin only. Note: pre-existing manufacturer accounts (Google, Samsung, Xiaomi) must be removed from the device before first use. Accepts numeric device ID, serial number, UDID, or device name.',
    {
      deviceId: z.string().describe('Numeric device ID, serial number, UDID, or device name (Android only).'),
      outputFormat: outputFormatParam,
    },
    async ({ deviceId, outputFormat }) => {
      try {
        const resolved = await resolveDevice(deviceId);
        const certs = await getDeviceCaCertificates(resolved.id);
        const label = formatResolvedDevice(resolved, deviceId);
        const structured = { deviceId: resolved.id, certificates: certs };
        const humanText =
          certs.length > 0
            ? `CA Certificates on ${label} (${certs.length}):\n${certs.map((c) => `  • ${c}`).join('\n')}`
            : `No CA certificates found on ${label}.`;
        return respond(outputFormat, structured, humanText);
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  server.tool(
    'get_device_health_summary',
    'Shows a health overview of all devices: counts by status, breakdown by OS, per-agent device counts, and any devices that have been offline unusually long.',
    {
      offlineThresholdMinutes: z
        .number()
        .optional()
        .default(60)
        .describe('Flag devices offline longer than this many minutes (default: 60).'),
      maxResults: z
        .number()
        .optional()
        .default(200)
        .describe('Maximum number of devices to include in the analysis (default: 200, max: 500).'),
      outputFormat: outputFormatParam,
    },
    async ({ offlineThresholdMinutes, maxResults, outputFormat }) => {
      try {
        const devices = await getAllDevices();
        const paged = applyMaxResults(devices, maxResults);

        // Build structured summary
        const available = paged.items.filter(d => d.displayStatus.toLowerCase() === 'available').length;
        const reserved = paged.items.filter(d => d.displayStatus.toLowerCase() === 'reserved').length;
        const offline = paged.items.filter(d => d.displayStatus.toLowerCase() === 'offline').length;
        const ios = paged.items.filter(d => d.deviceOs === 'iOS').length;
        const android = paged.items.filter(d => d.deviceOs === 'Android').length;
        const agentMapStruct: Record<string, { total: number; online: number; ip: string }> = {};
        for (const d of paged.items) {
          if (!agentMapStruct[d.agentName]) agentMapStruct[d.agentName] = { total: 0, online: 0, ip: d.agentIp };
          agentMapStruct[d.agentName].total++;
          if (d.displayStatus.toLowerCase() !== 'offline') agentMapStruct[d.agentName].online++;
        }
        const agentArray = Object.entries(agentMapStruct).map(([name, counts]) => ({ name, ...counts }));
        const longOfflineArray = paged.items
          .filter(d => d.displayStatus.toLowerCase() === 'offline' && parseFloat(d.statusAgeInMinutes) > offlineThresholdMinutes)
          .map(d => ({ id: d.id, name: d.deviceName, offlineMinutes: parseFloat(d.statusAgeInMinutes) }));
        const structured = {
          total: paged.total,
          analyzed: paged.returned,
          truncated: paged.truncated,
          available, reserved, offline, ios, android,
          agents: agentArray,
          longOffline: longOfflineArray,
        };

        const humanSummary = formatDeviceHealthSummary(paged.items, offlineThresholdMinutes);
        const humanText = appendTruncationNotice(humanSummary, paged);
        return respond(outputFormat, structured, humanText);
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  // ─── find_available_device ────────────────────────────────────────────────

  server.tool(
    'find_available_device',
    'Find the first available device matching capability criteria (OS, version, manufacturer, tags, model). ' +
    'Filtering by os and category is applied server-side for speed; manufacturer, tags, model, and osVersion are ' +
    'applied client-side (the API @manufacturer and @tag query fields do not work). ' +
    'Returns the device immediately if one is free, or reports how many matching devices exist and their current statuses if none are available. ' +
    'IMPORTANT: Call this tool before generating any digitalai:deviceQuery capability strings — use the osVersion value ' +
    'from the RESPONSE (not the parameter you passed) verbatim in your @version query. ' +
    'The osVersion parameter is a minimum filter (≥), so the returned device may be running a higher version than requested.',
    {
      os: z
        .enum(['iOS', 'Android'])
        .optional()
        .describe('Target operating system. Applied server-side.'),
      osVersion: z
        .string()
        .optional()
        .describe(
          'Minimum OS version filter (≥), e.g. "14.0". Applied client-side. ' +
          'The returned device may be running a HIGHER version than requested — always read osVersion from the ' +
          'response and use that exact value (e.g. "14.0") in your digitalai:deviceQuery @version field. ' +
          'Do not use the value you passed as the parameter.'
        ),
      manufacturer: z
        .string()
        .optional()
        .describe('Device manufacturer, e.g. "Apple" or "samsung" (case-insensitive, client-side filter).'),
      model: z
        .string()
        .optional()
        .describe('Device model substring matched against deviceName and modelName (case-insensitive, client-side). E.g. "iPhone 14", "Pixel 6".'),
      tags: z
        .array(z.string())
        .optional()
        .describe('All listed tags must be present on the device (case-insensitive, client-side filter).'),
      category: z
        .enum(['PHONE', 'TABLET', 'WATCH'])
        .optional()
        .describe('Device form factor. Applied server-side.'),
      outputFormat: outputFormatParam,
    },
    async ({ os, osVersion, manufacturer, model, tags, category, outputFormat }) => {
      try {
        // Only @os, @category, and @emulator are confirmed to work server-side.
        // @manufacturer and @tag look valid but silently return 0 results from the API
        // (even combined with working fields). Filter these client-side instead.
        const clauses: string[] = [];
        if (os) clauses.push(`@os='${os}'`);
        if (category) clauses.push(`@category='${category}'`);

        const query = clauses.join(' and ');
        const devices = query ? await getDevicesByQuery(query) : await getAllDevices();

        // Apply all remaining filters client-side (manufacturer, tags, model, osVersion).
        const filtered = devices.filter((d) => {
          if (os && d.deviceOs !== os) return false;
          if (osVersion && parseFloat(d.osVersion) < parseFloat(osVersion)) return false;
          if (manufacturer && d.manufacturer.toLowerCase() !== manufacturer.toLowerCase()) return false;
          if (tags && !tags.every(t => d.tags.map(dt => dt.toLowerCase()).includes(t.toLowerCase()))) return false;
          if (model && !d.deviceName.toLowerCase().includes(model.toLowerCase()) &&
              !(d.modelName ?? '').toLowerCase().includes(model.toLowerCase())) return false;
          return true;
        });

        if (filtered.length === 0) {
          return respond(outputFormat, { found: false, matchingCount: 0 }, 'No devices match the specified criteria.');
        }

        const available = filtered.filter(
          (d) => d.displayStatus.toLowerCase() === 'available'
        );

        if (available.length > 0) {
          const d = available[0];
          const structured = {
            found: true,
            device: {
              id: d.id,
              name: d.deviceName,
              osType: d.deviceOs,
              osVersion: d.osVersion,
              model: d.model,
              manufacturer: d.manufacturer,
              agentName: d.agentName,
              tags: d.tags,
            },
            alternativesAvailable: available.length - 1,
          };
          const humanText = [
            `✅ Available device found:`,
            `  Name:         ${d.deviceName} (ID: ${d.id})`,
            `  OS:           ${d.deviceOs} ${d.osVersion}`,
            `  Model:        ${d.model}${d.modelName ? ` (${d.modelName})` : ''}`,
            `  Manufacturer: ${d.manufacturer}`,
            `  Agent:        ${d.agentName}`,
            `  Tags:         ${d.tags.length > 0 ? d.tags.join(', ') : 'none'}`,
            available.length > 1 ? `\n${available.length - 1} other matching device(s) also available.` : '',
          ].filter(Boolean).join('\n');
          return respond(outputFormat, structured, humanText);
        }

        // None available — report status breakdown
        const statusCounts: Record<string, number> = {};
        for (const d of filtered) {
          const s = d.displayStatus || 'Unknown';
          statusCounts[s] = (statusCounts[s] ?? 0) + 1;
        }
        const breakdown = Object.entries(statusCounts)
          .map(([s, n]) => `  ${s}: ${n}`)
          .join('\n');
        return respond(
          outputFormat,
          { found: false, matchingCount: filtered.length, statusBreakdown: statusCounts },
          `No available devices match the criteria. ${filtered.length} matching device(s) found:\n${breakdown}`
        );
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  // ─── release_orphaned_sessions ────────────────────────────────────────────

  server.tool(
    'release_orphaned_sessions',
    'Find and release devices that have been in an "In Use" state longer than the specified threshold. Useful for clearing sessions orphaned by crashed test runners or forgotten manual sessions. Requires confirmDeletion: true to actually release; omit it to preview what would be released.',
    {
      maxAgeHours: z
        .number()
        .min(0.5)
        .default(4)
        .describe('Release devices that have been in use longer than this many hours. Default: 4 hours.'),
      confirmDeletion: z
        .boolean()
        .optional()
        .describe('Must be true to actually release the devices. Omit to preview without making changes.'),
      dryRun: z
        .boolean()
        .optional()
        .describe('Alias for omitting confirmDeletion — explicitly show what would be released without releasing.'),
      outputFormat: outputFormatParam,
    },
    async ({ maxAgeHours, confirmDeletion, dryRun, outputFormat }) => {
      try {
        const devices = await getAllDevices();
        const thresholdMinutes = maxAgeHours * 60;

        const orphaned = devices.filter((d) => {
          const status = d.displayStatus.toLowerCase();
          const isInUse = status === 'in use' || status === 'inuse' || status === 'busy';
          const age = parseFloat(d.statusAgeInMinutes);
          return isInUse && !isNaN(age) && age >= thresholdMinutes;
        });

        if (orphaned.length === 0) {
          return {
            content: [{
              type: 'text',
              text: `No orphaned sessions found (threshold: ${maxAgeHours}h). All in-use devices are within the time limit.`,
            }],
          };
        }

        const preview = orphaned
          .map((d) => {
            const hours = (parseFloat(d.statusAgeInMinutes) / 60).toFixed(1);
            return `  • ${d.deviceName} (ID: ${d.id}) — in use for ${hours}h by ${d.currentUser || 'unknown'}`;
          })
          .join('\n');

        const guard = checkDestructiveGuard(
          dryRun ? false : confirmDeletion,
          `Release ${orphaned.length} orphaned device session(s) held for >${maxAgeHours}h`
        );
        if (guard) {
          return {
            content: [{ type: 'text', text: `${guard}\n\nDevices that would be released:\n${preview}` }],
          };
        }

        const results: string[] = [];
        const releaseResults: Array<{ id: string; name: string; status: string; error?: string }> = [];
        for (const d of orphaned) {
          try {
            await releaseDevice(d.id);
            results.push(`  ✅ Released: ${d.deviceName} (ID: ${d.id})`);
            releaseResults.push({ id: d.id, name: d.deviceName, status: 'released' });
          } catch (err) {
            results.push(`  ❌ Failed:   ${d.deviceName} (ID: ${d.id}) — ${(err as Error).message}`);
            releaseResults.push({ id: d.id, name: d.deviceName, status: 'failed', error: (err as Error).message });
          }
        }

        const structured = { released: releaseResults.filter(r => r.status === 'released').length, results: releaseResults };
        const humanText = `Released ${orphaned.length} orphaned session(s):\n${results.join('\n')}`;
        return respond(outputFormat, structured, humanText);
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );
}
