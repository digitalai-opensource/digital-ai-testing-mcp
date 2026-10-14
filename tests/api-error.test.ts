import { describe, it, expect } from 'vitest';
import { extractApiErrorMessage } from '../src/utils/api-error.js';
import { Buffer } from 'node:buffer';

describe('extractApiErrorMessage', () => {
  it('prefers a top-level message', () => {
    expect(extractApiErrorMessage({ message: 'You have no permission to delete tests', data: 'x' }))
      .toBe('You have no permission to delete tests');
  });

  it('uses a string data field (v1 envelope)', () => {
    expect(extractApiErrorMessage({ status: 'ERROR', code: 403, data: 'Forbidden for this role' }))
      .toBe('Forbidden for this role');
  });

  it('never renders [object Object] for an object data field', () => {
    const msg = extractApiErrorMessage({ status: 'ERROR', data: { message: 'Requires Cloud Admin' } });
    expect(msg).toBe('Requires Cloud Admin');
    expect(extractApiErrorMessage({ data: { code: 17, reason: 'nope' } })).toBe('{"code":17,"reason":"nope"}');
    expect(extractApiErrorMessage({ data: { a: 1 } }, 'fallback')).not.toContain('[object Object]');
  });

  it('skips empty strings instead of returning a blank message', () => {
    expect(extractApiErrorMessage({ message: '', error: 'Forbidden' })).toBe('Forbidden');
  });

  it('accepts a bare string body and ignores HTML pages', () => {
    expect(extractApiErrorMessage('Unauthorized', 'Request failed with status code 401')).toBe('Unauthorized');
    expect(extractApiErrorMessage('<!DOCTYPE html><html>…</html>', 'Request failed with status code 404'))
      .toBe('Request failed with status code 404');
  });

  it('falls back to the axios message, then a fixed text', () => {
    expect(extractApiErrorMessage(undefined, 'timeout of 30000ms exceeded')).toBe('timeout of 30000ms exceeded');
    expect(extractApiErrorMessage({}, undefined)).toBe('Unknown error');
  });

  it('truncates very long details', () => {
    const msg = extractApiErrorMessage({ message: 'x'.repeat(1000) });
    expect(msg.length).toBeLessThanOrEqual(301);
    expect(msg.endsWith('…')).toBe(true);
  });

  it('decodes a binary (arraybuffer) body instead of dumping bytes', () => {
    const json = Buffer.from(JSON.stringify({ message: 'Attachment not found' }), 'utf-8');
    expect(extractApiErrorMessage(json, 'Request failed with status code 404')).toBe('Attachment not found');
    const text = Buffer.from('Forbidden for this role', 'utf-8');
    expect(extractApiErrorMessage(text, 'fallback')).toBe('Forbidden for this role');
    const html = Buffer.from('<!DOCTYPE html><html>nope</html>', 'utf-8');
    expect(extractApiErrorMessage(html, 'Request failed with status code 404')).toBe('Request failed with status code 404');
    const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00]);
    expect(extractApiErrorMessage(binary, 'Request failed with status code 404')).toBe('Request failed with status code 404');
    expect(extractApiErrorMessage(new Uint8Array(json).buffer, 'x')).toBe('Attachment not found');
  });

  it('ignores boolean/numeric envelope fields rather than rendering "true" or "0"', () => {
    // Flags fall through to the JSON dump of the body, never to "true" / "0".
    expect(extractApiErrorMessage({ error: true, message: '' }, 'Request failed with status code 403'))
      .toBe('{"error":true,"message":""}');
    expect(extractApiErrorMessage({ data: 0 }, 'fallback')).toBe('{"data":0}');
    expect(extractApiErrorMessage({ error: true }, 'fallback')).not.toBe('true');
    expect(extractApiErrorMessage({ error: true, code: 403, data: 'Forbidden' })).toBe('Forbidden');
  });

  it('joins messages from an array body (validation-error lists)', () => {
    expect(extractApiErrorMessage([{ field: 'name', message: 'must not be blank' }])).toBe('must not be blank');
    expect(extractApiErrorMessage([{ message: 'a' }, { message: 'b' }])).toBe('a; b');
    expect(extractApiErrorMessage({ data: [{ message: 'nested list' }] })).toBe('nested list');
    expect(extractApiErrorMessage([], 'fallback')).toBe('fallback');
  });
});
