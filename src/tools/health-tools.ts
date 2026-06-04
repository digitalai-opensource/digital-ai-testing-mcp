import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getAllDevices } from '../api/devices.js';
import { getApplications } from '../api/applications.js';
import { getCurrentAndFutureReservations } from '../api/reservations.js';
import { getAllProvisioningProfiles } from '../api/provisioning-profiles.js';
import { getActiveSessions } from '../api/sessions.js';
import { getReporterProjects } from '../api/reporter-projects.js';
import { getLicenseInfo } from '../api/license.js';
import { applyMaxResults } from '../utils/pagination.js';
import { outputFormatParam, respond } from '../utils/output-format.js';

export function registerHealthTools(server: McpServer): void {
  server.tool(
    'get_environment_summary',
    'Returns a high-level environment dashboard: device counts by status (available/reserved/offline) and OS, total reservation count, and application repository totals. Use this for a "what is the state of the farm?" overview — it shows counts and totals only, not individual reservation details. To list full reservation records with user, device, and time details, use list_reservations instead.',
    {
      maxResults: z
        .number()
        .optional()
        .default(200)
        .describe('Maximum devices to include in the summary (default: 200).'),
      outputFormat: outputFormatParam,
    },
    async ({ maxResults, outputFormat }) => {
      try {
        const [devices, reservations, apps] = await Promise.all([
          getAllDevices(),
          getCurrentAndFutureReservations(),
          getApplications(),
        ]);

        const pagedDevices = applyMaxResults(devices, maxResults);

        const available = pagedDevices.items.filter(
          (d) => d.currentStatus.toLowerCase() === 'available'
        ).length;
        const reserved = pagedDevices.items.filter(
          (d) => d.currentStatus.toLowerCase() === 'reserved'
        ).length;
        const offline = pagedDevices.items.filter(
          (d) => d.currentStatus.toLowerCase() === 'offline'
        ).length;
        const ios = pagedDevices.items.filter((d) => d.deviceOs === 'iOS').length;
        const android = pagedDevices.items.filter((d) => d.deviceOs === 'Android').length;
        const iosApps = apps.filter((a) => a.osType === 'IOS').length;
        const androidApps = apps.filter((a) => a.osType === 'ANDROID').length;

        const structured = {
          devices: { total: pagedDevices.total, available, reserved, offline, ios, android },
          reservations: reservations.length,
          apps: { total: apps.length, ios: iosApps, android: androidApps },
        };
        const humanText = [
          `🌐 Digital.ai Environment Summary`,
          ``,
          `📱 Devices (${pagedDevices.total} total)`,
          `  🟢 Available: ${available}   🟡 Reserved: ${reserved}   🔴 Offline: ${offline}`,
          `  🍎 iOS: ${ios}   🤖 Android: ${android}`,
          ``,
          `📅 Current/Upcoming Reservations: ${reservations.length}`,
          ``,
          `📦 Applications in Repository: ${apps.length}`,
          `  iOS: ${iosApps}   Android: ${androidApps}`,
          pagedDevices.truncationNotice ? `\n${pagedDevices.truncationNotice}` : '',
        ]
          .filter((l) => l !== undefined)
          .join('\n');

        return respond(outputFormat, structured, humanText);
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  server.tool(
    'check_ios_readiness',
    'Checks whether iOS devices are available and whether any provisioning profiles are expiring soon. Useful before starting an iOS test run.',
    {
      expiryWarningDays: z
        .number()
        .optional()
        .default(30)
        .describe('Warn if a provisioning profile expires within this many days (default: 30).'),
      outputFormat: outputFormatParam,
    },
    async ({ expiryWarningDays, outputFormat }) => {
      try {
        const [devices, profiles] = await Promise.all([
          getAllDevices(),
          getAllProvisioningProfiles().catch(() => []),
        ]);

        const iosDevices = devices.filter((d) => d.deviceOs === 'iOS');
        const available = iosDevices.filter(
          (d) => d.currentStatus.toLowerCase() === 'available'
        );
        const offline = iosDevices.filter((d) => d.currentStatus.toLowerCase() === 'offline');

        const now = Date.now();
        const expiringProfiles = profiles.filter((p) => {
          const daysLeft = Math.floor(
            (new Date(p.expirationDate).getTime() - now) / (1000 * 60 * 60 * 24)
          );
          return daysLeft < expiryWarningDays;
        });
        const expiredProfiles = expiringProfiles.filter(
          (p) => new Date(p.expirationDate).getTime() < now
        );
        const soonProfiles = expiringProfiles.filter(
          (p) => new Date(p.expirationDate).getTime() >= now
        );

        const structured = {
          ready: available.length > 0,
          devices: { total: iosDevices.length, available: available.length, offline: offline.length },
          profiles: { total: profiles.length, expired: expiredProfiles.length, expiringSoon: soonProfiles.length },
        };

        const readiness = available.length > 0 ? '✅ READY' : '⚠️  NOT READY';

        const lines = [
          `🍎 iOS Readiness: ${readiness}`,
          ``,
          `Devices: ${iosDevices.length} total | ${available.length} available | ${offline.length} offline`,
        ];

        if (available.length > 0) {
          const sample = available.slice(0, 3).map((d) => `  • ${d.deviceName} (${d.osVersion})`);
          lines.push(`Available devices (sample):\n${sample.join('\n')}`);
        }

        if (expiredProfiles.length > 0) {
          lines.push(`\n🔴 EXPIRED profiles (${expiredProfiles.length}):`);
          expiredProfiles.forEach((p) =>
            lines.push(`  • ${p.profileName} — expired ${p.expirationDate}`)
          );
        }

        if (soonProfiles.length > 0) {
          lines.push(`\n🟡 Expiring within ${expiryWarningDays} days (${soonProfiles.length}):`);
          soonProfiles.forEach((p) =>
            lines.push(`  • ${p.profileName} — expires ${p.expirationDate}`)
          );
        }

        if (profiles.length > 0 && expiringProfiles.length === 0) {
          lines.push(`\n🟢 All ${profiles.length} provisioning profile(s) are valid.`);
        }

        return respond(outputFormat, structured, lines.join('\n'));
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  server.tool(
    'check_android_readiness',
    'Checks whether Android devices are available for testing. Shows available devices and flags any that are offline or stuck. ' +
    'Device counts are scoped to the project associated with your API key; if available shows 0, try find_available_device which may search a broader pool.',
    {
      outputFormat: outputFormatParam,
    },
    async ({ outputFormat }) => {
      try {
        const devices = await getAllDevices();
        const androidDevices = devices.filter((d) => d.deviceOs === 'Android');
        const available = androidDevices.filter(
          (d) => d.displayStatus.toLowerCase() === 'available'
        );
        const reserved = androidDevices.filter(
          (d) => d.displayStatus.toLowerCase() === 'reserved'
        );
        const offline = androidDevices.filter(
          (d) => d.displayStatus.toLowerCase() === 'offline'
        );

        const structured = {
          ready: available.length > 0,
          devices: { total: androidDevices.length, available: available.length, reserved: reserved.length, offline: offline.length },
          scopeNote: available.length === 0
            ? 'Device counts reflect the project-scoped pool for your API key. find_available_device may locate devices in a broader pool — try it even if available shows 0.'
            : undefined,
        };

        const readiness = available.length > 0 ? '✅ READY' : '⚠️  NOT READY';

        const lines = [
          `🤖 Android Readiness: ${readiness}`,
          ``,
          `Devices: ${androidDevices.length} total`,
          `  🟢 Available: ${available.length}`,
          `  🟡 Reserved: ${reserved.length}`,
          `  🔴 Offline: ${offline.length}`,
          available.length === 0
            ? `\nNote: counts are project-scoped. If 0, try find_available_device — it may search a broader device pool.`
            : '',
        ];

        if (available.length > 0) {
          const sample = available
            .slice(0, 5)
            .map(
              (d) =>
                `  • ${d.deviceName} (Android ${d.osVersion}) — Agent: ${d.agentName}`
            );
          lines.push(`\nAvailable devices:\n${sample.join('\n')}`);
          if (available.length > 5)
            lines.push(`  ... and ${available.length - 5} more.`);
        }

        if (offline.length > 0) {
          lines.push(`\nOffline devices (${offline.length}):`);
          offline.slice(0, 5).forEach((d) =>
            lines.push(`  🔴 ${d.deviceName} — offline for ${d.statusAgeInMinutes} min`)
          );
        }

        return respond(outputFormat, structured, lines.join('\n'));
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  server.tool(
    'get_agent_status',
    'Shows the connection status and device counts for all agents (the machines that host your physical devices). Useful for identifying agent connectivity problems.',
    {
      maxResults: z
        .number()
        .optional()
        .default(200)
        .describe('Maximum devices to include in the agent analysis (default: 200).'),
      outputFormat: outputFormatParam,
    },
    async ({ maxResults, outputFormat }) => {
      try {
        const devices = await getAllDevices();
        const paged = applyMaxResults(devices, maxResults);

        const agentMap: Record<
          string,
          { total: number; available: number; reserved: number; offline: number; ip: string }
        > = {};

        for (const d of paged.items) {
          if (!agentMap[d.agentName]) {
            agentMap[d.agentName] = {
              total: 0,
              available: 0,
              reserved: 0,
              offline: 0,
              ip: d.agentIp,
            };
          }
          agentMap[d.agentName].total++;
          const status = d.currentStatus.toLowerCase();
          if (status === 'available') agentMap[d.agentName].available++;
          else if (status === 'reserved') agentMap[d.agentName].reserved++;
          else if (status === 'offline') agentMap[d.agentName].offline++;
        }

        const agents = Object.entries(agentMap).sort((a, b) => a[0].localeCompare(b[0]));

        if (agents.length === 0) {
          return respond(outputFormat, { total: 0, deviceTotal: paged.total, agents: [] }, 'No agents found.');
        }

        const structured = {
          total: agents.length,
          deviceTotal: paged.total,
          agents: agents.map(([name, counts]) => ({
            name,
            ip: counts.ip,
            total: counts.total,
            available: counts.available,
            reserved: counts.reserved,
            offline: counts.offline,
          })),
        };

        const lines = [
          `🖥️  Agent Status (${agents.length} agent(s), ${paged.total} devices total):`,
          '',
        ];

        for (const [name, counts] of agents) {
          const statusIcon = counts.offline === counts.total ? '🔴' : counts.available > 0 ? '🟢' : '🟡';
          lines.push(
            `${statusIcon} ${name} (${counts.ip})`
          );
          lines.push(
            `   ${counts.total} devices: ${counts.available} available, ${counts.reserved} reserved, ${counts.offline} offline`
          );
        }

        if (paged.truncationNotice) lines.push(`\n${paged.truncationNotice}`);

        return respond(outputFormat, structured, lines.join('\n'));
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  server.tool(
    'list_active_sessions',
    'List currently active browser/Selenium test sessions on the platform. Shows session owner, agent, product, and project. ' +
    'This is the authoritative source for active sessions — unlike list_active_test_executions which uses a heuristic (null duration), ' +
    'this queries the actual session registry. Cloud Admin only.',
    {
      username: z.string().optional().describe('Filter by session owner (client-side, partial match).'),
      outputFormat: outputFormatParam,
    },
    async ({ username, outputFormat }) => {
      try {
        let sessions = await getActiveSessions();
        if (username) {
          const q = username.toLowerCase();
          sessions = sessions.filter(s => s.username.toLowerCase().includes(q));
        }
        const structured = {
          count: sessions.length,
          sessions: sessions.map(s => ({
            sessionId: s.sessionID,
            username: s.username,
            product: s.productName,
            agent: s.ip,
            project: s.projectname,
            lastAlive: new Date(s.lastAliveTime).toISOString(),
          })),
        };
        if (sessions.length === 0) {
          return respond(outputFormat, structured, 'No active sessions found.');
        }
        const lines = [`🔴 Active sessions (${sessions.length}):\n`];
        for (const s of sessions) {
          lines.push(
            `  • ${s.username} — ${s.productName}`,
            `    Agent: ${s.ip} | Project: ${s.projectname}`,
            `    Last alive: ${new Date(s.lastAliveTime).toISOString()}`,
            ''
          );
        }
        return respond(outputFormat, structured, lines.join('\n'));
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  server.tool(
    'get_reporter_project_storage',
    'Show disk storage usage per project in the reporter. Useful for identifying which projects are consuming the most test artifact storage. ' +
    'Returns current usage (MB), quota (MB), usage percentage, and artifact counts. Cloud Admin only.',
    {
      sortBy: z
        .enum(['currentDiskStorageInMB', 'usagePct', 'dataItemsCount', 'name'])
        .optional()
        .default('currentDiskStorageInMB')
        .describe('Sort by this field (default: currentDiskStorageInMB descending).'),
      maxResults: z.number().optional().default(50).describe('Maximum results (default: 50).'),
      outputFormat: outputFormatParam,
    },
    async ({ sortBy, maxResults, outputFormat }) => {
      try {
        const projects = await getReporterProjects();
        const sorted = [...projects].sort((a, b) => {
          if (sortBy === 'name') return a.name.localeCompare(b.name);
          return (b[sortBy as keyof typeof b] as number) - (a[sortBy as keyof typeof a] as number);
        });
        const paged = applyMaxResults(sorted, maxResults);
        const structured = {
          total: paged.total,
          projects: paged.items.map(p => ({
            id: p.id,
            name: p.name,
            currentDiskStorageMB: p.currentDiskStorageInMB,
            quotaMB: p.diskStorageThresholdInMB,
            usagePct: parseFloat(p.usagePct.toFixed(1)),
            dataItemsCount: p.dataItemsCount,
          })),
        };
        const lines = [`📦 Reporter Project Storage (${paged.total} projects):\n`];
        for (const p of paged.items) {
          const bar = '█'.repeat(Math.min(20, Math.floor(p.usagePct / 5))) + '░'.repeat(Math.max(0, 20 - Math.floor(p.usagePct / 5)));
          lines.push(`  ${p.name}`);
          lines.push(`    ${bar} ${p.usagePct.toFixed(1)}% — ${p.currentDiskStorageInMB}MB / ${p.diskStorageThresholdInMB}MB (${p.dataItemsCount} items)`);
        }
        return respond(outputFormat, structured, lines.join('\n'));
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  server.tool(
    'get_license_info',
    'Show the platform license limits: maximum dedicated devices, shared devices, virtual devices, and browser sessions. ' +
    'These are the licensed maximums, not current usage counts. Cloud Admin only.',
    {
      outputFormat: outputFormatParam,
    },
    async ({ outputFormat }) => {
      try {
        const info = await getLicenseInfo();
        const structured = info as unknown as object;
        const lines = [
          `📋 Platform License Limits:`,
          `  Dedicated devices:  ${info.dedicatedDevices}`,
          `  Shared devices:     ${info.sharedDevices}`,
          `  Virtual devices:    ${info.virtualDevices}`,
          `  Browser sessions:   ${info.browsers}`,
        ];
        return respond(outputFormat, structured, lines.join('\n'));
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  // ─── get_license_utilization ──────────────────────────────────────────────

  server.tool(
    'get_license_utilization',
    'Compare current usage against purchased license limits for devices and browser sessions. ' +
    'Shows how close the lab is to capacity — useful for capacity planning and alerting ' +
    'before a test run saturates the farm. Cloud Admin only.',
    {
      outputFormat: outputFormatParam,
    },
    async ({ outputFormat }) => {
      try {
        const [info, devices, sessions] = await Promise.all([
          getLicenseInfo(),
          getAllDevices(),
          getActiveSessions().catch(() => []),   // Sessions endpoint is JWT-only; soft-fail
        ]);

        // Device utilization
        const inUse     = devices.filter(d => d.displayStatus.toLowerCase() === 'in use' || d.displayStatus.toLowerCase() === 'reserved').length;
        const available = devices.filter(d => d.displayStatus.toLowerCase() === 'available').length;
        const offline   = devices.filter(d => d.displayStatus.toLowerCase() === 'offline' || d.displayStatus.toLowerCase() === 'error').length;
        const totalDevices = devices.length;

        // Browser sessions
        const activeBrowserSessions = sessions.length;

        const pct = (used: number, limit: number) =>
          limit > 0 ? `${((used / limit) * 100).toFixed(1)}%` : 'n/a';

        const structured = {
          devices: {
            inUse,
            available,
            offline,
            total: totalDevices,
            dedicatedLimit: info.dedicatedDevices,
            sharedLimit: info.sharedDevices,
            utilizationPct: parseFloat(((inUse / Math.max(totalDevices, 1)) * 100).toFixed(1)),
          },
          browsers: {
            activeSessions: activeBrowserSessions,
            limit: info.browsers,
            utilizationPct: info.browsers > 0
              ? parseFloat(((activeBrowserSessions / info.browsers) * 100).toFixed(1))
              : null,
          },
          license: {
            dedicatedDevices: info.dedicatedDevices,
            sharedDevices: info.sharedDevices,
            virtualDevices: info.virtualDevices,
            browsers: info.browsers,
          },
        };

        const lines = [
          `🔑 License Utilization\n`,
          `  Devices`,
          `    In Use / Reserved: ${inUse}`,
          `    Available:         ${available}`,
          `    Offline / Error:   ${offline}`,
          `    Total in farm:     ${totalDevices}`,
          `    Farm utilization:  ${pct(inUse, totalDevices)} (${inUse} of ${totalDevices} in active use)`,
          `    Dedicated limit:   ${info.dedicatedDevices}`,
          `    Shared limit:      ${info.sharedDevices}`,
          ``,
          `  Browser Sessions`,
          `    Active now:   ${activeBrowserSessions}`,
          `    Limit:        ${info.browsers}`,
          `    Utilization:  ${pct(activeBrowserSessions, info.browsers)}`,
          ``,
          `  Virtual Devices limit: ${info.virtualDevices}`,
        ];
        return respond(outputFormat, structured, lines.join('\n'));
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );
}
