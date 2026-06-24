import { getDevicesByQuery, getAllDevices } from '../api/devices.js';

export interface ResolvedDevice {
  id: string;
  deviceName: string;
  udid: string;
  displayStatus: string;
  agentName: string;
  region: string;
}

/**
 * Resolves a user-supplied device reference to the numeric backend ID.
 *
 * Accepts any of:
 *   - numeric ID string (e.g. "12345")      → used as-is, no lookup
 *   - serial number / UDID (e.g. "39031FDJH00B3U") → searched via @serialNumber query
 *   - device name (partial, case-insensitive) → searched across all devices
 *
 * Throws if no match or ambiguous match is found.
 */
export async function resolveDevice(ref: string): Promise<ResolvedDevice> {
  // Already a numeric backend ID — pass through without an extra API call.
  if (/^\d+$/.test(ref.trim())) {
    return { id: ref.trim(), deviceName: `device#${ref.trim()}`, udid: '', displayStatus: 'unknown', agentName: '', region: '' };
  }

  const escaped = ref.replace(/'/g, "\\'");

  // Try server-side serial number lookup first (fast single-query).
  try {
    const bySerial = await getDevicesByQuery(`@serialNumber='${escaped}'`);
    if (bySerial.length === 1) {
      const d = bySerial[0];
      return { id: d.id, deviceName: d.deviceName, udid: d.udid, displayStatus: d.displayStatus, agentName: d.agentName, region: d.region };
    }
    if (bySerial.length > 1) {
      throw new Error(
        `Multiple devices share serial "${ref}". Use the numeric device ID instead: ` +
        bySerial.map(d => `${d.deviceName} (ID: ${d.id})`).join(', ')
      );
    }
  } catch (e) {
    const msg = (e as Error).message;
    // Re-throw genuine errors (multi-match, auth failures, 5xx) — only swallow
    // query-syntax rejections (400) so we can fall through to the full-scan path.
    if (msg.startsWith('Multiple devices') || (msg.includes('[4') && !msg.includes('[400]')) || msg.includes('[5')) throw e;
  }

  // Fall back to full device list — match on UDID, iosUdid, or device name.
  const all = await getAllDevices();
  const norm = ref.toLowerCase().trim();

  const byUdid = all.filter(d =>
    (d.udid ?? '').toLowerCase() === norm ||
    (d.iosUdid ?? '').toLowerCase() === norm
  );
  if (byUdid.length === 1) {
    const d = byUdid[0];
    return { id: d.id, deviceName: d.deviceName, udid: d.udid, displayStatus: d.displayStatus, agentName: d.agentName, region: d.region };
  }
  if (byUdid.length > 1) {
    throw new Error(
      `Multiple devices match identifier "${ref}". Use the numeric device ID: ` +
      byUdid.map(d => `${d.deviceName} (ID: ${d.id})`).join(', ')
    );
  }

  const byName = all.filter(d => d.deviceName.toLowerCase().includes(norm));
  if (byName.length === 1) {
    const d = byName[0];
    return { id: d.id, deviceName: d.deviceName, udid: d.udid, displayStatus: d.displayStatus, agentName: d.agentName, region: d.region };
  }
  if (byName.length > 1) {
    const sample = byName.slice(0, 6).map(d => `${d.deviceName} (ID: ${d.id})`).join(', ');
    const extra = byName.length > 6 ? ` and ${byName.length - 6} more` : '';
    throw new Error(`"${ref}" matches ${byName.length} devices — be more specific or use the numeric ID: ${sample}${extra}`);
  }

  throw new Error(
    `No device found matching "${ref}". Provide the numeric device ID, serial number, UDID, or an unambiguous device name. ` +
    `Use list_devices to browse available devices.`
  );
}

/** Format the resolved device identity for echo in tool responses. */
export function formatResolvedDevice(resolved: ResolvedDevice, originalRef: string): string {
  if (/^\d+$/.test(originalRef.trim())) return `device ID ${resolved.id}`;
  return `${resolved.deviceName} (ID: ${resolved.id})`;
}
