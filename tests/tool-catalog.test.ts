/**
 * get_server_info's "Capability domains" counts come from the registrations, not hand-maintained numbers (they had
 * drifted: "Reporting — 17 tools" with 23 registered, test runs missing entirely).
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setToolCatalog } from '../src/utils/tool-catalog.js';
import { capabilityLines, registeredToolCount, REGISTERED_TOOLS } from '../src/tools/meta-tools.js';

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

  // "Registered tools" printed the static TOOL_COUNT (205) while debug mode had registered 206 (UAT 2026-10-16).
  it('the registered-tool total counts what was registered, debug-only tools included', () => {
    setToolCatalog([
      { module: 'reporting', name: 'list_test_reports' },
      { module: 'remediation', name: 'record_remediation_note' },
    ]);
    assert.equal(registeredToolCount(), 2);
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

describe('doc references in server text', () => {
  // get_server_info pointed at docs/analytics-gap-analysis.md — a name that never existed, and the real gap analyses
  // are local-only (git-ignored), so users of the package could not open it either way (found 2026-10-17).
  it('every docs/<file>.md the server mentions is a published doc', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const root = join(__dirname, '..');
    const published = new Set(readFileSync(join(root, '.gitignore'), 'utf8').split(/\r?\n/).map((l) => l.match(/^!docs\/(.+\.md)$/)?.[1]).filter(Boolean));
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith('.ts') ? [join(d, e.name)] : []));
    const bad: string[] = [];
    for (const file of walk(join(root, 'src'))) {
      for (const m of readFileSync(file, 'utf8').matchAll(/docs\/([\w-]+\.md)/g)) {
        if (!published.has(m[1])) bad.push(`${file.slice(root.length + 1)}: docs/${m[1]}`);
      }
    }
    assert.ok(published.size >= 4, `published docs not found in .gitignore: ${[...published].join(', ')}`);
    assert.deepEqual(bad, []);
  });
});
