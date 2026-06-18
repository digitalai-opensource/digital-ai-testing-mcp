import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  getCurrentAndFutureReservations,
  addReservation,
  deleteReservation,
} from '../api/reservations.js';
import { getDeviceReservations, reserveDevice } from '../api/devices.js';
import { formatDeviceTimestamp } from '../api/client.js';
import { resolveDevice, formatResolvedDevice } from '../utils/device-resolver.js';
import { checkDestructiveGuard } from '../utils/destructive-guard.js';
import { applyMaxResults, appendTruncationNotice } from '../utils/pagination.js';
import { formatDeviceReservationList } from '../utils/response-formatter.js';
import { outputFormatParam, respond } from '../utils/output-format.js';

export function registerReservationTools(server: McpServer): void {
  server.tool(
    'list_reservations',
    'Lists current and upcoming device reservations with full details — user, device, start/end times, project, and notes. This is the correct tool whenever the user asks to "show", "list", or "get" reservations. Cloud Admins see all reservations; others see their own. Optionally filter by username, project, or specific device UIDs.',
    {
      username: z.string().optional().describe('Filter by username to see only their reservations.'),
      project: z.string().optional().describe('Filter by project name (Cloud Admin only).'),
      deviceUid: z
        .array(z.string())
        .optional()
        .describe('Filter by one or more device UIDs.'),
      sortBy: z
        .enum(['reservationStart', 'reservationEnd', 'username', 'project', 'deviceUid'])
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
    async ({ username, project, deviceUid, sortBy, sortOrder, maxResults, outputFormat }) => {
      try {
        let reservations = await getCurrentAndFutureReservations({
          username,
          project,
          deviceUid,
        });
        if (sortBy) {
          reservations = [...reservations].sort((a, b) => {
            const av = String(a[sortBy as keyof typeof a] ?? '').toLowerCase();
            const bv = String(b[sortBy as keyof typeof b] ?? '').toLowerCase();
            return sortOrder === 'desc' ? bv.localeCompare(av) : av.localeCompare(bv);
          });
        }
        const paged = applyMaxResults(reservations, maxResults);
        const structured = {
          reservations: paged.items.map(r => ({
            id: r.reservationId,
            deviceUid: r.deviceUid,
            username: r.username,
            project: r.project,
            start: r.reservationStart,
            end: r.reservationEnd,
            notes: r.reservationNotes ?? null,
          })),
        };
        const humanText = appendTruncationNotice(
          `Found ${paged.total} reservation(s):\n\n${formatDeviceReservationList(paged.items)}`,
          paged
        );
        return respond(outputFormat, structured, humanText);
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  server.tool(
    'create_reservation',
    'Creates a device reservation for one or more devices. You can reserve on behalf of another user (Cloud/Project Admin only). Uses ISO 8601 timestamps.',
    {
      deviceUid: z
        .array(z.string())
        .describe('List of device UIDs to reserve (from the deviceUid field in list_devices).'),
      reservationStart: z
        .string()
        .describe('Start time in ISO 8601 format, e.g. "2024-06-01T09:00:00Z".'),
      reservationEnd: z
        .string()
        .describe('End time in ISO 8601 format, e.g. "2024-06-01T17:00:00Z".'),
      username: z
        .string()
        .optional()
        .describe('Username to create the reservation for (Cloud/Project Admin only).'),
      project: z.string().optional().describe('Project name to associate with this reservation.'),
      notes: z.string().optional().describe('Optional notes about the reservation purpose.'),
    },
    async ({ deviceUid, reservationStart, reservationEnd, username, project, notes }) => {
      try {
        const results = await addReservation({
          deviceUid,
          reservationStart,
          reservationEnd,
          username,
          project,
          notes,
        });
        const lines = results.map(
          (r) => `  • Device ${r.deviceUid}: Reservation #${r.reservationId} — ${r.message}`
        );
        return {
          content: [
            {
              type: 'text',
              text: `✅ Reservation(s) created:\n${lines.join('\n')}`,
            },
          ],
        };
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  server.tool(
    'reserve_device_for_duration',
    'Reserves a single device starting now for a specified number of hours. Convenience wrapper that handles timestamp formatting automatically. Accepts numeric device ID, serial number, UDID, or device name — MCP resolves the identifier automatically.',
    {
      deviceId: z.string().describe('Numeric device ID, serial number, UDID, or device name (e.g. "39031FDJH00B3U", "iPhone 15 Pro", or "12345").'),
      durationHours: z
        .number()
        .min(0.25)
        .max(24)
        .describe('Duration in hours (e.g. 0.5 = 30 min, 1.0 = 1 hour, 2.5 = 2h 30m). Minimum 0.25 (15 min), maximum 24 hours.'),
      userId: z.string().optional().describe('User ID to reserve for (Cloud Admin only).'),
      projectId: z.string().optional().describe('Project ID to associate.'),
      notes: z.string().optional().describe('Optional notes.'),
    },
    async ({ deviceId, durationHours, userId, projectId, notes }) => {
      try {
        const resolved = await resolveDevice(deviceId);
        const now = new Date();
        const end = new Date(now.getTime() + durationHours * 60 * 60 * 1000);
        const start = formatDeviceTimestamp(now);
        const endTs = formatDeviceTimestamp(end);
        const currentTs = formatDeviceTimestamp(now);

        const { reservationId } = await reserveDevice(
          resolved.id,
          start,
          endTs,
          currentTs,
          userId,
          projectId,
          notes
        );

        return {
          content: [
            {
              type: 'text',
              text: [
                `✅ ${formatResolvedDevice(resolved, deviceId)} reserved.`,
                `Reservation ID: ${reservationId}`,
                `Start: ${now.toISOString()}`,
                `End: ${end.toISOString()}`,
                `Duration: ${durationHours} hour(s)`,
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
    'delete_reservation',
    'Cancels a device reservation. Cloud Admins can cancel any reservation. Project Admins can cancel reservations in their project. Regular users can cancel their own. Requires confirmDeletion: true.',
    {
      reservationId: z.number().describe('The numeric reservation ID. Use list_reservations to find it.'),
      confirmDeletion: z
        .boolean()
        .describe('Must be true to confirm this destructive, irreversible operation. No changes are made without this.'),
    },
    async ({ reservationId, confirmDeletion }) => {
      const guard = checkDestructiveGuard(
        confirmDeletion,
        `Cancel reservation #${reservationId}`
      );
      if (guard) return { content: [{ type: 'text', text: guard }] };
      try {
        await deleteReservation(reservationId);
        return {
          content: [
            { type: 'text', text: `✅ Reservation #${reservationId} has been cancelled.` },
          ],
        };
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  server.tool(
    'check_device_availability_window',
    'Shows the reservation schedule for a specific device over a time window, so you can find an available slot. Cloud Admin only — project-level keys (Project Admin and Project User) receive 403 on this endpoint. Accepts numeric device ID, serial number, UDID, or device name.',
    {
      deviceId: z.string().describe('Numeric device ID, serial number, UDID, or device name.'),
      startDate: z
        .string()
        .describe('Start of the window to check, in ISO 8601 format (e.g. "2024-06-01T00:00:00Z").'),
      endDate: z
        .string()
        .describe('End of the window to check, in ISO 8601 format (e.g. "2024-06-07T23:59:59Z").'),
      outputFormat: outputFormatParam,
    },
    async ({ deviceId, startDate, endDate, outputFormat }) => {
      try {
        const resolved = await resolveDevice(deviceId);
        const label = formatResolvedDevice(resolved, deviceId);
        const now = new Date();
        const start = formatDeviceTimestamp(new Date(startDate));
        const end = formatDeviceTimestamp(new Date(endDate));
        const current = formatDeviceTimestamp(now);

        const reservations = await getDeviceReservations(resolved.id, start, end, current);

        const structured = {
          deviceId: resolved.id,
          freeInWindow: reservations.length === 0,
          reservations: reservations.map(r => ({ id: r.id, title: r.title, start: r.start, end: r.end })),
        };

        if (reservations.length === 0) {
          return respond(
            outputFormat,
            structured,
            `✅ ${label} has no reservations in the requested window.\nFrom: ${startDate}\nTo: ${endDate}`
          );
        }

        const lines = reservations.map(
          (r) =>
            `  • Reservation #${r.id}: ${r.title}\n    Start: ${r.start} → End: ${r.end}`
        );

        return respond(
          outputFormat,
          structured,
          `${label} — ${reservations.length} reservation(s) in window:\n${lines.join('\n')}`
        );
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );
}
