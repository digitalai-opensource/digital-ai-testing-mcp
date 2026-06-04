import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  getDeviceGroups,
  getDeviceGroupsV2,
  getDevicesInDeviceGroup,
  getProjectsInDeviceGroup,
  createDeviceGroup,
  editDeviceGroup,
  deleteDeviceGroup,
  addDevicesToDeviceGroup,
  removeDevicesFromDeviceGroup,
  assignDeviceGroupToProject,
} from '../api/device-groups.js';
import { checkDestructiveGuard } from '../utils/destructive-guard.js';
import { applyMaxResults, appendTruncationNotice } from '../utils/pagination.js';
import { formatDeviceList, formatProjectList, formatDeviceGroupV2List } from '../utils/response-formatter.js';
import { outputFormatParam, respond } from '../utils/output-format.js';

export function registerDeviceGroupTools(server: McpServer): void {
  server.tool(
    'list_device_groups',
    'Lists all device groups in the system. ' +
    'Use this to find a group\'s numeric ID — required by get_devices_in_group, add_devices_to_group, remove_devices_from_group, assign_group_to_project, and the create_poc / close_poc / delete_poc workflows. ' +
    'Returns the Default device group ID (the source pool for POC device selection) and any named groups (e.g. "Acme Corp POC"). ' +
    'Device groups organize devices and control which projects can access which devices. Cloud Admin only.',
    {
      maxResults: z
        .number()
        .optional()
        .default(50)
        .describe('Maximum number of results to return (default: 50, max: 500).'),
      outputFormat: outputFormatParam,
    },
    async ({ maxResults, outputFormat }) => {
      try {
        // Try v2 first (Cloud Admin JWT) — returns richer data (numberOfDevices, type, acceptNewDevices).
        // Falls back to v1 (project API key) which returns a flat {id→name} dict.
        let v2Groups: Array<{ id: number | string; name: string; numberOfDevices?: number; type?: string; acceptNewDevices?: boolean }> | null = null;
        try {
          v2Groups = await getDeviceGroupsV2();
        } catch {
          // v2 unavailable (project key or older server) — fall through to v1
        }

        if (v2Groups && v2Groups.length > 0) {
          const paged = applyMaxResults(v2Groups, maxResults);
          const structured = {
            deviceGroups: paged.items.map(g => ({ id: String(g.id), name: g.name, numberOfDevices: g.numberOfDevices, type: g.type, acceptNewDevices: g.acceptNewDevices })),
          };
          const humanText = appendTruncationNotice(
            `Device Groups (${paged.total} total):\n` + formatDeviceGroupV2List(paged.items as Parameters<typeof formatDeviceGroupV2List>[0]),
            paged
          );
          return respond(outputFormat, structured, humanText);
        }

        // v1 fallback
        const groups = await getDeviceGroups();
        const entries = Object.entries(groups);
        const paged = applyMaxResults(entries, maxResults);
        const structured = {
          deviceGroups: paged.items.map(([id, name]) => ({ id, name })),
        };
        const lines = paged.items.map(([id, name]) => `  • ${name} (ID: ${id})`).join('\n');
        const humanText = appendTruncationNotice(
          `Device Groups (${paged.total} total):\n${lines || '  (none)'}`,
          paged
        );
        return respond(outputFormat, structured, humanText);
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  server.tool(
    'get_devices_in_group',
    'Lists all devices that belong to a specific device group. ' +
    'Optional client-side filters: osType (ios/android), status (Available/Offline/In Use/etc.), ' +
    'category (PHONE/TABLET/WATCH), excludeTags (exclude devices with any listed tag), ' +
    'requireTags (include only devices with all listed tags). ' +
    'Used in create_poc Step 3 to select eligible devices from the Default group. Cloud Admin only.',
    {
      groupId: z.string().describe('The numeric device group ID. Use list_device_groups to find it.'),
      osType: z
        .enum(['ios', 'android'])
        .optional()
        .describe("Filter by OS: 'ios' or 'android'. Case-insensitive match against the device OS field."),
      status: z
        .string()
        .optional()
        .describe("Filter by displayStatus (e.g. 'Available', 'Offline', 'In Use'). Exact case-insensitive match."),
      category: z
        .string()
        .optional()
        .describe("Filter by deviceCategory: 'PHONE', 'TABLET', 'WATCH', or 'UNKNOWN'. Exact case-insensitive match."),
      excludeTags: z
        .array(z.string())
        .optional()
        .describe('Exclude devices that have any of these tags (exact case-insensitive match per tag). Example: ["DoNotTake", "DONTTAKE", "DONOTUSE"].'),
      requireTags: z
        .array(z.string())
        .optional()
        .describe('Include only devices that have ALL of these tags (exact case-insensitive match per tag).'),
      maxResults: z
        .number()
        .optional()
        .default(50)
        .describe('Maximum number of results to return after filtering (default: 50, max: 500).'),
      outputFormat: outputFormatParam,
    },
    async ({ groupId, osType, status, category, excludeTags, requireTags, maxResults, outputFormat }) => {
      try {
        let devices = await getDevicesInDeviceGroup(groupId);

        if (osType) {
          const q = osType.toLowerCase();
          devices = devices.filter(d => (d.deviceOs ?? '').toLowerCase() === q);
        }
        if (status) {
          const q = status.toLowerCase();
          devices = devices.filter(d => (d.displayStatus ?? '').toLowerCase() === q);
        }
        if (category) {
          const q = category.toLowerCase();
          devices = devices.filter(d => (d.deviceCategory ?? '').toLowerCase() === q);
        }
        if (excludeTags && excludeTags.length > 0) {
          const excl = excludeTags.map(t => t.toLowerCase());
          devices = devices.filter(d =>
            !(d.tags ?? []).some(t => excl.includes(t.toLowerCase()))
          );
        }
        if (requireTags && requireTags.length > 0) {
          const req = requireTags.map(t => t.toLowerCase());
          devices = devices.filter(d => {
            const dtags = (d.tags ?? []).map(t => t.toLowerCase());
            return req.every(r => dtags.includes(r));
          });
        }

        const paged = applyMaxResults(devices, maxResults);
        const structured = {
          devices: paged.items.map(d => ({
            id: d.id,
            name: d.deviceName,
            osType: d.deviceOs,
            osVersion: d.osVersion,
            deviceCategory: d.deviceCategory,
            displayStatus: d.displayStatus,
            region: d.region || d.agentLocation || '',
            tags: d.tags,
          })),
        };
        const humanText = appendTruncationNotice(
          `Devices in group ${groupId} (${paged.total} total):\n\n${formatDeviceList(paged.items)}`,
          paged
        );
        return respond(outputFormat, structured, humanText);
      } catch (e) {
        const msg = (e as Error).message;
        if (msg.includes('[400]') && msg.toLowerCase().includes('not found')) {
          return { content: [{ type: 'text', text: `Device group ${groupId} not found or has already been deleted.` }], isError: true };
        }
        return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
      }
    }
  );

  server.tool(
    'get_projects_in_group',
    'Lists all projects that have access to a specific device group. Cloud Admin only.',
    {
      groupId: z.string().describe('The numeric device group ID.'),
      maxResults: z
        .number()
        .optional()
        .default(50)
        .describe('Maximum number of results to return (default: 50, max: 500).'),
      outputFormat: outputFormatParam,
    },
    async ({ groupId, maxResults, outputFormat }) => {
      try {
        const projects = await getProjectsInDeviceGroup(groupId);
        const paged = applyMaxResults(projects, maxResults);
        const structured = {
          projects: paged.items.map(p => ({ id: p.id, name: p.name })),
        };
        const humanText = appendTruncationNotice(
          `Projects with access to group ${groupId} (${paged.total} total):\n${formatProjectList(paged.items)}`,
          paged
        );
        return respond(outputFormat, structured, humanText);
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  server.tool(
    'create_device_group',
    'Creates a new device group. Device groups let you organize devices and control project access. Cloud Admin only.',
    {
      name: z.string().describe('Name for the new device group.'),
      acceptNewDevices: z
        .boolean()
        .optional()
        .describe('Whether new devices should be automatically added to this group.'),
    },
    async ({ name, acceptNewDevices }) => {
      try {
        const result = await createDeviceGroup({ name, acceptNewDevices });
        return {
          content: [
            {
              type: 'text',
              text: `✅ Device group "${name}" created with ID: ${result.id}`,
            },
          ],
        };
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  server.tool(
    'edit_device_group',
    'Renames a device group or changes whether it automatically accepts new devices. Cloud Admin only.',
    {
      groupId: z.string().describe('The numeric device group ID.'),
      name: z.string().optional().describe('New name for the group.'),
      acceptNewDevices: z
        .boolean()
        .optional()
        .describe('Whether new devices should be automatically added to this group.'),
    },
    async ({ groupId, name, acceptNewDevices }) => {
      try {
        await editDeviceGroup(groupId, { name, acceptNewDevices });
        return {
          content: [{ type: 'text', text: `✅ Device group ${groupId} updated.` }],
        };
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  server.tool(
    'delete_device_group',
    'Permanently deletes a device group. Note: the Default and Cleanup groups cannot be deleted. Devices in the group are not deleted — they remain in the system. Cloud Admin only. Requires confirmDeletion: true. ⚠️ POC teardown: use delete_poc instead — it handles the full sequence (device cleanup, user access revocation, then deletion).',
    {
      groupId: z.string().describe('The numeric device group ID.'),
      confirmDeletion: z
        .boolean()
        .describe('Must be true to confirm this destructive, irreversible operation. No changes are made without this.'),
    },
    async ({ groupId, confirmDeletion }) => {
      const guard = checkDestructiveGuard(confirmDeletion, `Delete device group ${groupId}`);
      if (guard) return { content: [{ type: 'text', text: guard }] };
      try {
        await deleteDeviceGroup(groupId);
        return {
          content: [{ type: 'text', text: `✅ Device group ${groupId} deleted.` }],
        };
      } catch (e) {
        const msg = (e as Error).message;
        if (msg.includes('[400]') && msg.toLowerCase().includes('not found')) {
          return { content: [{ type: 'text', text: `Device group ${groupId} not found or has already been deleted.` }], isError: true };
        }
        return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
      }
    }
  );

  server.tool(
    'add_devices_to_group',
    'Adds one or more devices to a device group. Cloud Admin only.',
    {
      groupId: z.string().describe('The numeric device group ID.'),
      deviceIds: z.array(z.string()).describe('List of device IDs to add to the group.'),
    },
    async ({ groupId, deviceIds }) => {
      try {
        await addDevicesToDeviceGroup(groupId, deviceIds);
        return {
          content: [
            {
              type: 'text',
              text: `✅ Added ${deviceIds.length} device(s) to group ${groupId}: ${deviceIds.join(', ')}`,
            },
          ],
        };
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  server.tool(
    'remove_devices_from_group',
    'Removes one or more devices from a device group. The devices remain in the system. Cloud Admin only. Requires confirmDeletion: true.',
    {
      groupId: z.string().describe('The numeric device group ID.'),
      deviceIds: z.array(z.string()).describe('List of device IDs to remove from the group.'),
      confirmDeletion: z
        .boolean()
        .describe('Must be true to confirm this destructive, irreversible operation. No changes are made without this.'),
    },
    async ({ groupId, deviceIds, confirmDeletion }) => {
      const guard = checkDestructiveGuard(
        confirmDeletion,
        `Remove ${deviceIds.length} device(s) from group ${groupId}`
      );
      if (guard) return { content: [{ type: 'text', text: guard }] };
      try {
        await removeDevicesFromDeviceGroup(groupId, deviceIds);
        return {
          content: [
            {
              type: 'text',
              text: `✅ Removed ${deviceIds.length} device(s) from group ${groupId}.`,
            },
          ],
        };
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  server.tool(
    'assign_group_to_project',
    'Grants a project access to a device group, allowing its users to see and use those devices. Cloud Admin only.',
    {
      projectId: z.string().describe('The numeric project ID.'),
      deviceGroupId: z.string().describe('The numeric device group ID.'),
    },
    async ({ projectId, deviceGroupId }) => {
      try {
        await assignDeviceGroupToProject(projectId, deviceGroupId);
        return {
          content: [
            {
              type: 'text',
              text: `✅ Device group ${deviceGroupId} assigned to project ${projectId}.`,
            },
          ],
        };
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );
}
