import { describe, it, expect } from 'vitest';
import { extractApiErrorMessage } from '../src/utils/api-error.js';
import { remoteDebugAuthWarning } from '../src/tools/debug-tools.js';

describe('extractApiErrorMessage', () => {
  it('prefers a top-level message', () => {
    expect(extractApiErrorMessage({ message: 'You have no permission to delete tests', data: 'x' }))
      .toBe('You have no permission to delete tests');
  });

  it('uses a string data field (v1 envelope)', () => {
    expect(extractApiErrorMessage({ status: 'ERROR', code: 403, data: 'Forbidden for this role' }))
      .toBe('Forbidden for this role');
  });

  it('never renders [object Object] for an object data field', () => {
    const msg = extractApiErrorMessage({ status: 'ERROR', data: { message: 'Requires Cloud Admin' } });
    expect(msg).toBe('Requires Cloud Admin');
    expect(extractApiErrorMessage({ data: { code: 17, reason: 'nope' } })).toBe('{"code":17,"reason":"nope"}');
    expect(extractApiErrorMessage({ data: { a: 1 } }, 'fallback')).not.toContain('[object Object]');
  });

  it('skips empty strings instead of returning a blank message', () => {
    expect(extractApiErrorMessage({ message: '', error: 'Forbidden' })).toBe('Forbidden');
  });

  it('accepts a bare string body and ignores HTML pages', () => {
    expect(extractApiErrorMessage('Unauthorized', 'Request failed with status code 401')).toBe('Unauthorized');
    expect(extractApiErrorMessage('<!DOCTYPE html><html>…</html>', 'Request failed with status code 404'))
      .toBe('Request failed with status code 404');
  });

  it('falls back to the axios message, then a fixed text', () => {
    expect(extractApiErrorMessage(undefined, 'timeout of 30000ms exceeded')).toBe('timeout of 30000ms exceeded');
    expect(extractApiErrorMessage({}, undefined)).toBe('Unknown error');
  });

  it('truncates very long details', () => {
    const msg = extractApiErrorMessage({ message: 'x'.repeat(1000) });
    expect(msg.length).toBeLessThanOrEqual(301);
    expect(msg.endsWith('…')).toBe(true);
  });
});

describe('remoteDebugAuthWarning', () => {
  it('stays silent for a Cloud Admin with a real serial', () => {
    expect(remoteDebugAuthWarning({ level: 'cloud-admin', source: 'role' }, 'R5CT1234ABC'))
      .toEqual({ authWarning: null, warningLines: [] });
  });

  it('does not warn on an unknown level alone (fail open)', () => {
    expect(remoteDebugAuthWarning({ level: 'unknown', source: 'unresolved' }, 'R5CT1234ABC').authWarning).toBeNull();
  });

  it('names the detected role, not a key type, when below Cloud Admin', () => {
    const { authWarning, warningLines } = remoteDebugAuthWarning({ level: 'project-admin', role: 'ProjectAdmin', source: 'role' }, 'R5CT1234ABC');
    expect(authWarning).toContain('Not running as Cloud Admin (detected: Project Admin');
    expect(authWarning).not.toMatch(/API key/i);
    expect(authWarning).toContain('switch_environment("cloud admin")');
    expect(warningLines[0]).toContain('AUTH WARNING');
  });

  it('warns on an internal-looking serial even for a Cloud Admin', () => {
    const { authWarning } = remoteDebugAuthWarning({ level: 'cloud-admin', source: 'role' }, '21537817');
    expect(authWarning).toContain('"21537817" looks like an internal device ID');
    expect(authWarning).not.toContain('Not running as Cloud Admin');
  });
});
