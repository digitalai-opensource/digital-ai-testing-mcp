/**
 * Transaction tool handlers against a stub reporter (tests/api/transactions.test.ts covers the live API itself).
 *  - deviceOs arrives as "IOS"/"ANDROID" for recent records → normalised once at the API boundary (UAT #20)
 *  - every transaction JSON carries Speed Index semantics — it is a composite score, not a duration
 *  - groups without a Speed Index sort strictly last in the performance summary
 */
import { describe, it, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import { normaliseDeviceOs, listTransactions } from '../src/api/transactions.js';
import { registerTransactionTools } from '../src/tools/transaction-tools.js';
import { startStubApi, connectTools, type StubApi, type ToolClient } from './helpers/offline.js';

const TXS = [
  { id: 1, name: 'Login', deviceOs: 'IOS', startTime: '2026-09-17T00:00:00Z', duration: 1000, speedIndex: -1 },
  { id: 2, name: 'Login', deviceOs: 'iOS', startTime: '2024-11-05T00:00:00Z', duration: 1000, speedIndex: 900 },
  { id: 3, name: 'Login', deviceOs: 'ANDROID', startTime: '2026-09-01T00:00:00Z', duration: 1000, speedIndex: 800 },
  { id: 4, name: 'Checkout', deviceOs: 'Android', startTime: '2026-09-02T00:00:00Z', duration: 1000, speedIndex: 0 },
  { id: 5, name: 'NoSI', deviceOs: 'Android', startTime: '2026-09-03T00:00:00Z', duration: 1000, speedIndex: -1 },
];

let api: StubApi;
let tools: ToolClient;

beforeAll(async () => {
  api = await startStubApi((req) => (req.path === '/reporter/api/transactions/list' ? { count: null, data: TXS } : undefined));
  tools = await connectTools(registerTransactionTools);
});
afterAll(async () => { await tools.close(); await api.close(); });

describe('normaliseDeviceOs (pure)', () => {
  it('folds every casing to iOS / Android and leaves anything else alone', () => {
    for (const v of ['IOS', 'ios', 'iOS', ' iOS ']) assert.equal(normaliseDeviceOs(v), 'iOS');
    for (const v of ['ANDROID', 'android', 'Android']) assert.equal(normaliseDeviceOs(v), 'Android');
    assert.equal(normaliseDeviceOs('Windows'), 'Windows');
    assert.equal(normaliseDeviceOs(undefined), undefined);
  });
});

describe('deviceOs casing at the API boundary', () => {
  it('listTransactions returns normalised deviceOs and still maps the -1 Speed Index sentinel to null', async () => {
    const txs = await listTransactions();
    assert.deepEqual(txs.slice(0, 3).map((t) => t.deviceOs), ['iOS', 'iOS', 'Android']);
    assert.equal(txs[0].speedIndex, null);
  });

  it('list_transactions(deviceOs: "iOS") includes records the API stored as "IOS"', async () => {
    const j = await tools.callJson('list_transactions', { deviceOs: 'iOS' });
    assert.deepEqual((j.transactions as Array<{ id: number }>).map((t) => t.id).sort(), [1, 2]);
  });
});

describe('Speed Index semantics', () => {
  it('transaction JSON says Speed Index is a composite score, not a duration', async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['list_transactions', {}],
      ['get_transaction_performance_summary', { groupBy: 'name' }],
      ['get_performance_trend', { lookbackDays: 730 }],
    ];
    for (const [tool, args] of cases) {
      const j = await tools.callJson(tool, args);
      const si = (j.metricSemantics as { speedIndex?: { unit?: string; notADuration?: boolean } } | undefined)?.speedIndex;
      assert.equal(si?.unit, 'SI', tool);
      assert.equal(si?.notADuration, true, tool);
    }
  });

  it('get_transaction_performance_summary sorts groups without a Speed Index strictly last', async () => {
    const j = await tools.callJson('get_transaction_performance_summary', { groupBy: 'name' });
    const order = (j.groups as Array<{ name: string; avgSpeedIndex: number | null }>).map((g) => [g.name, g.avgSpeedIndex] as const);
    assert.deepEqual(order.at(-1), ['NoSI', null]);
    assert.ok(order.findIndex(([n]) => n === 'Checkout') < order.length - 1, 'a real 0 sorts before null');
  });
});
