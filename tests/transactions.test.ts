import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { listTransactions, getTransaction } from './helpers/test-client.js';

describe('Transactions API', () => {
  it('POST /reporter/api/transactions/list — returns array', async () => {
    const txs = await listTransactions();
    assert.ok(Array.isArray(txs), 'listTransactions should return an array');
  });

  it('POST /reporter/api/transactions/list — each record has required fields', async () => {
    const txs = await listTransactions();
    if (txs.length === 0) return; // No data in this environment — skip field checks
    const t = txs[0];
    assert.ok(typeof t.id === 'number', 'id should be a number');
    assert.ok(typeof t.name === 'string', 'name should be a string');
    assert.ok(typeof t.appName === 'string', 'appName should be a string');
    assert.ok(typeof t.duration === 'number', 'duration should be a number');
    assert.ok(typeof t.startTime === 'string', 'startTime should be a string');
    assert.ok(!isNaN(new Date(t.startTime).getTime()), 'startTime should be parseable as a date');
  });

  it('POST /reporter/api/transactions/list — performance metric fields are number or null', async () => {
    const txs = await listTransactions();
    if (txs.length === 0) return;
    const t = txs[0];
    assert.ok(t.cpuAvg === null || typeof t.cpuAvg === 'number', 'cpuAvg should be number or null');
    assert.ok(t.memAvg === null || typeof t.memAvg === 'number', 'memAvg should be number or null');
    assert.ok(t.batteryAvg === null || typeof t.batteryAvg === 'number', 'batteryAvg should be number or null');
    assert.ok(typeof t.totalUploadedBytes === 'number', 'totalUploadedBytes should be a number');
    assert.ok(typeof t.totalDownloadedBytes === 'number', 'totalDownloadedBytes should be a number');
  });

  it('POST /reporter/api/transactions/list — duration is a positive number', async () => {
    const txs = await listTransactions();
    if (txs.length === 0) return;
    for (const t of txs.slice(0, 5)) {
      assert.ok(t.duration >= 0, `duration should be >= 0, got ${t.duration}`);
    }
  });

  it('GET /reporter/api/transactions/{id} — returns single transaction with time-series fields', async () => {
    const txs = await listTransactions();
    if (txs.length === 0) return;
    const tx = await getTransaction(txs[0].id);
    assert.ok(typeof tx.id === 'number', 'id should be a number');
    assert.ok(typeof tx.name === 'string', 'name should be a string');
    // Time-series arrays may be empty but should be arrays if present
    if (tx.cpuSamples !== undefined) {
      assert.ok(Array.isArray(tx.cpuSamples), 'cpuSamples should be an array');
    }
    if (tx.memorySamples !== undefined) {
      assert.ok(Array.isArray(tx.memorySamples), 'memorySamples should be an array');
    }
  });

  it('GET /reporter/api/transactions/{id} — time-series samples have timestamp and value', async () => {
    const txs = await listTransactions();
    if (txs.length === 0) return;
    const tx = await getTransaction(txs[0].id);
    for (const sample of (tx.cpuSamples ?? []).slice(0, 3)) {
      assert.ok(typeof sample.timestamp === 'number', 'sample.timestamp should be a number');
      assert.ok(typeof sample.value === 'number', 'sample.value should be a number');
    }
  });
});
