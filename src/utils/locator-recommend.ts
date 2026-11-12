/**
 * Recommended locator per element for get_element_tree — the locator ladder (CLAUDE.md "Locators and waits",
 * SERVER_INSTRUCTIONS item 7) applied to the actual screen, so the agent copies a selector instead of choosing one:
 *   Android: resource-id → accessibility id (content-desc) → @text XPath
 *   iOS:     accessibility id (name = identifier, else label) → @label XPath
 * A rung is used only when its value is UNIQUE on the screen; a duplicate falls through to the next rung, and when every
 * rung is duplicated the best one is returned with `matches > 1` so the caller can say "narrow it".
 */

export interface LocatorElement {
  resourceId?: string | null;
  contentDesc?: string | null;
  text?: string | null;
  name?: string | null;
  label?: string | null;
}

export interface Recommendation {
  strategy: 'id' | 'accessibility id' | 'xpath';
  selector: string;
  /** How many elements on this screen the selector matches (1 = unique). */
  matches: number;
}

/** XPath string literal, or null when the value holds both quote kinds (no XPath 1.0 literal can express it). */
export function xpathLiteral(v: string): string | null {
  if (!v.includes("'")) return `'${v}'`;
  if (!v.includes('"')) return `"${v}"`;
  return null;
}

function counter(values: Array<string | null | undefined>): Map<string, number> {
  const m = new Map<string, number>();
  for (const v of values) if (v) m.set(v, (m.get(v) ?? 0) + 1);
  return m;
}

export function recommendLocators(elements: LocatorElement[], platform: 'android' | 'ios'): Array<Recommendation | null> {
  if (platform === 'ios') {
    const names = counter(elements.map((e) => e.name));
    const labels = counter(elements.map((e) => e.label));
    return elements.map((e) => {
      const rungs: Recommendation[] = [];
      if (e.name) rungs.push({ strategy: 'accessibility id', selector: e.name, matches: names.get(e.name) ?? 1 });
      const lit = e.label ? xpathLiteral(e.label) : null;
      if (e.label && lit) rungs.push({ strategy: 'xpath', selector: `//*[@label=${lit}]`, matches: labels.get(e.label) ?? 1 });
      return rungs.find((r) => r.matches === 1) ?? rungs[0] ?? null;
    });
  }
  const ids = counter(elements.map((e) => e.resourceId));
  const descs = counter(elements.map((e) => e.contentDesc));
  const texts = counter(elements.map((e) => e.text));
  return elements.map((e) => {
    const rungs: Recommendation[] = [];
    if (e.resourceId) rungs.push({ strategy: 'id', selector: e.resourceId, matches: ids.get(e.resourceId) ?? 1 });
    if (e.contentDesc) rungs.push({ strategy: 'accessibility id', selector: e.contentDesc, matches: descs.get(e.contentDesc) ?? 1 });
    const lit = e.text ? xpathLiteral(e.text) : null;
    if (e.text && lit) rungs.push({ strategy: 'xpath', selector: `//*[@text=${lit}]`, matches: texts.get(e.text) ?? 1 });
    return rungs.find((r) => r.matches === 1) ?? rungs[0] ?? null;
  });
}

/** One line per recommendation, for the human-readable element table. */
export function formatRecommendation(r: Recommendation | null): string {
  if (!r) return '(no stable locator — use a parent with one, or ask for an accessibility id in the app)';
  return `${r.strategy}: ${r.selector}${r.matches > 1 ? `   ⚠ matches ${r.matches} elements here — narrow it` : ''}`;
}
