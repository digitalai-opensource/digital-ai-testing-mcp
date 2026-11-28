/**
 * App exploration, stage 1 building blocks (pure; no device, no network). See reports/analysis-app-exploration-2026-11-26.md.
 *
 * Exploration maps the CUSTOMER'S app (the user names the app, its version and its OS: never a sample app outside a demo)
 * into a manifest of screens, so the placeholder steps of a boilerplate can become steps validated on that app. Nothing
 * here knows any particular app: rules that fit one app only must fail the tests, which use page sources of several.
 *
 * - parseScreen: a page source (UiAutomator2 / XCUITest XML) → the elements a crawler can reason about.
 * - screenSignature: when two visits show the same screen. Activity / navigation title + the element STRUCTURE with
 *   text removed and repeated rows collapsed, so a feed, a balance or a clock does not create new screens and two
 *   product pages built from one template are one screen.
 * - classifyTap: the safety model. An ALLOW-LIST of navigation taps (tabs, drawer items, list rows, back, known
 *   navigation words). Anything else (buttons with verbs, icon-only buttons, switches, unknown) is recorded, not tapped.
 *   A deny-list of risky words is a second net only: icon-only buttons and unfamiliar labels defeat it.
 * - candidateTaps: the navigation taps of a screen, list rows of one template collapsed to one.
 */
import { createHash } from 'node:crypto';

export type ExplorePlatform = 'android' | 'ios';

export interface ScreenElement {
  /** Class (Android) or XCUIElementType (iOS). */
  type: string;
  /** resource-id (Android) or accessibility identifier = name (iOS). */
  id: string | null;
  /** Visible text or label. */
  text: string | null;
  /** content-desc (Android) or label (iOS). */
  description: string | null;
  /** Text of its descendants (Compose / SwiftUI put a button's words in child elements). */
  innerText: string | null;
  /** The child texts themselves, first one first (the locator uses the first exactly). */
  innerParts: string[];
  clickable: boolean;
  enabled: boolean;
  checkable: boolean;
  /** A password field (Android password="true", iOS XCUIElementTypeSecureTextField). */
  password: boolean;
  /** [x1, y1, x2, y2] in the session's own coordinates. */
  bounds: [number, number, number, number] | null;
  /** Depth in the tree and the path of types from the root, e.g. "FrameLayout/LinearLayout/RecyclerView". */
  depth: number;
  path: string;
  /** Inside a list or table (RecyclerView, ListView, XCUIElementTypeTable / CollectionView): a row of a template. */
  inList: boolean;
  /** Inside a tab bar / bottom navigation / navigation drawer / navigation bar. */
  inNavigation: 'tabs' | 'drawer' | 'navbar' | null;
}

const attr = (attrs: string, name: string): string | null => {
  const m = attrs.match(new RegExp(`\\s${name.replace(/[-]/g, '\\-')}="([^"]*)"`));
  return m ? m[1].replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&') : null;
};

const LIST_TYPES = /RecyclerView|ListView|GridView|XCUIElementTypeTable$|XCUIElementTypeCollectionView$/;
const TAB_TYPES = /BottomNavigationView|TabLayout|TabWidget|XCUIElementTypeTabBar$/;
const DRAWER_TYPES = /NavigationView|DrawerLayout/;
const NAVBAR_TYPES = /XCUIElementTypeNavigationBar$|Toolbar$|ActionBar/;

/** Elements of one page source, with their tree position. */
export function parseScreen(xml: string, platform: ExplorePlatform): ScreenElement[] {
  const out: ScreenElement[] = [];
  const stack: Array<{ type: string; list: boolean; nav: ScreenElement['inNavigation']; el: ScreenElement | null }> = [];
  const tagRe = /<(\/?)([\w.]+)((?:\s[^>]*?)?)(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(xml)) !== null) {
    const [, closing, rawType, attrs, selfClosing] = m;
    if (rawType === 'hierarchy' || rawType === 'AppiumAUT' || rawType.startsWith('?')) continue;
    if (closing) { stack.pop(); continue; }
    const type = platform === 'android' ? (attr(attrs, 'class') ?? rawType) : rawType;
    const parentList = stack.some((s) => s.list);
    const parentNav = [...stack].reverse().find((s) => s.nav)?.nav ?? null;
    const nav: ScreenElement['inNavigation'] = TAB_TYPES.test(type) ? 'tabs' : DRAWER_TYPES.test(type) ? 'drawer' : NAVBAR_TYPES.test(type) ? 'navbar' : null;
    let bounds: ScreenElement['bounds'] = null;
    if (platform === 'android') {
      const b = attr(attrs, 'bounds')?.match(/\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/);
      if (b) bounds = [Number(b[1]), Number(b[2]), Number(b[3]), Number(b[4])];
    } else {
      const [x, y, w, h] = ['x', 'y', 'width', 'height'].map((k) => attr(attrs, k));
      if (x != null && y != null && w != null && h != null) bounds = [Number(x), Number(y), Number(x) + Number(w), Number(y) + Number(h)];
    }
    const visible = platform === 'ios' ? attr(attrs, 'visible') !== 'false' : true;
    const el: ScreenElement = {
      type,
      id: platform === 'android' ? attr(attrs, 'resource-id') || null : attr(attrs, 'name') || null,
      text: platform === 'android' ? attr(attrs, 'text') || null : attr(attrs, 'label') || attr(attrs, 'value') || null,
      description: platform === 'android' ? attr(attrs, 'content-desc') || null : attr(attrs, 'label') || null,
      innerText: null,
      innerParts: [],
      clickable: platform === 'android' ? attr(attrs, 'clickable') === 'true' : visible && attr(attrs, 'enabled') !== 'false' && /Button|Cell|Link|Tab|MenuItem|Switch|TextField|SecureTextField|SearchField/.test(type),
      enabled: attr(attrs, 'enabled') !== 'false',
      checkable: attr(attrs, 'checkable') === 'true' || /Switch|CheckBox|Toggle/.test(type),
      password: attr(attrs, 'password') === 'true' || /SecureTextField$/.test(type),
      bounds,
      depth: stack.length,
      path: [...stack.map((s) => s.type.split('.').pop()), type.split('.').pop()].join('/'),
      inList: parentList,
      inNavigation: parentNav,
    };
    if (visible) out.push(el);
    // Compose / SwiftUI: a tappable container has no words of its own; give it its first child texts.
    const words = el.text ?? el.description;
    if (words && visible) {
      for (let i = stack.length - 1; i >= 0; i--) {
        const anc = stack[i].el;
        if (anc && anc.clickable) {
          if (!anc.text && !anc.description && anc.innerParts.length < 4 && !anc.innerParts.includes(words)) { anc.innerParts.push(words); anc.innerText = anc.innerParts.join(' '); }
          break;
        }
      }
    }
    if (!selfClosing) stack.push({ type, list: LIST_TYPES.test(type), nav, el: visible ? el : null });
  }
  return out;
}

/** Strips what changes per visit from a structural path: list row positions are already gone (paths hold types only). */
const roundBounds = (b: ScreenElement['bounds']) => (b ? b.map((v) => Math.round(v / 50)).join(',') : '');

/**
 * A stable signature for "this screen". foreground = activity (Android) or the navigation bar title (iOS), when known.
 * Text values are left out (except headers, which name the screen), repeated list rows count once, bounds are coarse.
 */
export function screenSignature(elements: ScreenElement[], foreground?: string | null): string {
  const keys = new Set<string>();
  for (const e of elements) {
    if (e.inList) {
      // One template row: its structure, once.
      keys.add(`row:${e.path}:${e.id ?? ''}`);
      continue;
    }
    const header = e.inNavigation === 'navbar' && /StaticText|TextView|Heading|Title/.test(e.type) ? e.text ?? '' : '';
    keys.add(`${e.path}:${e.id ?? ''}:${header}:${e.inNavigation ?? ''}:${e.inList ? '' : roundBounds(e.bounds)}`);
  }
  const body = [...keys].sort().join('\n');
  return createHash('sha256').update(`${foreground ?? ''}\n${body}`).digest('hex').slice(0, 16);
}

export type TapClass = 'navigation' | 'input' | 'action' | 'destructive' | 'unknown';

// Words that name a navigation target in many apps; matched on the WHOLE label, case-insensitive.
const NAV_WORDS = /^(back|close|cancel|done|more|menu|settings|details|home|profile|account|help|about|next|previous|see all|view all|show more|open)$/i;
// A second net only: a label with any of these is never tapped, whatever the structure says.
// DESTRUCTIVE: always needs the user's confirmation, one by one (owner decision 2026-11-27; a session-wide yes never
// covers it). WRITE: tapped only when the user allowed write paths for the session. Both are a second net only.
const DESTRUCTIVE = /\b(delete|remove|erase|reset|wipe|close account|deactivate|unsubscribe|uninstall|sign ?out|log ?out|logout)\b/i;
const WRITE = /\b(pay|send|transfer|buy|purchase|order|checkout|save|submit|confirm|post|publish|call|dial|withdraw|deposit|book|subscribe|approve|accept|decline|share|install|update|apply)\b/i;

/** Whether an element carries words a person reads (a label of only "▾", "." or "›" is no label). */
export function hasWords(e: ScreenElement): boolean {
  return /[\p{L}\p{N}]/u.test(e.text ?? e.description ?? e.innerText ?? '');
}

/**
 * A screen still loading: a progress bar / activity indicator, or a "Loading…" / "Please wait" text. The crawler keeps
 * reading until it is gone (or its settle limit passes), so a half-drawn screen is never recorded as a screen of its own.
 */
export function isLoading(els: ScreenElement[]): boolean {
  return els.some((e) => /ProgressBar|ActivityIndicator|CircularProgress/i.test(e.type) ||
    /^(loading|please wait|signing in|logging in)\b/i.test((e.text ?? e.description ?? '').trim()));
}

const VIEW_PHRASE = /\b(tap|click|touch|press) (here )?to (view|see|open|show|read)\b|\b(view|see|show) (details|history|all|more|statements?|activity|transactions?)\b/i;

/** Whether the crawler may tap an element by itself, and why. */
export function classifyTap(e: ScreenElement, allowWritePaths = false): { kind: TapClass; reason: string } {
  // Punctuation only ("▾", ".") is no label: such a control's effect cannot be read from the screen.
  const label = hasWords(e) ? (e.text ?? e.description ?? e.innerText ?? '').trim() : '';
  if (/EditText|TextField|SecureTextField|SearchField|TextView$/.test(e.type) && /Edit|Field/.test(e.type)) return { kind: 'input', reason: 'a text field: typing is never done without the user' };
  if (e.checkable) return { kind: 'action', reason: 'a switch or check box changes a setting' };
  if (!e.clickable || !e.enabled) return { kind: 'unknown', reason: 'not tappable' };
  if (label && DESTRUCTIVE.test(label)) return { kind: 'destructive', reason: `"${label}" may delete or end something: needs the user’s confirmation each time` };
  if (label && WRITE.test(label)) {
    if (!allowWritePaths || !e.clickable || !e.enabled) return { kind: 'action', reason: `"${label}" may change data (write paths not allowed for this session)` };
    return { kind: 'navigation', reason: `"${label}" may lead to a write path (allowed for this session; nothing is typed or submitted with data)` };
  }
  if (e.inNavigation === 'tabs') return { kind: 'navigation', reason: 'a tab or bottom-navigation item' };
  if (e.inNavigation === 'drawer') return { kind: 'navigation', reason: 'a navigation-drawer item' };
  if (e.inNavigation === 'navbar' && (NAV_WORDS.test(label) || /Back/i.test(e.id ?? ''))) return { kind: 'navigation', reason: 'the navigation bar’s back or close' };
  if (e.inList) return { kind: 'navigation', reason: 'a list or table row' };
  if (label && NAV_WORDS.test(label)) return { kind: 'navigation', reason: `"${label}" is a navigation word` };
  // A card that says it opens something to look at ("Checking — Tap to view history", DAI Bank 2026-11-27) is navigation.
  if (label && VIEW_PHRASE.test(label)) return { kind: 'navigation', reason: `"${label}" says it opens something to view` };
  if (!label) return { kind: 'unknown', reason: 'an icon-only button: its effect cannot be known from the screen' };
  return allowWritePaths
    ? { kind: 'navigation', reason: `"${label}": effect not known; tapped because write paths are allowed for this session` }
    : { kind: 'unknown', reason: `"${label}": a button whose effect is not known; recorded, not tapped (write paths not allowed for this session)` };
}

export interface CandidateTap { element: ScreenElement; reason: string; collapsed: number }

/** The navigation taps of a screen. Rows of one list template are collapsed to the first (the others lead to the same screen type). */
export function candidateTaps(elements: ScreenElement[], allowWritePaths = false): { taps: CandidateTap[]; unvisited: Array<{ element: ScreenElement; kind: TapClass; reason: string }> } {
  const taps: CandidateTap[] = [];
  const unvisited: Array<{ element: ScreenElement; kind: TapClass; reason: string }> = [];
  const rowSeen = new Map<string, CandidateTap>();
  for (const e of elements) {
    const c = classifyTap(e, allowWritePaths);
    if (c.kind !== 'navigation') {
      if (c.kind !== 'unknown' || e.clickable) unvisited.push({ element: e, kind: c.kind, reason: c.reason });
      continue;
    }
    if (e.inList) {
      const key = `${e.path}:${e.id ?? ''}`;
      const seen = rowSeen.get(key);
      if (seen) { seen.collapsed++; continue; }
      const t = { element: e, reason: c.reason, collapsed: 0 };
      rowSeen.set(key, t);
      taps.push(t);
      continue;
    }
    taps.push({ element: e, reason: c.reason, collapsed: 0 });
  }
  return { taps, unvisited };
}

export interface Locator { using: 'id' | 'accessibility id' | 'xpath'; value: string }

/**
 * How to find an element again: resource-id / accessibility identifier, then content-desc (Android's accessibility id),
 * then a text match. Null when nothing stable exists (an icon with no id or label): such an element is not tapped.
 */
export function locatorFor(e: ScreenElement, platform: ExplorePlatform): Locator | null {
  const quote = (s: string) => (s.includes("'") ? `"${s}"` : `'${s}'`);
  if (e.id) return platform === 'android' ? { using: 'id', value: e.id } : { using: 'accessibility id', value: e.id };
  if (platform === 'android' && e.description) return { using: 'accessibility id', value: e.description };
  if (e.text && !e.text.includes('"')) return { using: 'xpath', value: platform === 'android' ? `//*[@text=${quote(e.text)}]` : `//*[@label=${quote(e.text)}]` };
  // A container whose words sit in a child (Compose / SwiftUI): the tappable ancestor of that text.
  const firstPart = e.innerParts[0];
  if (platform === 'android' && firstPart && !firstPart.includes("'")) return { using: 'xpath', value: `//*[@clickable='true'][.//*[@text='${firstPart}' or @content-desc='${firstPart}']]` };
  return null;
}

const SUBMIT_LOGIN = /^(sign in|log in|login|sign on|continue|next|submit|go)$/i;

/** A login screen: a password field and a field for the user name. Returns the parts the crawler needs, or null. */
export function loginParts(elements: ScreenElement[]): { user: ScreenElement; password: ScreenElement; submit: ScreenElement | null } | null {
  const fields = elements.filter((e) => /EditText|TextField|SecureTextField/.test(e.type));
  const password = fields.find((e) => e.password) ?? fields.find((e) => /pass|pin/i.test(`${e.id ?? ''} ${e.text ?? ''} ${e.description ?? ''}`));
  if (!password) return null;
  const user = fields.find((e) => e !== password);
  if (!user) return null;
  const submit = elements.find((e) => e.clickable && SUBMIT_LOGIN.test((e.text ?? e.description ?? '').trim()))
    ?? elements.find((e) => SUBMIT_LOGIN.test((e.text ?? e.description ?? '').trim())) ?? null;
  return { user, password, submit };
}

/** A short title for a screen: the navigation bar title, else the first prominent text. */
export function screenTitle(elements: ScreenElement[]): string {
  const nav = elements.find((e) => e.inNavigation === 'navbar' && e.text && /StaticText|TextView|Title/.test(e.type));
  if (nav?.text) return nav.text;
  const text = elements.find((e) => e.text && e.text.length >= 2 && e.text.length <= 40 && !e.clickable && !/EditText|TextField/.test(e.type));
  return text?.text ?? '(untitled screen)';
}
