/**
 * Which tools each module registered — filled once at startup from the captured registrations (src/index.ts), so
 * get_server_info reports real per-area counts instead of hand-maintained numbers that drift (they had: "Reporting —
 * 17 tools" while 23 were registered, and whole areas such as test runs were missing).
 */
const catalog = new Map<string, string[]>();

export function setToolCatalog(tools: ReadonlyArray<{ module: string; name: string }>): void {
  catalog.clear();
  for (const { module, name } of tools) catalog.set(module, [...(catalog.get(module) ?? []), name]);
}

export function getToolCatalog(): ReadonlyMap<string, readonly string[]> {
  return catalog;
}
