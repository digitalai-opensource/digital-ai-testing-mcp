/**
 * Console and network capture for browser inspection sessions over WebDriver BiDi (platform 25.11+).
 *
 * Verified live 2026-11-12 (uscloud): with `webSocketUrl: true` the session capabilities carry
 * `wss://<cloud>/selenium-<n>/bidi/<session>`; `session.subscribe` to log.entryAdded / network.responseCompleted /
 * network.fetchError delivered console.error/info, an uncaught exception and a 404 on Chrome 158, Firefox 160,
 * Edge 157 and Opera 138. Safari with `webSocketUrl: true` never answered the session request (>120 s) — never ask
 * for BiDi there. The socket needs no credential beyond the URL itself.
 *
 * Only failures are buffered for network traffic (status >= 400 or a fetch error); successful requests are counted.
 * The buffer keeps the newest MAX_EVENTS entries.
 */

export const BIDI_BROWSERS: ReadonlySet<string> = new Set(['chrome', 'MicrosoftEdge', 'firefox', 'opera']);
export const MAX_EVENTS = 500;
const SUBSCRIBE_EVENTS = ['log.entryAdded', 'network.responseCompleted', 'network.fetchError'];

export interface BrowserEvent {
  kind: 'console' | 'javascript' | 'network';
  level: string;          // console: debug|info|warn|error; javascript: error; network: error
  text: string;
  url?: string;           // network: request URL; javascript: script location when known
  status?: number;        // network
  method?: string;        // network
  time: number;           // epoch ms (BiDi timestamp, else receipt time)
}

interface Capture {
  socket: WebSocket;
  events: BrowserEvent[];
  dropped: number;
  okRequests: number;
  subscribed: boolean;
  closedReason?: string;
}

const captures = new Map<string, Capture>();

/** Turn one BiDi message into an event, 'ok-request' for a successful network response, or null to ignore. */
export function normalizeBidiMessage(raw: string, now = Date.now()): BrowserEvent | 'ok-request' | null {
  interface BidiParams {
    timestamp?: number; type?: string; level?: string; text?: string; errorText?: string;
    stackTrace?: { callFrames?: Array<{ url?: string; lineNumber?: number }> };
    request?: { url?: string; method?: string };
    response?: { status?: number; statusText?: string };
  }
  let msg: { method?: string; params?: BidiParams };
  try { msg = JSON.parse(raw); } catch { return null; }
  const p: BidiParams = msg.params ?? {};
  const time = typeof p.timestamp === 'number' ? p.timestamp : now;
  if (msg.method === 'log.entryAdded') {
    const frame = p.stackTrace?.callFrames?.[0];
    const where = frame?.url ? `${frame.url}${frame.lineNumber != null ? `:${frame.lineNumber + 1}` : ''}` : undefined;
    return {
      kind: p.type === 'javascript' ? 'javascript' : 'console',
      level: String(p.level ?? 'info'),
      text: String(p.text ?? ''),
      url: where,
      time,
    };
  }
  if (msg.method === 'network.responseCompleted') {
    const status = Number(p.response?.status);
    if (!(status >= 400)) return 'ok-request';
    return { kind: 'network', level: 'error', text: `${status} ${p.response?.statusText ?? ''}`.trim(), url: p.request?.url, status, method: p.request?.method, time };
  }
  if (msg.method === 'network.fetchError') {
    return { kind: 'network', level: 'error', text: String(p.errorText ?? 'request failed'), url: p.request?.url, method: p.request?.method, time };
  }
  return null;
}

/** Connect and subscribe. Resolves to null when capture is running, else the reason it is not. Never throws. */
export async function startBrowserEventCapture(handle: string, wsUrl: string, timeoutMs = 10_000): Promise<string | null> {
  if (typeof WebSocket === 'undefined') return 'this Node.js runtime has no WebSocket (Node 22+ needed)';
  let socket: WebSocket;
  try { socket = new WebSocket(wsUrl); } catch (e) { return `could not open the BiDi socket: ${(e as Error).message}`; }
  const cap: Capture = { socket, events: [], dropped: 0, okRequests: 0, subscribed: false };
  return new Promise((resolve) => {
    const timer = setTimeout(() => { try { socket.close(); } catch { /* ignore */ } resolve(`the BiDi socket did not answer within ${Math.round(timeoutMs / 1000)} s`); }, timeoutMs);
    socket.onerror = () => { clearTimeout(timer); if (!cap.subscribed) resolve('the BiDi socket refused the connection'); };
    socket.onclose = () => {
      cap.closedReason = cap.closedReason ?? 'the browser closed the BiDi socket';
      // Closed before the subscribe reply (no error event): answer now instead of holding the session start for the timeout.
      if (!cap.subscribed) { clearTimeout(timer); resolve('the BiDi socket closed before the subscription was confirmed'); }
    };
    socket.onopen = () => socket.send(JSON.stringify({ id: 1, method: 'session.subscribe', params: { events: SUBSCRIBE_EVENTS } }));
    socket.onmessage = (m) => {
      const raw = String(m.data);
      if (!cap.subscribed) {
        try {
          const j = JSON.parse(raw);
          if (j.id === 1) {
            clearTimeout(timer);
            if (j.type === 'error' || j.error) { try { socket.close(); } catch { /* ignore */ } resolve(`session.subscribe failed: ${j.message ?? j.error}`); return; }
            cap.subscribed = true;
            captures.set(handle, cap);
            resolve(null);
            return;
          }
        } catch { /* not the subscribe reply */ }
      }
      const ev = normalizeBidiMessage(raw);
      if (ev === 'ok-request') cap.okRequests++;
      else if (ev) {
        cap.events.push(ev);
        if (cap.events.length > MAX_EVENTS) { cap.events.shift(); cap.dropped++; }
      }
    };
  });
}

export function hasBrowserEventCapture(handle: string): boolean {
  return captures.has(handle);
}

export interface BrowserEventQuery {
  kind?: 'all' | 'console' | 'network';
  errorsOnly?: boolean;
  clear?: boolean;
  maxEntries?: number;
}

export interface BrowserEventResult {
  events: BrowserEvent[];
  matched: number;
  buffered: number;
  dropped: number;
  okRequests: number;
  socketClosed?: string;
}

/** Filter and return captured events (newest last); `clear` empties the buffer after reading. Null if not capturing. */
export function readBrowserEvents(handle: string, q: BrowserEventQuery = {}): BrowserEventResult | null {
  const cap = captures.get(handle);
  if (!cap) return null;
  const kind = q.kind ?? 'all';
  const matched = cap.events.filter((e) =>
    (kind === 'all' || (kind === 'network' ? e.kind === 'network' : e.kind !== 'network')) &&
    (!q.errorsOnly || e.level === 'error'));
  const max = Math.max(1, q.maxEntries ?? 50);
  const result: BrowserEventResult = {
    events: matched.slice(-max),
    matched: matched.length,
    buffered: cap.events.length,
    dropped: cap.dropped,
    okRequests: cap.okRequests,
    ...(cap.socket.readyState === 3 ? { socketClosed: cap.closedReason ?? 'closed' } : {}),
  };
  if (q.clear) { cap.events = []; cap.dropped = 0; cap.okRequests = 0; }
  return result;
}

export function stopBrowserEventCapture(handle: string): void {
  const cap = captures.get(handle);
  if (!cap) return;
  captures.delete(handle);
  try { cap.socket.close(); } catch { /* already closed */ }
}

/** Test seam: register a capture whose socket is a stub, so readBrowserEvents can be exercised offline. */
export function injectBrowserEventsForTests(handle: string, events: BrowserEvent[], okRequests = 0): void {
  captures.set(handle, { socket: { readyState: 1, close() {} } as unknown as WebSocket, events: [...events], dropped: 0, okRequests, subscribed: true });
}
