/**
 * Browser names exactly as the Selenium grid expects them. Matching is case-sensitive: "microsoftedge" → 400 "No
 * browser found matching the desired capabilities" (verified live 2026-10-09). Names follow list_available_browsers
 * (chrome, firefox, MicrosoftEdge, safari, opera — Opera 136 verified live). Unknown names pass through unchanged.
 */
const KNOWN: Record<string, string> = {
  chrome: 'chrome',
  firefox: 'firefox',
  safari: 'safari',
  opera: 'opera',
  microsoftedge: 'MicrosoftEdge',
  edge: 'MicrosoftEdge',
};

export function canonicalBrowserName(name: string | undefined): string | undefined {
  if (!name) return undefined;
  return KNOWN[name.trim().toLowerCase()] ?? name.trim();
}
