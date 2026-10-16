import { apiGet } from './client.js';
import { escapeDeviceQueryValue } from '../utils/device-query.js';

// Emulator/simulator TEMPLATES (the portal's Virtual Devices page). Idle templates are not devices — list_devices,
// list_agents and get_agent_devices never show them; they become a device only while a session runs.
// GET /api/v2/virtual-devices/load is the portal's DevExtreme data source (live 2026-10-16): 200 for Cloud Admin,
// Project Admin and Project User alike (all saw the same catalog); Bearer auth required (X-API-KEY alone → 401).
// The record schema differs between platform versions: one tenant returns `imageName` (the exact template name),
// another only `name`, a debug string like "ModelKey[osVersion=15, model=Samsung S25]", and refuses a sort on
// `imageName` (500). So no server-side sort or field selector is sent, and both shapes are normalised here.
// No region or agent fields exist on either; /api/v2/virtual-devices/{id} is 404.

const PAGE_SIZE = 500;
const MAX_PAGES = 20;

export interface RawVirtualDevice {
  id: number;
  name?: string;
  imageName?: string;
  os?: string;
  deviceModel?: string;
  osVersion?: string;
  manufacturer?: string;
  category?: string;
  screenWidth?: number;
  screenHeight?: number;
  status?: string;
}

export interface VirtualDeviceTemplate {
  id: number;
  /** Exact template name when the platform provides one (imageName); null when it only has a ModelKey[...] string. */
  templateName: string | null;
  os: 'Android' | 'iOS' | string;
  model: string | null;
  osVersion: string | null;
  manufacturer: string | null;
  category: string | null;
  screen: string | null;
  status: string | null;
  /** Session device query that targets this template (see suggestedDeviceQuery). */
  deviceQuery: string;
}

const MODEL_KEY_RE = /^ModelKey\[/;

/**
 * contains(@name, …) when the exact template name is known (the form a client used successfully on a tenant that
 * returns imageName; name matching is case-sensitive); otherwise @model — verified live 2026-10-16:
 * "@os='ios' and @emulator='true' and @model='iPhone 17e'" allocated that simulator.
 */
export function suggestedDeviceQuery(t: Pick<VirtualDeviceTemplate, 'templateName' | 'os' | 'model'>): string {
  const os = t.os === 'iOS' ? 'ios' : 'android';
  const base = `@os='${os}' and @emulator='true'`;
  if (t.templateName) return `${base} and contains(@name,'${escapeDeviceQueryValue(t.templateName)}')`;
  if (t.model) return `${base} and @model='${escapeDeviceQueryValue(t.model)}'`;
  return base;
}

export function normalizeVirtualDevice(raw: RawVirtualDevice): VirtualDeviceTemplate {
  const templateName = raw.imageName || (raw.name && !MODEL_KEY_RE.test(raw.name) ? raw.name : null) || null;
  const osRaw = (raw.os ?? '').toUpperCase();
  const os = osRaw === 'IOS' ? 'iOS' : osRaw === 'ANDROID' ? 'Android' : (raw.os ?? 'unknown');
  const t = {
    id: raw.id,
    templateName,
    os,
    model: raw.deviceModel ?? null,
    osVersion: raw.osVersion ?? null,
    manufacturer: raw.manufacturer ?? null,
    category: raw.category ?? null,
    screen: raw.screenWidth && raw.screenHeight ? `${raw.screenWidth}x${raw.screenHeight}` : null,
    status: raw.status ?? null,
  };
  return { ...t, deviceQuery: suggestedDeviceQuery(t) };
}

/** Every template in the catalog, paged (the catalog is small — ~150 on a busy tenant). */
export async function listVirtualDeviceTemplates(): Promise<VirtualDeviceTemplate[]> {
  try {
    // Deduped by id: a platform version that ignores `skip` would otherwise return the same page MAX_PAGES times.
    const byId = new Map<number, RawVirtualDevice>();
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await apiGet<{ data?: RawVirtualDevice[]; totalCount?: number }>('/api/v2/virtual-devices/load', {
        jsonQuery: JSON.stringify({ requireTotalCount: true, skip: page * PAGE_SIZE, take: PAGE_SIZE }),
        userData: '{}',
      });
      const rows = Array.isArray(res?.data) ? res.data : [];
      const before = byId.size;
      for (const r of rows) byId.set(r.id, r);
      const newRows = byId.size - before;
      if (newRows === 0 || rows.length < PAGE_SIZE || (res.totalCount !== undefined && byId.size >= res.totalCount)) break;
    }
    return [...byId.values()].map(normalizeVirtualDevice);
  } catch (e) {
    throw new Error(`listVirtualDeviceTemplates failed: ${(e as Error).message}`);
  }
}
