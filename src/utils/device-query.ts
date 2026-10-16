/** Helpers for the platform's @-syntax device query, shared by every tool that builds or inspects one. */

/** Matches a query that targets an emulator/simulator template — they boot inside the session request. */
export function isEmulatorQuery(query: string | undefined): boolean {
  return /@emulator\s*=\s*'true'/i.test(query ?? '');
}

/** Values are single-quoted in the query; an apostrophe in a device/template name must be escaped. */
export function escapeDeviceQueryValue(value: string): string {
  return value.replace(/'/g, "\\'");
}
