/**
 * Per-device failure analysis over reporter runs (find_unhealthy_devices). Pure — fixture-tested.
 *
 * Idea from the dai-continuous-testing ddm_concept repo: a device that is "Available" can still be the reason tests fail
 * (wrong screen left over, stuck dialog, broken network). Status-based health checks cannot see that; the reporter can.
 * The platform classifies every failure (errorCategory — surveyed live 2026-10-16 over 3,000 failed runs):
 * device / environment / network / framework_error point at infrastructure; assertion / script / application at the
 * test or the app. The strongest single signal is a test that FAILS on this device but PASSES on another device in the
 * same window — the test is fine, the device is not.
 */

export interface RunRecord {
  name: string;
  status: string;
  start_time: string;
  serial: string | null;
  deviceName: string | null;
  deviceOs: string | null;
  cause: string | null;
  errorCategory: string | null;
}

export const INFRA_CATEGORIES = new Set(['device', 'environment', 'network', 'framework_error']);
export const FAILURE_STATUSES = new Set(['Failed', 'Error']);

export interface DeviceHealth {
  serial: string;
  deviceName: string | null;
  deviceOs: string | null;
  runs: number;
  failures: number;
  failRatio: number;
  /** Share of this device's failures the platform classified as device/environment/network/framework_error. */
  infraShare: number;
  categories: Record<string, number>;
  topCauses: Array<{ cause: string; count: number }>;
  /** Test names that failed here but passed on at least one OTHER device in the window. */
  failsOnlyHere: string[];
  lastFailure: string | null;
  flagged: boolean;
  reasons: string[];
}

export interface DeviceHealthOptions {
  minRuns: number;
  failRatioThreshold: number;
}

const ratio = (a: number, b: number) => (b === 0 ? 0 : Math.round((a / b) * 1000) / 1000);
const causeKey = (c: string | null) => (c ?? '').replace(/\s+/g, ' ').trim().slice(0, 120) || '(no cause recorded)';

export function analyzeDeviceHealth(records: RunRecord[], opts: DeviceHealthOptions): { devices: DeviceHealth[]; baselineFailRatio: number; runsWithoutDevice: number } {
  const withDevice = records.filter((r) => r.serial);
  const passedOn = new Map<string, Set<string>>(); // test name → serials it passed on
  for (const r of withDevice) {
    if (r.status === 'Passed') {
      const set = passedOn.get(r.name) ?? new Set<string>();
      set.add(r.serial!);
      passedOn.set(r.name, set);
    }
  }

  const groups = new Map<string, RunRecord[]>();
  for (const r of withDevice) {
    const list = groups.get(r.serial!) ?? [];
    list.push(r);
    groups.set(r.serial!, list);
  }

  const devices: DeviceHealth[] = [];
  for (const [serial, runs] of groups) {
    const failed = runs.filter((r) => FAILURE_STATUSES.has(r.status));
    const categories: Record<string, number> = {};
    const causes = new Map<string, number>();
    for (const f of failed) {
      const c = f.errorCategory ?? 'unclassified';
      categories[c] = (categories[c] ?? 0) + 1;
      causes.set(causeKey(f.cause), (causes.get(causeKey(f.cause)) ?? 0) + 1);
    }
    const infra = failed.filter((f) => INFRA_CATEGORIES.has(f.errorCategory ?? '')).length;
    // A test that never passed HERE but did pass on another device. A flaky test that passes and fails on every
    // device does not qualify — otherwise one flaky test would flag every device it ran on.
    const passedHere = new Set(runs.filter((r) => r.status === 'Passed').map((r) => r.name));
    const failsOnlyHere = [...new Set(failed.map((f) => f.name))]
      .filter((n) => !passedHere.has(n) && [...(passedOn.get(n) ?? [])].some((s) => s !== serial));
    const failRatio = ratio(failed.length, runs.length);
    const reasons: string[] = [];
    const enoughRuns = runs.length >= opts.minRuns;
    if (enoughRuns && failRatio >= opts.failRatioThreshold) reasons.push(`fail ratio ${Math.round(failRatio * 100)}% ≥ ${Math.round(opts.failRatioThreshold * 100)}%`);
    // A single failure is not evidence — the signal needs at least two failures on this device.
    if (enoughRuns && failed.length >= 2 && failsOnlyHere.length > 0) reasons.push(`${failsOnlyHere.length} test(s) fail here but pass on other devices`);
    const latest = failed.map((f) => f.start_time).sort().at(-1) ?? null;
    devices.push({
      serial,
      deviceName: runs.find((r) => r.deviceName)?.deviceName ?? null,
      deviceOs: runs.find((r) => r.deviceOs)?.deviceOs ?? null,
      runs: runs.length,
      failures: failed.length,
      failRatio,
      infraShare: ratio(infra, failed.length),
      categories,
      topCauses: [...causes].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([cause, count]) => ({ cause, count })),
      failsOnlyHere: failsOnlyHere.slice(0, 10),
      lastFailure: latest,
      flagged: reasons.length > 0,
      reasons,
    });
  }

  devices.sort((a, b) => Number(b.flagged) - Number(a.flagged) || b.failRatio - a.failRatio || b.failures - a.failures);
  const allFailed = withDevice.filter((r) => FAILURE_STATUSES.has(r.status)).length;
  return { devices, baselineFailRatio: ratio(allFailed, withDevice.length), runsWithoutDevice: records.length - withDevice.length };
}
