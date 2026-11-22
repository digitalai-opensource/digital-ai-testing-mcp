import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { quitAllSessions, handOffToWorker } from '../src/api/shutdown.js';
import type { InspectionSession } from '../src/types/digital-ai.js';

describe('graceful shutdown — detached cleanup worker', () => {
  it('starts the worker detached with the sessions and the active profile, then lets go of it', () => {
    let call: { cmd: string; args: string[]; opts: Record<string, unknown> } | undefined;
    let unref = false;
    const fakeSpawn = ((cmd: string, args: string[], opts: Record<string, unknown>) => {
      call = { cmd, args, opts };
      return { pid: 4242, on: () => undefined, unref: () => { unref = true; } };
    }) as never;
    const session = { handle: 'abc12345', gridSessionId: 'CLOUD-SID:1', reportTestId: 77, projectName: 'Default', canDeleteReport: true } as InspectionSession;
    assert.equal(handOffToWorker([session], { spawnFn: fakeSpawn }), true);
    assert.ok(call);
    assert.equal(call.cmd, process.execPath);
    assert.match(call.args[call.args.length - 1], /shutdown-worker\.(ts|js)$/);
    assert.equal(call.opts.detached, true, 'a detached child is not killed with the server');
    assert.equal(call.opts.stdio, 'ignore');
    const env = call.opts.env as Record<string, string>;
    assert.deepEqual(JSON.parse(env.DAI_SHUTDOWN_SESSIONS), [session]);
    assert.equal(env.MCP_CREDENTIAL_STORE, 'off', 'the worker uses exactly the profile it was given');
    assert.ok(unref);
  });

  it('reports failure when the worker cannot start, so the server quits in-process instead', () => {
    const throwing = (() => { throw new Error('EPERM'); }) as never;
    assert.equal(handOffToWorker([], { spawnFn: throwing }), false);
  });
});

const sessions = (n: number) => Array.from({ length: n }, (_, i) => ({ handle: `h${i}` }));

describe('graceful shutdown — quitAllSessions', () => {
  it('does nothing when no session is open', async () => {
    let called = 0;
    const r = await quitAllSessions({ list: () => [], quit: async () => { called++; } });
    assert.deepEqual(r, { open: 0, quit: 0, failed: 0, timedOut: false, ms: 0 });
    assert.equal(called, 0);
  });

  it('quits every open session in parallel and counts failures without throwing', async () => {
    const quit: string[] = [];
    const r = await quitAllSessions({
      list: () => sessions(3),
      quit: async (h) => {
        await new Promise((res) => setTimeout(res, 50));
        if (h === 'h1') throw new Error('session already gone');
        quit.push(h);
      },
      timeoutMs: 2_000,
    });
    assert.equal(r.open, 3);
    assert.equal(r.quit, 2);
    assert.equal(r.failed, 1);
    assert.equal(r.timedOut, false);
    assert.ok(r.ms < 1_000, `parallel, not serial (${r.ms} ms)`);
  });

  it('stops waiting at the deadline so a dead network cannot hang the exit', async () => {
    const r = await quitAllSessions({
      list: () => sessions(2),
      quit: (h) => (h === 'h0' ? Promise.resolve() : new Promise(() => { /* never settles */ })),
      timeoutMs: 100,
    });
    assert.equal(r.timedOut, true);
    assert.equal(r.quit, 1);
    assert.ok(r.ms >= 90 && r.ms < 1_000);
  });
});
