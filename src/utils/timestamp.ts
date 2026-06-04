const pad = (n: number) => String(n).padStart(2, '0');

// The /api/v1/devices/ reservation endpoints require YYYY-MM-DD-hh-mm-ss in UTC.
export function formatDeviceTimestamp(date: Date): string {
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}-` +
    `${pad(date.getUTCHours())}-${pad(date.getUTCMinutes())}-${pad(date.getUTCSeconds())}`
  );
}

/**
 * Parse a date string in the API's non-standard "MM/DD/YYYY HH:mm:ss" format.
 * Several Digital.ai API endpoints use this format instead of ISO 8601:
 *   - DeviceReservation.reservationStart / reservationEnd
 *   - ProvisioningProfile.expirationDate
 *   - RepositoryFile.uploadTime / lastUpdate
 *
 * Falls back to `new Date(s)` for any other format.
 */
export function parseApiDate(s: string): Date {
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}:\d{2}:\d{2})$/);
  if (m) return new Date(`${m[3]}-${m[1]}-${m[2]}T${m[4]}Z`);
  return new Date(s);
}
