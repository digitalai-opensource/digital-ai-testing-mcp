import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  getAllProjects,
  createProject,
  deleteProject,
  getUsersInProject,
  assignUserToProject,
  unassignUserFromProject,
  getProjectTokens,
  setProjectTokens,
  getWebCleanup,
  setWebCleanup,
  getWebhookCleanup,
  setWebhookCleanup,
  getMaxReservations,
  setMaxReservations,
  getMaxQueuedTests,
  setMaxQueuedTests,
  getProjectNotes,
  setProjectNotes,
  getProjectDevices,
  setTelephonyStatus,
  getMaxConcurrentBrowserSessions,
  setMaxConcurrentBrowserSessions,
  getAutomationProperties,
  assignApplicationToProject,
  getProjectAdminDetail,
} from '../api/projects.js';
import { getDeviceGroups } from '../api/device-groups.js';
import { checkDestructiveGuard } from '../utils/destructive-guard.js';
import { applyMaxResults, appendTruncationNotice } from '../utils/pagination.js';
import { formatProjectList, formatDeviceList } from '../utils/response-formatter.js';
import { outputFormatParam, respond } from '../utils/output-format.js';

export function registerProjectTools(server: McpServer): void {
  server.tool(
    'list_projects',
    'Lists all projects in the Digital.ai environment. ' +
    'Use this to find a project\'s numeric ID — required by assign_user_to_project, get_project_settings, assign_app_to_project, delete_project, and the create_poc / close_poc / delete_poc workflows. ' +
    'Filter by name to find a specific project (e.g. "Default", "Acme Corp POC"). ' +
    'Returns the Default project ID used as the baseline in POC provisioning.',
    {
      name: z.string().optional().describe('Filter by project name (partial match, case-insensitive).'),
      sortBy: z
        .enum(['name', 'id'])
        .optional()
        .describe('Sort results by this field (client-side). Default: platform order.'),
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
    async ({ name, sortBy, sortOrder, maxResults, outputFormat }) => {
      try {
        let projects = await getAllProjects();
        if (name) {
          const q = name.toLowerCase();
          projects = projects.filter(p => p.name.toLowerCase().includes(q));
        }
        if (sortBy) {
          projects = [...projects].sort((a, b) => {
            const av = String(a[sortBy as keyof typeof a] ?? '').toLowerCase();
            const bv = String(b[sortBy as keyof typeof b] ?? '').toLowerCase();
            return sortOrder === 'desc' ? bv.localeCompare(av) : av.localeCompare(bv);
          });
        }
        const paged = applyMaxResults(projects, maxResults);
        const structured = {
          projects: paged.items.map(p => ({ id: p.id, name: p.name, isAppiumOss: p.isAppiumOss ?? false })),
        };
        const humanText = appendTruncationNotice(
          `Found ${paged.total} project(s):\n\n${formatProjectList(paged.items)}`,
          paged
        );
        return respond(outputFormat, structured, humanText);
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  server.tool(
    'create_project',
    'Creates a new project. Projects organize users, devices, and apps into isolated workspaces. Cloud Admin only. You can specify the device group by name (deviceGroupName) or by numeric ID (deviceGroupId) — if both are omitted, the platform assigns the default group.',
    {
      name: z.string().describe('Name for the new project.'),
      deviceGroupId: z
        .string()
        .optional()
        .describe('Numeric ID of the device group. Use deviceGroupName instead if you know the group name.'),
      deviceGroupName: z
        .string()
        .optional()
        .describe('Device group name (e.g. "Default"). Resolved to an ID internally. Use list_device_groups to see available groups.'),
      appiumOSS: z
        .boolean()
        .optional()
        .describe('Configure as an Appium OSS / Appium Server project. Default: true.'),
    },
    async ({ name, deviceGroupId, deviceGroupName, appiumOSS }) => {
      try {
        let resolvedGroupId = deviceGroupId;
        if (!resolvedGroupId && deviceGroupName) {
          const groups = await getDeviceGroups();
          const entry = Object.entries(groups).find(
            ([, gName]) => gName.toLowerCase() === deviceGroupName.toLowerCase()
          );
          if (!entry) {
            const available = Object.values(groups).join(', ');
            return {
              content: [{ type: 'text', text: `Error: No device group named "${deviceGroupName}". Available groups: ${available}` }],
              isError: true,
            };
          }
          resolvedGroupId = entry[0];
        }
        const project = await createProject({ name, deviceGroupId: resolvedGroupId, appiumOSS });
        return {
          content: [
            {
              type: 'text',
              text: `✅ Project "${name}" created with ID: ${project.id}` +
                (resolvedGroupId ? `\nDevice group: ${deviceGroupName ?? resolvedGroupId} (ID: ${resolvedGroupId})` : ''),
            },
          ],
        };
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  server.tool(
    'delete_project',
    'Permanently deletes a project. If deleteUsers is true, users belonging only to this project are also deleted. Cloud Admin only. Requires confirmDeletion: true. ⚠️ POC teardown: use delete_poc instead — it handles the full sequence (device cleanup, user access revocation, then deletion).',
    {
      projectId: z.number().describe('The numeric project ID.'),
      deleteUsers: z
        .boolean()
        .optional()
        .default(false)
        .describe('Also delete users who belong only to this project.'),
      confirmDeletion: z
        .boolean()
        .describe('Must be true to confirm this destructive, irreversible operation. No changes are made without this.'),
    },
    async ({ projectId, deleteUsers, confirmDeletion }) => {
      const guard = checkDestructiveGuard(confirmDeletion, `Delete project ${projectId}`);
      if (guard) return { content: [{ type: 'text', text: guard }] };
      try {
        await deleteProject(projectId, deleteUsers);
        return {
          content: [{ type: 'text', text: `✅ Project ${projectId} deleted.${deleteUsers ? ' Associated users also deleted.' : ''}` }],
        };
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  server.tool(
    'list_project_users',
    'Lists all users who have access to a specific project. Provide either projectId (numeric) or projectName (e.g. "Default") — at least one is required. Supports filtering by username and sorting.',
    {
      projectId: z
        .number()
        .optional()
        .describe('The numeric project ID. Use list_projects to find it. Alternative to projectName.'),
      projectName: z
        .string()
        .optional()
        .describe('The project name, e.g. "Default". Looked up automatically. Alternative to projectId.'),
      username: z.string().optional().describe('Filter by username (partial match, case-insensitive).'),
      role: z
        .enum(['User', 'ProjectAdmin'])
        .optional()
        .describe("Filter by role: 'User' or 'ProjectAdmin'."),
      sortBy: z
        .enum(['username', 'role'])
        .optional()
        .describe('Sort results by this field (client-side). Default: platform order.'),
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
    async ({ projectId, projectName, username, role, sortBy, sortOrder, maxResults, outputFormat }) => {
      try {
        let resolvedId = projectId;
        if (resolvedId === undefined) {
          if (!projectName) {
            return {
              content: [{ type: 'text', text: 'Error: Provide either projectId or projectName.' }],
              isError: true,
            };
          }
          const projects = await getAllProjects();
          const match = projects.find((p) => p.name.toLowerCase() === projectName.toLowerCase());
          if (!match) {
            const available = projects.map((p) => `"${p.name}"`).join(', ');
            return {
              content: [{ type: 'text', text: `Error: No project found with name "${projectName}". Available projects: ${available}` }],
              isError: true,
            };
          }
          resolvedId = match.id;
        }
        let users = await getUsersInProject(resolvedId);
        if (username) {
          const q = username.toLowerCase();
          users = users.filter(u => u.username.toLowerCase().includes(q));
        }
        if (role) {
          users = users.filter(u => u.role === role);
        }
        if (sortBy) {
          users = [...users].sort((a, b) => {
            const av = String(a[sortBy as keyof typeof a] ?? '').toLowerCase();
            const bv = String(b[sortBy as keyof typeof b] ?? '').toLowerCase();
            return sortOrder === 'desc' ? bv.localeCompare(av) : av.localeCompare(bv);
          });
        }
        const paged = applyMaxResults(users, maxResults);
        const structured = {
          projectId: resolvedId,
          users: paged.items.map(u => ({
            id: u.id,
            username: u.username,
            role: u.role,
            allowToReserveDevice: u.allowToReserveDevice,
          })),
        };
        const lines = paged.items.map(
          (u) =>
            `  • ${u.username} (ID: ${u.id}) — Role: ${u.role} | Can Reserve Devices: ${u.allowToReserveDevice}`
        );
        const label = projectName ? `"${projectName}" (ID: ${resolvedId})` : `${resolvedId}`;
        const humanText = appendTruncationNotice(
          `Users in project ${label} (${paged.total} total):\n${lines.join('\n')}`,
          paged
        );
        return respond(outputFormat, structured, humanText);
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  server.tool(
    'assign_user_to_project',
    'Grants a user access to a project with a specified role. Cloud Admin only.',
    {
      projectId: z.number().describe('The numeric project ID.'),
      userId: z.number().describe('The numeric user ID.'),
      role: z
        .enum(['User', 'ProjectAdmin'])
        .optional()
        .describe("Role in the project: 'User' or 'ProjectAdmin'."),
    },
    async ({ projectId, userId, role }) => {
      try {
        await assignUserToProject(projectId, userId, role);
        return {
          content: [
            {
              type: 'text',
              text: `✅ User ${userId} assigned to project ${projectId}${role ? ` as ${role}` : ''}.`,
            },
          ],
        };
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  server.tool(
    'remove_user_from_project',
    "Removes a user's access from a project. Their account is not deleted. Cloud Admin only. Requires confirmDeletion: true.",
    {
      projectId: z.number().describe('The numeric project ID.'),
      userId: z.number().describe('The numeric user ID.'),
      confirmDeletion: z
        .boolean()
        .describe('Must be true to confirm this destructive, irreversible operation. No changes are made without this.'),
    },
    async ({ projectId, userId, confirmDeletion }) => {
      const guard = checkDestructiveGuard(
        confirmDeletion,
        `Remove user ${userId} from project ${projectId}`
      );
      if (guard) return { content: [{ type: 'text', text: guard }] };
      try {
        await unassignUserFromProject(projectId, userId);
        return {
          content: [
            {
              type: 'text',
              text: `✅ User ${userId} removed from project ${projectId}.`,
            },
          ],
        };
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  server.tool(
    'get_project_tokens',
    'Gets the token configuration for a project, showing how test execution tokens are managed.',
    {
      projectId: z.number().describe('The numeric project ID.'),
      outputFormat: outputFormatParam,
    },
    async ({ projectId, outputFormat }) => {
      try {
        const tokens = await getProjectTokens(projectId);
        const structured = { projectId, tokens };
        const humanText = `Token configuration for project ${projectId}:\n${JSON.stringify(tokens, null, 2)}`;
        return respond(outputFormat, structured, humanText);
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  server.tool(
    'set_project_tokens',
    'Updates the token management mode for a project. Cloud Admin only.',
    {
      projectId: z.number().describe('The numeric project ID.'),
      tokenMode: z.boolean().describe('Enable (true) or disable (false) token mode for the project.'),
      amend: z
        .string()
        .optional()
        .describe("Number of tokens to allocate to the project (as a string, e.g. '100' or '1000')."),
    },
    async ({ projectId, tokenMode, amend }) => {
      try {
        await setProjectTokens(projectId, tokenMode, amend);
        return {
          content: [
            { type: 'text', text: `✅ Token mode for project ${projectId} set to: ${tokenMode}` },
          ],
        };
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  server.tool(
    'get_project_settings',
    'Gets the configuration settings for a project, including cleanup, limits, and telephony options.',
    {
      projectId: z.number().describe('The numeric project ID.'),
      outputFormat: outputFormatParam,
    },
    async ({ projectId, outputFormat }) => {
      try {
        const [webCleanup, webhookCleanup, maxRes, maxQueued, maxBrowser, notes] =
          await Promise.all([
            getWebCleanup(projectId),
            getWebhookCleanup(projectId),
            getMaxReservations(projectId),
            getMaxQueuedTests(projectId),
            getMaxConcurrentBrowserSessions(projectId),
            getProjectNotes(projectId),
          ]);

        const structured = {
          projectId,
          webCleanup,
          webhookCleanup,
          maxReservations: maxRes,
          maxQueuedTests: maxQueued,
          maxConcurrentBrowserSessions: maxBrowser,
          notes,
        };
        const humanText = [
          `⚙️  Settings for project ${projectId}:`,
          `Web Cleanup: ${webCleanup}`,
          `Webhook Cleanup: ${webhookCleanup}`,
          `Max Reservations: ${maxRes}`,
          `Max Queued Tests: ${maxQueued}`,
          `Max Concurrent Browsers: ${maxBrowser}`,
          `Notes: ${notes ?? 'none'}`,
        ].join('\n');

        return respond(outputFormat, structured, humanText);
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  server.tool(
    'update_project_settings',
    'Updates project configuration such as cleanup behavior and concurrency limits. Cloud Admin only.',
    {
      projectId: z.number().describe('The numeric project ID.'),
      webCleanup: z.boolean().optional().describe('Enable/disable web cleanup after sessions.'),
      webhookCleanup: z.boolean().optional().describe('Enable/disable webhook cleanup.'),
      maxReservations: z.number().optional().describe('Maximum concurrent device reservations.'),
      maxQueuedTests: z.number().optional().describe('Maximum queued tests.'),
      maxConcurrentBrowserSessions: z.number().optional().describe('Maximum concurrent browser sessions.'),
    },
    async ({
      projectId,
      webCleanup,
      webhookCleanup,
      maxReservations,
      maxQueuedTests,
      maxConcurrentBrowserSessions,
    }) => {
      try {
        const updates: string[] = [];

        if (webCleanup !== undefined) {
          await setWebCleanup(projectId, webCleanup);
          updates.push(`Web Cleanup: ${webCleanup}`);
        }
        if (webhookCleanup !== undefined) {
          await setWebhookCleanup(projectId, webhookCleanup);
          updates.push(`Webhook Cleanup: ${webhookCleanup}`);
        }
        if (maxReservations !== undefined) {
          await setMaxReservations(projectId, maxReservations);
          updates.push(`Max Reservations: ${maxReservations}`);
        }
        if (maxQueuedTests !== undefined) {
          await setMaxQueuedTests(projectId, maxQueuedTests);
          updates.push(`Max Queued Tests: ${maxQueuedTests}`);
        }
        if (maxConcurrentBrowserSessions !== undefined) {
          await setMaxConcurrentBrowserSessions(projectId, maxConcurrentBrowserSessions);
          updates.push(`Max Concurrent Browsers: ${maxConcurrentBrowserSessions}`);
        }

        if (updates.length === 0) {
          return {
            content: [{ type: 'text', text: 'No settings were specified to update.' }],
          };
        }

        return {
          content: [
            {
              type: 'text',
              text: `✅ Project ${projectId} settings updated:\n${updates.map((u) => `  • ${u}`).join('\n')}`,
            },
          ],
        };
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  server.tool(
    'set_telephony_status',
    'Enables or disables phone calls and SMS capabilities for a project. Cloud Admin only.',
    {
      projectId: z.number().describe('The numeric project ID.'),
      allowCalls: z.boolean().describe('Whether to allow phone calls.'),
      allowSMS: z.boolean().describe('Whether to allow SMS.'),
    },
    async ({ projectId, allowCalls, allowSMS }) => {
      try {
        await setTelephonyStatus(projectId, allowCalls, allowSMS);
        return {
          content: [
            {
              type: 'text',
              text: `✅ Telephony settings for project ${projectId} updated.\nCalls: ${allowCalls} | SMS: ${allowSMS}`,
            },
          ],
        };
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  server.tool(
    'get_project_notes',
    'Gets the notes/description for a project.',
    {
      projectId: z.number().describe('The numeric project ID.'),
      outputFormat: outputFormatParam,
    },
    async ({ projectId, outputFormat }) => {
      try {
        const notes = await getProjectNotes(projectId);
        const structured = { projectId, notes: notes ?? null };
        const humanText = notes
          ? `Notes for project ${projectId}:\n${notes}`
          : `Project ${projectId} has no notes.`;
        return respond(outputFormat, structured, humanText);
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  server.tool(
    'set_project_notes',
    'Sets or updates the notes/description for a project.',
    {
      projectId: z.number().describe('The numeric project ID.'),
      notes: z.string().describe('The notes text to set for this project.'),
    },
    async ({ projectId, notes }) => {
      try {
        await setProjectNotes(projectId, notes);
        return {
          content: [{ type: 'text', text: `✅ Notes updated for project ${projectId}.` }],
        };
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  server.tool(
    'get_project_devices',
    'Lists all devices accessible to a specific project.',
    {
      projectId: z.number().describe('The numeric project ID.'),
      maxResults: z
        .number()
        .optional()
        .default(50)
        .describe('Maximum number of results to return (default: 50, max: 500).'),
      outputFormat: outputFormatParam,
    },
    async ({ projectId, maxResults, outputFormat }) => {
      try {
        const devices = await getProjectDevices(projectId);
        const paged = applyMaxResults(devices, maxResults);
        const structured = {
          projectId,
          devices: paged.items.map(d => ({
            id: d.id,
            name: d.deviceName,
            osType: d.deviceOs,
            osVersion: d.osVersion,
            deviceCategory: d.deviceCategory,
            displayStatus: d.displayStatus,
            region: d.region,
          })),
        };
        const humanText = appendTruncationNotice(
          `Devices for project ${projectId} (${paged.total} total):\n\n${formatDeviceList(paged.items)}`,
          paged
        );
        return respond(outputFormat, structured, humanText);
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  server.tool(
    'get_automation_properties',
    'Gets automation properties (Appium capabilities and other test settings) for a project or all projects.',
    {
      projectId: z
        .number()
        .optional()
        .describe('The numeric project ID. Leave blank to get properties for all projects.'),
      outputFormat: outputFormatParam,
    },
    async ({ projectId, outputFormat }) => {
      try {
        const props = await getAutomationProperties(projectId);
        if (props.length === 0) {
          return respond(outputFormat, { properties: [] }, 'No automation properties found.');
        }
        const structured = {
          properties: props.map(p => ({
            id: p.id,
            projectId: p.projectId,
            propertyGroup: p.propertyGroup,
            propertyName: p.propertyName,
            propertyValue: p.propertyValue,
            dataType: p.dataType,
          })),
        };
        const lines = props.map(
          (p) =>
            `  • [${p.propertyGroup}] ${p.propertyName} = ${p.propertyValue} (${p.dataType}) — Project: ${p.projectId}`
        );
        const humanText = `Automation Properties (${props.length}):\n${lines.join('\n')}`;
        return respond(outputFormat, structured, humanText);
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  server.tool(
    'assign_app_to_project',
    'Makes an application available to a specific project, so project users can install and use it.',
    {
      projectId: z.number().describe('The numeric project ID.'),
      applicationId: z.number().describe('The numeric application ID.'),
    },
    async ({ projectId, applicationId }) => {
      try {
        await assignApplicationToProject(projectId, applicationId);
        return {
          content: [
            {
              type: 'text',
              text: `✅ Application ${applicationId} assigned to project ${projectId}.`,
            },
          ],
        };
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  // ─── get_project_admin_settings ───────────────────────────────────────────

  server.tool(
    'get_project_admin_settings',
    'Returns the full administrative configuration for a project using the v2 API — ' +
    '35+ fields in a single call including per-type license limits, all cleanup flags, ' +
    'reservation policies, feature flags, and user/app counts. ' +
    'Supersedes get_project_settings for admin use cases. ' +
    'Cloud Admin JWT only — project API keys receive 403.',
    {
      projectId: z.number().int().describe('Numeric project ID (use list_projects to find it).'),
      outputFormat: outputFormatParam,
    },
    async ({ projectId, outputFormat }) => {
      try {
        const p = await getProjectAdminDetail(projectId);

        const licenseLines = [
          `  Development:    ${p.maxDevelopmentLicense === -1 ? 'unlimited' : p.maxDevelopmentLicense}`,
          `  Manual:         ${p.maxManualLicense === -1 ? 'unlimited' : p.maxManualLicense}`,
          `  Grid:           ${p.maxGridLicenses === -1 ? 'unlimited' : p.maxGridLicenses}`,
          `  Emulators:      ${p.maxEmulatorsLicense === -1 ? 'unlimited' : p.maxEmulatorsLicense}`,
          `  Selenium:       ${p.maxSeleniumSessions === -1 ? 'unlimited' : p.maxSeleniumSessions}`,
          `  Queued tests:   ${p.maxQueuedTests === -1 ? 'unlimited' : p.maxQueuedTests}`,
          `  Grid memory:    ${p.maxGridMemory}MB`,
        ];

        const reservationLines = [
          `  Max reservations:         ${p.maxReservations === 0 ? 'unlimited' : p.maxReservations}`,
          `  Max per user:             ${p.maxReservationsPerUser === 0 ? 'unlimited' : p.maxReservationsPerUser}`,
          `  Max duration (min):       ${p.maxReservationTime === 0 ? 'unlimited' : p.maxReservationTime}`,
          `  Min notes required (min): ${p.minNotesReservationTime === -1 ? 'none' : p.minNotesReservationTime}`,
        ];

        const flag = (b: boolean) => b ? '✅' : '❌';
        const cleanupLines = [
          `  Cache:                    ${flag(p.enableCacheCleanup)}`,
          `  Applications:             ${flag(p.enableApplicationsCleanup)}`,
          `  Language/Region:          ${flag(p.enableResetLanguageAndRegion)}`,
          `  iOS Config Profiles:      ${flag(p.enableIosConfigurationProfileCleanup)}`,
          `  WiFi/Proxy:               ${flag(p.enableWifiAndProxyCleanup)}`,
          `  Media Folders:            ${flag(p.enableMediaFoldersCleanup)}`,
          `  Webhook:                  ${flag(p.enableWebhookCleanup)}`,
          `  Device Logs:              ${flag(p.enableClearDeviceLogs)}`,
          `  iOS Passcode:             ${flag(p.enableIosPasscodeCleanup)}`,
          `  Device:                   ${flag(p.enableDeviceCleanup)}`,
          `  Close Apps:               ${flag(p.closeAppsAfterCleanup)}`,
          `  Allow release w/o cleanup:${flag(p.enableReleaseWithoutCleanup)}`,
        ];

        const humanText = [
          `⚙️  Admin Settings: ${p.name} (ID: ${p.id})`,
          `   Users: ${p.amountOfUsers} | Applications: ${p.amountOfApplications}`,
          `   Notes: ${p.notes ?? 'none'}`,
          `   App retention: ${p.daysToKeepApplications} days | Auto-delete old: ${flag(p.deleteOldApplications)}`,
          '',
          '── License Limits ──',
          ...licenseLines,
          '',
          '── Reservation Policy ──',
          ...reservationLines,
          '',
          '── Cleanup Flags ──',
          ...cleanupLines,
          '',
          '── Feature Flags ──',
          `  Accessibility testing:        ${flag(p.accessibilityTesting)}`,
          `  Allow SMS:                    ${flag(p.allowSMS)}`,
          `  Allow calls:                  ${flag(p.allowCalls)}`,
          `  File repository:              ${flag(p.enableFileRepository)}`,
          `  File repo user-accessible:    ${flag(p.enableFileRepositoryUserAccessible)}`,
          `  Expose sessions to users:     ${flag(p.exposeSessionsToProjectUsers)}`,
          `  Expose debug to users:        ${flag(p.exposeDebugToProjectUsers)}`,
          `  Admins can change automation: ${flag(p.allowProjectAdminsChangeAutomation)}`,
          `  Default Appium version:       ${p.defaultAppiumServerVersion ?? 'platform default'}`,
        ].join('\n');

        return respond(outputFormat, p as unknown as object, humanText);
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );
}
