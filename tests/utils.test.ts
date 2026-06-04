import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { applyMaxResults, appendTruncationNotice, DEFAULT_MAX_RESULTS, ABSOLUTE_MAX_RESULTS } from '../src/utils/pagination.js';
import { checkDestructiveGuard } from '../src/utils/destructive-guard.js';
import { validateOutputPath } from '../src/utils/path-guard.js';
import { formatDeviceTimestamp } from '../src/utils/timestamp.js';
import { getStatusEmoji, formatProvisioningProfileList } from '../src/utils/response-formatter.js';
import type { ProvisioningProfile } from '../src/types/digital-ai.js';

// ─── applyMaxResults ─────────────────────────────────────────────────────────

describe('applyMaxResults', () => {
  it('returns all items when count is within limit', () => {
    const items = [1, 2, 3];
    const result = applyMaxResults(items, 10);
    assert.equal(result.returned, 3);
    assert.equal(result.total, 3);
    assert.equal(result.truncated, false);
    assert.equal(result.truncationNotice, null);
    assert.deepEqual(result.items, [1, 2, 3]);
  });

  it('truncates and sets notice when items exceed maxResults', () => {
    const items = [1, 2, 3, 4, 5];
    const result = applyMaxResults(items, 3);
    assert.equal(result.returned, 3);
    assert.equal(result.total, 5);
    assert.equal(result.truncated, true);
    assert.ok(result.truncationNotice?.includes('3 of 5'));
    assert.deepEqual(result.items, [1, 2, 3]);
  });

  it('clamps maxResults to ABSOLUTE_MAX_RESULTS', () => {
    const items = Array.from({ length: ABSOLUTE_MAX_RESULTS + 10 }, (_, i) => i);
    const result = applyMaxResults(items, ABSOLUTE_MAX_RESULTS + 999);
    assert.equal(result.returned, ABSOLUTE_MAX_RESULTS);
    assert.equal(result.truncated, true);
  });

  it('clamps maxResults to minimum of 1', () => {
    const items = [1, 2, 3];
    const result = applyMaxResults(items, 0);
    assert.equal(result.returned, 1);
  });

  it('uses DEFAULT_MAX_RESULTS when maxResults is omitted', () => {
    const items = Array.from({ length: DEFAULT_MAX_RESULTS + 5 }, (_, i) => i);
    const result = applyMaxResults(items);
    assert.equal(result.returned, DEFAULT_MAX_RESULTS);
  });

  it('handles empty array', () => {
    const result = applyMaxResults([], 10);
    assert.equal(result.total, 0);
    assert.equal(result.truncated, false);
    assert.deepEqual(result.items, []);
  });
});

describe('appendTruncationNotice', () => {
  it('appends notice when truncated', () => {
    const items = [1, 2, 3, 4, 5];
    const result = applyMaxResults(items, 2);
    const text = appendTruncationNotice('hello', result);
    assert.ok(text.startsWith('hello\n\n'));
    assert.ok(text.includes('2 of 5'));
  });

  it('returns text unchanged when not truncated', () => {
    const result = applyMaxResults([1, 2], 10);
    assert.equal(appendTruncationNotice('hello', result), 'hello');
  });
});

// ─── checkDestructiveGuard ───────────────────────────────────────────────────

describe('checkDestructiveGuard', () => {
  it('returns null when confirmDeletion is true', () => {
    assert.equal(checkDestructiveGuard(true, 'Delete foo'), null);
  });

  it('returns warning message when confirmDeletion is false', () => {
    const msg = checkDestructiveGuard(false, 'Delete foo');
    assert.ok(msg !== null);
    assert.ok(msg.includes('Delete foo'));
    assert.ok(msg.includes('confirmDeletion: true'));
  });

  it('returns warning message when confirmDeletion is undefined', () => {
    const msg = checkDestructiveGuard(undefined, 'Delete bar');
    assert.ok(msg !== null);
    assert.ok(msg.includes('Delete bar'));
  });
});

// ─── validateOutputPath ──────────────────────────────────────────────────────

describe('validateOutputPath', () => {
  it('accepts valid absolute paths', () => {
    assert.equal(validateOutputPath('/tmp/output.zip'), null);
    assert.equal(validateOutputPath('C:\\Users\\test\\output.zip'), null);
  });

  it('rejects relative paths', () => {
    const err = validateOutputPath('relative/path.zip');
    assert.ok(err !== null);
    assert.ok(err.includes('absolute'));
  });

  it('rejects paths with traversal sequences', () => {
    const err = validateOutputPath('/tmp/../etc/passwd');
    assert.ok(err !== null);
    assert.ok(err.includes('traversal'));
  });
});

// ─── formatDeviceTimestamp ───────────────────────────────────────────────────

describe('formatDeviceTimestamp', () => {
  it('formats a UTC date correctly', () => {
    // 2024-03-15 13:05:09 UTC
    const date = new Date('2024-03-15T13:05:09Z');
    assert.equal(formatDeviceTimestamp(date), '2024-03-15-13-05-09');
  });

  it('uses UTC hours — not local time', () => {
    // A date at exactly midnight UTC
    const date = new Date('2024-06-01T00:00:00Z');
    const result = formatDeviceTimestamp(date);
    assert.ok(result.startsWith('2024-06-01-00-'), `Expected UTC midnight, got: ${result}`);
  });

  it('pads single-digit month, day, hour, minute, second', () => {
    const date = new Date('2024-01-02T03:04:05Z');
    assert.equal(formatDeviceTimestamp(date), '2024-01-02-03-04-05');
  });
});

// ─── getStatusEmoji ──────────────────────────────────────────────────────────

describe('getStatusEmoji', () => {
  it('returns green for available', () => {
    assert.equal(getStatusEmoji('available'), '🟢');
    assert.equal(getStatusEmoji('AVAILABLE'), '🟢');
  });

  it('returns yellow for reserved', () => {
    assert.equal(getStatusEmoji('reserved'), '🟡');
  });

  it('returns red for offline', () => {
    assert.equal(getStatusEmoji('offline'), '🔴');
  });

  it('returns fallback for unknown status', () => {
    assert.equal(getStatusEmoji('unknown-status'), '⚪');
  });
});

// ─── formatProvisioningProfileList ──────────────────────────────────────────

describe('formatProvisioningProfileList', () => {
  it('returns empty message for empty array', () => {
    assert.equal(formatProvisioningProfileList([]), 'No provisioning profiles found.');
  });

  it('marks expired profiles with red indicator', () => {
    const expired: ProvisioningProfile = {
      profileName: 'OldProfile',
      profileUUID: 'abc-123',
      applicationPrefix: 'TEAM',
      expirationDate: '2020-01-01T00:00:00Z',
    };
    const result = formatProvisioningProfileList([expired]);
    assert.ok(result.includes('🔴'));
    assert.ok(result.includes('EXPIRED'));
  });

  it('marks profiles expiring within 30 days with yellow indicator', () => {
    const soon = new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString();
    const expiringSoon: ProvisioningProfile = {
      profileName: 'SoonProfile',
      profileUUID: 'def-456',
      applicationPrefix: 'TEAM',
      expirationDate: soon,
    };
    const result = formatProvisioningProfileList([expiringSoon]);
    assert.ok(result.includes('🟡'));
    assert.ok(result.includes('EXPIRING SOON'));
  });

  it('marks valid profiles with green indicator', () => {
    const future = new Date(Date.now() + 180 * 24 * 60 * 60 * 1000).toISOString();
    const valid: ProvisioningProfile = {
      profileName: 'GoodProfile',
      profileUUID: 'ghi-789',
      applicationPrefix: 'TEAM',
      expirationDate: future,
    };
    const result = formatProvisioningProfileList([valid]);
    assert.ok(result.includes('🟢'));
    assert.ok(result.includes('VALID'));
  });
});
