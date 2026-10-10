/**
 * get_server_info's "Capability domains" counts come from the registrations, not hand-maintained numbers (they had
 * drifted: "Reporting — 17 tools" with 23 registered, test runs missing entirely).
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { setToolCatalog } from '../src/utils/tool-catalog.js';
import { capabilityLines } from '../src/tools/meta-tools.js';

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
