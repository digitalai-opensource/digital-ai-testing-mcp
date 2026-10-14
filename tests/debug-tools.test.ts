import { describe, it, expect } from 'vitest';
import { remoteDebugAuthWarning } from '../src/tools/debug-tools.js';

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
    expect(authWarning).toContain('Not running as Cloud Admin (detected: Project Admin) — the device serial');
    expect(authWarning).not.toContain('v2 infrastructure');
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
