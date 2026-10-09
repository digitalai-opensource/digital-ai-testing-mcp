import { apiGet, apiPost } from './client.js';
import type { Transaction } from '../types/digital-ai.js';

// Transactions = performance-instrumented segments of a mobile test session.
// Records CPU, memory, battery, and network metrics between developer-marked
// start/end points in the app or test script.
//
// Auth: works for all roles. Cloud Admin sees all projects; project-level keys
// (Project Admin and Project User) see only their own project's transactions.
//
// Filtering: ALL filter/sort/pagination body params are CSRF-blocked (401) or
// silently ignored. The list endpoint always returns all records; filter client-side.

interface TransactionListResponse {
  count: null;     // Always null — use data.length for the count
  data: Transaction[];
}

/**
 * deviceOs arrives in more than one casing — recent records say "IOS"/"ANDROID", older ones "iOS"/"Android" (UAT
 * 2026-10-09: id 1950 is "IOS", 2024 records are "iOS"). Every filter (deviceOs: "iOS"), group-by and the comparison
 * confound check compare exact strings, so normalise once here.
 */
export function normaliseDeviceOs(os: string | null | undefined): string | null | undefined {
  if (typeof os !== 'string') return os;
  const lower = os.trim().toLowerCase();
  if (lower === 'ios') return 'iOS';
  if (lower === 'android') return 'Android';
  return os;
}

// The transaction API uses -1 as a sentinel for "metric not captured" on some fields.
// Normalise to null at the API boundary so consumers see a consistent null contract.
function normalise(t: Transaction): Transaction {
  return {
    ...t,
    speedIndex: t.speedIndex === -1 ? null : t.speedIndex,
    deviceOs: normaliseDeviceOs(t.deviceOs) as Transaction['deviceOs'],
  };
}

export async function listTransactions(): Promise<Transaction[]> {
  try {
    // Empty body required — any filter params trigger CSRF blocks or are ignored.
    const res = await apiPost<TransactionListResponse>('/reporter/api/transactions/list', {});
    return (res.data ?? []).map(normalise);
  } catch (e) {
    throw new Error(`listTransactions failed: ${(e as Error).message}`);
  }
}

export async function getTransaction(transactionId: number): Promise<Transaction> {
  try {
    return normalise(await apiGet<Transaction>(`/reporter/api/transactions/${transactionId}`));
  } catch (e) {
    throw new Error(`getTransaction failed: ${(e as Error).message}`);
  }
}
