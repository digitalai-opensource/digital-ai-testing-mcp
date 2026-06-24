import dotenv from 'dotenv';
dotenv.config();

export * from '../../src/api/users.js';
export * from '../../src/api/devices.js';
export * from '../../src/api/device-groups.js';
export * from '../../src/api/reservations.js';
export * from '../../src/api/applications.js';
export * from '../../src/api/repository.js';
export * from '../../src/api/browsers.js';
export * from '../../src/api/projects.js';
export * from '../../src/api/provisioning-profiles.js';
export * from '../../src/api/backup.js';
export * from '../../src/api/reporting.js';
export * from '../../src/api/test-views.js';
export * from '../../src/api/transactions.js';
export * from '../../src/api/agents.js';
export * from '../../src/api/regions.js';
export * from '../../src/api/nv-servers.js';
export * from '../../src/api/sessions.js';
export * from '../../src/api/reporter-projects.js';
export * from '../../src/api/license.js';

export const TEST_TIMEOUT_MS = 30000;
export const UPLOAD_TIMEOUT_MS = 120000;

export function assertDefined<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) {
    throw new Error(`Expected ${label} to be defined but got ${String(value)}`);
  }
  return value;
}

export function assertNonEmpty<T>(arr: T[], label: string): void {
  if (!Array.isArray(arr) || arr.length === 0) {
    throw new Error(`Expected ${label} to be a non-empty array`);
  }
}

export function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(
      `${label}: expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`
    );
  }
}

export function assertMatches(value: string, pattern: RegExp, label: string): void {
  if (!pattern.test(value)) {
    throw new Error(`${label}: expected "${value}" to match ${String(pattern)}`);
  }
}
