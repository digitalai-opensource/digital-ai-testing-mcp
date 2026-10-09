/**
 * download_test_video — session video only, whole or by byte range (verified live 2026-10-09 against
 * /reporter/api/reports/{uuid}/video and /reporter/api/tests/{id}/video). The fake reporter honours Range like the real one.
 */
import { describe, it, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { resetClient } from '../src/api/client.js';
import { registerReportingTools } from '../src/tools/reporting-tools.js';

const UUID = '081a0594-97a7-450f-b9d7-757721434d44';
const VIDEO = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256));
const seen: Array<{ url: string; range?: string }> = [];
let server: http.Server;
let client: Client;
let dir: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = req.url ?? '';
    const range = req.headers.range;
    seen.push({ url, range });
    if (url !== `/reporter/api/reports/${UUID}/video` && url !== '/reporter/api/tests/42/video') {
      res.statusCode = 404;
      return void res.end('{"detail":"not found"}');
    }
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Accept-Ranges', 'bytes');
    if (!range) return void res.end(VIDEO);
    const m = range.match(/^bytes=(\d*)-(\d*)$/)!;
    let start = m[1] === '' ? VIDEO.length - Number(m[2]) : Number(m[1]);
    let end = m[1] === '' || m[2] === '' ? VIDEO.length - 1 : Number(m[2]);
    if (start >= VIDEO.length) {
      res.statusCode = 416;
      res.setHeader('Content-Range', `bytes */${VIDEO.length}`);
      return void res.end('{"status":416}');
    }
    end = Math.min(end, VIDEO.length - 1);
    start = Math.max(start, 0);
    res.statusCode = 206;
    res.setHeader('Content-Range', `bytes ${start}-${end}/${VIDEO.length}`);
    res.end(VIDEO.subarray(start, end + 1));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  resetClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, 'aut_1_video_test', 'video');
  const mcp = new McpServer({ name: 's', version: '0' });
  registerReportingTools(mcp);
  client = new Client({ name: 'c', version: '0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([mcp.connect(b), client.connect(a)]);
  dir = mkdtempSync(join(tmpdir(), 'video-test-'));
});
afterAll(async () => {
  rmSync(dir, { recursive: true, force: true });
  await new Promise<void>((r) => server.close(() => r()));
});

async function call(args: Record<string, unknown>) {
  const res = (await client.callTool({ name: 'download_test_video', arguments: { outputFormat: 'json', ...args } })) as { content: Array<{ text?: string }>; isError?: boolean };
  return { res, text: res.content.map((c) => c.text ?? '').join('') };
}

describe('download_test_video', () => {
  it('infoOnly reads the size from a one-byte range request', async () => {
    seen.length = 0;
    const { res, text } = await call({ report: `https://x/reporter/video-report/${UUID}`, infoOnly: true });
    assert.notEqual(res.isError, true, text);
    assert.equal(JSON.parse(text).totalBytes, 1000);
    assert.deepEqual(seen, [{ url: `/reporter/api/reports/${UUID}/video`, range: 'bytes=0-0' }]);
  });

  it('downloads the whole video', async () => {
    const localPath = join(dir, 'full.mp4');
    const { text } = await call({ report: UUID, localPath });
    assert.equal(JSON.parse(text).partial, false);
    assert.deepEqual(readFileSync(localPath), VIDEO);
  });

  it('downloads a fixed range, an open range and the last N bytes', async () => {
    const p1 = join(dir, 'r1.mp4');
    const r1 = JSON.parse((await call({ report: UUID, localPath: p1, startByte: 100, endByte: 199 })).text);
    assert.equal(r1.partial, true);
    assert.equal(r1.totalBytes, 1000);
    assert.deepEqual(readFileSync(p1), VIDEO.subarray(100, 200));

    const p2 = join(dir, 'r2.mp4');
    await call({ report: UUID, localPath: p2, startByte: 900 });
    assert.deepEqual(readFileSync(p2), VIDEO.subarray(900));

    const p3 = join(dir, 'r3.mp4');
    seen.length = 0;
    await call({ report: '42', localPath: p3, lastBytes: 10 });
    assert.deepEqual(seen.at(-1), { url: '/reporter/api/tests/42/video', range: 'bytes=-10' });
    assert.deepEqual(readFileSync(p3), VIDEO.subarray(990));
  });

  it('explains an out-of-bounds range and rejects bad combinations before calling the API', async () => {
    const { res, text } = await call({ report: UUID, localPath: join(dir, 'x.mp4'), startByte: 5000 });
    assert.equal(res.isError, true);
    assert.match(text, /outside the video.*infoOnly/);
    seen.length = 0;
    assert.match((await call({ report: UUID, localPath: join(dir, 'y.mp4'), lastBytes: 5, startByte: 1 })).text, /either lastBytes or startByte/);
    assert.match((await call({ report: UUID, localPath: join(dir, 'y.mp4'), endByte: 5 })).text, /endByte needs startByte/);
    assert.match((await call({ report: UUID })).text, /localPath is required/);
    assert.deepEqual(seen, []);
  });
});
