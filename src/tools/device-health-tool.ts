import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getAllDevices, addDeviceTag } from '../api/devices.js';
import { listTests } from '../api/reporting.js';
import { serverSortAvailable } from '../api/access-level.js';
import { analyzeDeviceHealth, type RunRecord } from '../utils/device-health.js';
import { outputFormatParam, respond } from '../utils/output-format.js';

const PAGE = 500;
const pct = (x: number) => `${Math.round(x * 100)}%`;

/** Reporter runs in the window, newest first. Early exit only on server-sorted data (see listTests / sortApplied). */
async function collectRuns(cutoff: number, maxRecords: number, projectName?: string): Promise<{ records: RunRecord[]; capped: boolean }> {
  const records: RunRecord[] = [];
  let scanned = 0;
  for (let page = 1; ; page++) {
    const wantSort = serverSortAvailable();
    const batch = await listTests({
      limit: PAGE, page, returnTotalCount: false,
      ...(wantSort && { sort: [{ property: 'start_time', descending: true }] }),
      keys: ['device.serialNumber', 'device.name', 'device.os', 'cause', 'errorCategory'],
    }, undefined, projectName);
    if (wantSort && batch.sortApplied === false && page > 1) {
      // Sort refused partway through a sorted scan: unsorted page N is not a continuation of sorted pages 1..N-1.
      // Restart from page 1 — the refusal is remembered, so the rescan is unsorted throughout.
      records.length = 0;
      scanned = 0;
      page = 0;
      continue;
    }
    const rows = (batch.data ?? []) as unknown as Array<Record<string, unknown>>;
    if (rows.length === 0) return { records, capped: false };
    let pastCutoff = false;
    for (const r of rows) {
      scanned++;
      if (Date.parse(String(r.start_time)) < cutoff) {
        if (batch.sortApplied) { pastCutoff = true; break; }
        continue;
      }
      records.push({
        name: String(r.name ?? ''),
        status: String(r.status ?? ''),
        start_time: String(r.start_time ?? ''),
        serial: (r['device.serialNumber'] as string) || null,
        deviceName: (r['device.name'] as string) || null,
        deviceOs: (r['device.os'] as string) || null,
        cause: (r.cause as string) ?? null,
        errorCategory: (r.errorCategory as string) ?? null,
      });
    }
    if (pastCutoff || rows.length < PAGE) return { records, capped: false };
    if (scanned >= maxRecords) return { records, capped: true };
  }
}

// Reporter-based device health (idea: dai-continuous-testing/ddm_concept). get_device_health_summary sees status only;
// this sees devices that are "Available" but fail tests that pass elsewhere. Tagging changes shared device state, so it
// is opt-in: tag alone previews, tag + confirmTagging applies.
export function registerUnhealthyDevicesTool(server: McpServer): void {
  server.tool(
    'find_unhealthy_devices',
    'Find devices that are making tests fail — "Available" devices whose recent runs fail far more than they should. ' +
    'Reads reporter runs from the last lookbackHours and, per device: fail ratio, how much of it the platform classified as ' +
    'device/environment/network/framework failures (infraShare), top causes, and tests that FAIL on this device but PASS on ' +
    'another one (the strongest sign the device, not the test, is at fault). Flags devices over failRatioThreshold (with at ' +
    'least minRuns runs) or with tests that fail only there. Use it when NoSuchElement or timeouts appear on some runs but ' +
    'not others. Optional: tag the flagged devices (e.g. "dirty") — pass tag to preview, then tag + confirmTagging: true to ' +
    'apply (a device change; like add_device_tag, available to Cloud Admin and Project Admin). Runs without a device (browser tests) are skipped.',
    {
      lookbackHours: z.number().int().min(1).max(336).optional().default(24).describe('How far back to look (default 24).'),
      minRuns: z.number().int().min(1).max(100).optional().default(3).describe('Minimum runs on a device before its fail ratio counts (default 3).'),
      failRatioThreshold: z.number().min(0.05).max(1).optional().default(0.5).describe('Flag devices whose fail ratio is at least this (default 0.5).'),
      projectName: z.string().optional().describe("Scope to one project's reports."),
      maxRecords: z.number().int().min(100).max(10000).optional().default(5000).describe('Most reporter runs to scan (default 5000).'),
      // The platform's own rule (verified live 2026-10-16): "only digits, letters and underscores", at most 64.
      tag: z.string().regex(/^\w{1,64}$/, 'Device tags may contain only letters, digits and underscores (max 64).').optional()
        .describe('Tag to put on the flagged devices, e.g. "dirty". Previews unless confirmTagging is true.'),
      confirmTagging: z.boolean().optional().describe('Must be true, together with tag, to actually tag the flagged devices.'),
      maxResults: z.number().int().min(1).max(200).optional().default(20).describe('Devices to list, flagged first (default 20).'),
      outputFormat: outputFormatParam,
    },
    async ({ lookbackHours, minRuns, failRatioThreshold, projectName, maxRecords, tag, confirmTagging, maxResults, outputFormat }) => {
      try {
        const hours = lookbackHours ?? 24;
        const { records, capped } = await collectRuns(Date.now() - hours * 3600_000, maxRecords ?? 5000, projectName);
        const { devices, baselineFailRatio, runsWithoutDevice } = analyzeDeviceHealth(records, {
          minRuns: minRuns ?? 3,
          failRatioThreshold: failRatioThreshold ?? 0.5,
        });
        const flagged = devices.filter((d) => d.flagged);

        // Reporter serials → device records (id for tagging, live status). The reporter's device.serialNumber is the
        // device's udid (Android) / iosUdid.
        const inventory = await getAllDevices().catch(() => []);
        const bySerial = new Map<string, (typeof inventory)[number]>();
        for (const d of inventory) {
          for (const k of [d.udid, d.iosUdid]) if (k) bySerial.set(String(k).toLowerCase(), d);
        }
        const shown = devices.slice(0, maxResults ?? 20).map((d) => {
          const dev = bySerial.get(d.serial.toLowerCase());
          return { ...d, deviceId: dev?.id ?? null, status: dev?.displayStatus ?? null, region: dev?.region ?? null };
        });

        let tagging: { tag: string; applied: boolean; note?: string; results?: Array<{ serial: string; deviceId: string | null; ok: boolean; error?: string }> } | undefined;
        if (tag) {
          const targets = flagged.map((d) => ({ serial: d.serial, deviceId: bySerial.get(d.serial.toLowerCase())?.id ?? null }));
          if (!confirmTagging) {
            tagging = {
              tag,
              applied: false,
              note: targets.length === 0
                ? 'No devices are flagged — nothing would be tagged.'
                : `Preview: ${targets.length} flagged device(s) would be tagged "${tag}" (${targets.map((t) => t.serial).join(', ')}). Re-call with confirmTagging: true to apply.`,
            };
          } else {
            const results: Array<{ serial: string; deviceId: string | null; ok: boolean; error?: string }> = [];
            for (const t of targets) {
              if (!t.deviceId) {
                results.push({ ...t, ok: false, error: 'device not visible to this credential' });
                continue;
              }
              try {
                await addDeviceTag(t.deviceId, tag);
                results.push({ ...t, ok: true });
              } catch (e) {
                results.push({ ...t, ok: false, error: (e as Error).message.slice(0, 200) });
              }
            }
            tagging = { tag, applied: true, results };
          }
        }

        const structured = {
          lookbackHours: hours,
          runsAnalysed: records.length,
          runsWithoutDevice,
          scanCapped: capped,
          baselineFailRatio,
          flaggedCount: flagged.length,
          devices: shown,
          ...(tagging ? { tagging } : {}),
        };

        const lines = [
          `Device health from ${records.length} reporter run(s) in the last ${hours} h (${runsWithoutDevice} without a device skipped). ` +
            `Baseline fail ratio: ${pct(baselineFailRatio)}. Flagged: ${flagged.length}.`,
          ...(capped ? [`⚠️ Scan stopped at maxRecords=${maxRecords ?? 5000} before the start of the window — raise maxRecords or shorten lookbackHours.`] : []),
          '',
        ];
        for (const d of shown) {
          const cats = Object.entries(d.categories).map(([k, v]) => `${k} ${v}`).join(', ');
          lines.push(`${d.flagged ? '🔴' : '🟢'} ${d.deviceName ?? d.serial} (${d.serial})${d.status ? ` — ${d.status}` : ''}`);
          lines.push(`   ${d.failures}/${d.runs} failed (${pct(d.failRatio)}), infrastructure share ${pct(d.infraShare)}${cats ? ` — ${cats}` : ''}`);
          if (d.reasons.length) lines.push(`   Why: ${d.reasons.join('; ')}`);
          if (d.failsOnlyHere.length) lines.push(`   Fails here, passes elsewhere: ${d.failsOnlyHere.slice(0, 5).join(', ')}`);
          for (const c of d.topCauses) lines.push(`   ${c.count}× ${c.cause}`);
          lines.push('');
        }
        if (tagging?.applied) {
          const ok = tagging.results!.filter((r) => r.ok).length;
          const bad = tagging.results!.filter((r) => !r.ok);
          lines.push(`Tagging "${tagging.tag}": ${ok} tagged, ${bad.length} failed${bad.length ? ` (${bad.map((r) => `${r.serial}: ${r.error}`).join('; ')})` : ''}.`);
        } else if (tagging) {
          lines.push(tagging.note!);
        }
        return respond(outputFormat, structured, lines.join('\n'));
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );
}
