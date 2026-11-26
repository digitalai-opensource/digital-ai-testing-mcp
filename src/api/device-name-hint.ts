import { getAllDevices } from './devices.js';

/**
 * After a session start found no device: when the query pins `@name='…'` and no device has exactly that name, name the
 * devices whose names contain it. Seen in UAT 2026-11-25: `@name='Galaxy S25 Plus US-0311'` waited out the whole
 * timeout ("No available device matching the query"); the device is "Samsung Galaxy S25 Plus US-0311". Read only on the
 * failure path, never fatal: an empty string when there is nothing to add or the device list cannot be read.
 */
export async function deviceNameHint(query: string | undefined): Promise<string> {
  const wanted = query ? /@name\s*=\s*'([^']+)'/i.exec(query)?.[1] : undefined;
  if (!wanted) return '';
  return getAllDevices().then((devices) => suggestDeviceNames(wanted, devices.map((d) => d.deviceName))).catch(() => '');
}

/** Pure part of deviceNameHint: the sentence for a wanted name and the names that exist. */
export function suggestDeviceNames(wanted: string, names: Array<string | null | undefined>): string {
  const all = names.filter((n): n is string => !!n);
  if (all.includes(wanted)) return '';
  const lower = wanted.toLowerCase();
  const close = [...new Set(all.filter((n) => n.toLowerCase().includes(lower) || (n.toLowerCase() === lower)))].slice(0, 3);
  if (!close.length) return ` No device is named '${wanted}' (@name must match the whole name) — list_devices shows the names.`;
  return ` No device is named exactly '${wanted}' (@name must match the whole name); did you mean ${close.map((n) => `'${n}'`).join(' or ')}? ` +
    `Or match part of the name: contains(@name,'${wanted}').`;
}
