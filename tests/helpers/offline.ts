/**
 * Offline handler-test harness: a local HTTP server standing in for the platform (and the Grid), plus an
 * in-memory MCP client over the registered tool modules. Nothing here touches the live API or needs .env.
 *
 *   const api = await startStubApi((req) => {
 *     if (req.path === '/api/v1/users/my-account-info') return accountInfo('Admin', 'Default');
 *     if (req.path === '/reporter/api/tests/list') return { count: 1, data: [...] };
 *     return undefined; // → 404 {}
 *   });
 *   const tools = await connectTools(registerReportingTools);
 *   const j = await tools.callJson('get_test_report', { testId: 1 });
 *   ...
 *   await tools.close(); await api.close();
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { resetClient } from '../../src/api/client.js';
import { clearAccessInfoCache } from '../../src/utils/access-level.js';

export interface StubRequest {
  method: string;
  /** Full URL as sent (path + query). */
  url: string;
  path: string;
  query: URLSearchParams;
  headers: http.IncomingHttpHeaders;
  raw: string;
  /** Parsed JSON body, or {} when the body is empty / not JSON. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json: Record<string, any>;
}

class Reply {
  constructor(public readonly status: number, public readonly body: unknown) {}
}

/** Answer with a specific status. A string body is sent verbatim; anything else is JSON-encoded. */
export function reply(status: number, body: unknown = {}): Reply {
  return new Reply(status, body);
}

/** The `{ status, data }` envelope `/api/v1/users/my-account-info` returns. */
export function accountInfo(role: string, projectName: string, extra: Record<string, unknown> = {}) {
  return {
    status: 'SUCCESS',
    data: { username: 'u', firstName: 'U', lastName: 'T', role, project: { id: 1, name: projectName, isAppiumOss: true }, ...extra },
  };
}

/** Return `undefined` for 404, a plain value for 200 JSON, or `reply(status, body)`. May be async (e.g. to delay). */
export type StubHandler = (req: StubRequest) => unknown | Promise<unknown>;

export interface StubApi {
  baseUrl: string;
  /** Every request seen, oldest first — clear it in `beforeEach` when a test asserts on traffic. */
  requests: StubRequest[];
  close(): Promise<void>;
}

export interface StubOptions {
  key?: string;
  profile?: string;
  /** Skip pointing the API client at the stub (e.g. when the test manages profiles itself). */
  noResetClient?: boolean;
}

export async function startStubApi(handler: StubHandler, opts: StubOptions = {}): Promise<StubApi> {
  const requests: StubRequest[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', async () => {
      const u = new URL(req.url ?? '/', 'http://stub');
      let json: Record<string, unknown> = {};
      try { json = raw ? JSON.parse(raw) : {}; } catch { /* multipart or plain text */ }
      const stubReq: StubRequest = {
        method: req.method ?? 'GET', url: req.url ?? '/', path: u.pathname, query: u.searchParams, headers: req.headers, raw, json,
      };
      requests.push(stubReq);
      const out = await handler(stubReq);
      res.setHeader('Content-Type', 'application/json');
      if (out === undefined) { res.statusCode = 404; return void res.end('{}'); }
      const r = out instanceof Reply ? out : new Reply(200, out);
      res.statusCode = r.status;
      res.end(typeof r.body === 'string' ? r.body : JSON.stringify(r.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  if (!opts.noResetClient) {
    clearAccessInfoCache();
    resetClient(baseUrl, opts.key ?? 'aut_1_stub_key', opts.profile ?? 'stub');
  }
  return { baseUrl, requests, close: () => new Promise<void>((r) => server.close(() => r())) };
}

export interface ToolResult {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  isError?: boolean;
}

export interface ToolClient {
  client: Client;
  call(name: string, args?: Record<string, unknown>): Promise<{ res: ToolResult; text: string }>;
  /** Calls with `outputFormat: 'json'`, asserts the call did not error, and parses the payload. */
  callJson(name: string, args?: Record<string, unknown>): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

export async function connectTools(...registrars: Array<(server: McpServer) => void>): Promise<ToolClient> {
  const server = new McpServer({ name: 'stub-server', version: '0' });
  for (const register of registrars) register(server);
  const client = new Client({ name: 'stub-client', version: '0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as unknown as ToolResult;
    return { res, text: res.content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('') };
  };
  return {
    client,
    call,
    async callJson(name, args = {}) {
      const { res, text } = await call(name, { ...args, outputFormat: 'json' });
      assert.notEqual(res.isError, true, text);
      return JSON.parse(text) as Record<string, unknown>;
    },
    close: () => client.close(),
  };
}
