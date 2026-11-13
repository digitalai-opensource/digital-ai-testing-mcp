/**
 * The failure triage table (src/utils/failure-triage.ts) and its use in the investigate_test_failures prompt.
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerPrompts } from '../src/tools/prompt-tools.js';
import { FAILURE_TRIAGE } from '../src/utils/failure-triage.js';

describe('failure triage table', () => {
  it('every row has a message, a cause and an action; messages are unique', () => {
    assert.ok(FAILURE_TRIAGE.length >= 8);
    for (const r of FAILURE_TRIAGE) {
      assert.ok(r.message && r.cause && r.action, JSON.stringify(r));
    }
    assert.equal(new Set(FAILURE_TRIAGE.map((r) => r.message)).size, FAILURE_TRIAGE.length);
  });

  it('investigate_test_failures carries the table', async () => {
    const server = new McpServer({ name: 't', version: '0' });
    registerPrompts(server);
    const client = new Client({ name: 'c', version: '0' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(b), client.connect(a)]);
    const p = await client.getPrompt({ name: 'investigate_test_failures', arguments: { projectName: 'Default' } });
    const text = (p.messages[0].content as { text: string }).text;
    assert.match(text, /Triage table/);
    for (const r of FAILURE_TRIAGE) assert.ok(text.includes(r.message), r.message);
    await client.close();
  });
});
