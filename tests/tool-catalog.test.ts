/**
 * get_server_info's "Capability domains" counts come from the registrations, not hand-maintained numbers (they had
 * drifted: "Reporting — 17 tools" with 23 registered, test runs missing entirely).
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setToolCatalog } from '../src/utils/tool-catalog.js';
import { capabilityLines, REGISTERED_TOOLS } from '../src/tools/meta-tools.js';

describe('get_server_info capability domains', () => {
  it('counts tools per module from the catalog and still lists an undescribed module', () => {
    setToolCatalog([
      { module: 'reporting', name: 'list_test_reports' },
      { module: 'reporting', name: 'get_test_report' },
      { module: 'backup', name: 'create_backup' },
      { module: 'brand-new', name: 'shiny_tool' },
    ]);
    const lines = capabilityLines();
    assert.equal(lines.length, 3);
    assert.match(lines.find((l) => l.includes('Reporting'))!, /\(2 tools\)$/);
    assert.match(lines.find((l) => l.includes('Backup'))!, /\(1 tool\)$/);
    assert.match(lines.find((l) => l.includes('brand-new'))!, /shiny_tool \(1 tool\)$/);
    assert.ok(!lines.some((l) => l.includes('Test Runs')), 'areas with no registered tools are left out');
  });
});

describe('tool names in agent-facing guidance', () => {
  it('session-failure diagnostics only name tools that exist', () => {
    const src = readFileSync(new URL('../src/api/webdriver.ts', import.meta.url), 'utf8');
    const named = [...src.matchAll(/\b(check_[a-z_]+|find_available_device|get_device_health_summary|get_application_info)\b/g)].map((m) => m[1]);
    const registered = new Set<string>(REGISTERED_TOOLS);
    assert.deepEqual([...new Set(named)].filter((n) => !registered.has(n)), []);
  });
});
