/**
 * The release workflow's rule for the `next` channel after a stable release (.github/scripts/next-channel.mjs):
 * `next` follows the release only when the release is newer than what `next` points to, so a beta from a working
 * branch that is still in flight keeps `next`.
 */
import { describe, it, expect } from 'vitest';
import { shouldMoveNext } from '../.github/scripts/next-channel.mjs';

describe('next channel after a stable release', () => {
  it('moves when the beta line has shipped (next = a prerelease of this or an older version)', () => {
    expect(shouldMoveNext('2.4.0', '2.4.0-beta.12')).toBe(true);
    expect(shouldMoveNext('2.4.1', '2.4.0-beta.12')).toBe(true);
    expect(shouldMoveNext('3.0.0', '2.9.0-beta.1')).toBe(true);
    expect(shouldMoveNext('2.4.1', '2.4.0')).toBe(true); // next was moved to the previous release
  });

  it('keeps a newer beta that is still in flight', () => {
    expect(shouldMoveNext('2.4.1', '2.5.0-beta.3')).toBe(false);
    expect(shouldMoveNext('2.4.1', '2.4.2-beta.1')).toBe(false);
    expect(shouldMoveNext('2.4.1', '3.0.0-rc.1')).toBe(false);
  });

  it('compares numbers, not text (2.10.0 is newer than 2.9.0)', () => {
    expect(shouldMoveNext('2.10.0', '2.9.0-beta.1')).toBe(true);
    expect(shouldMoveNext('2.9.1', '2.10.0-beta.1')).toBe(false);
  });

  it('does nothing when next is already this release; moves when next is unset', () => {
    expect(shouldMoveNext('2.4.0', '2.4.0')).toBe(false);
    expect(shouldMoveNext('2.4.0', '')).toBe(true);
    expect(shouldMoveNext('2.4.0')).toBe(true);
  });

  it('refuses a prerelease or a malformed version as the release', () => {
    expect(() => shouldMoveNext('2.5.0-beta.1', '2.4.0')).toThrow(/not a stable version/);
    expect(() => shouldMoveNext('2.4', '2.4.0')).toThrow(/not a stable version/);
    expect(() => shouldMoveNext('2.4.0', 'garbage')).toThrow(/not a version/);
  });
});
