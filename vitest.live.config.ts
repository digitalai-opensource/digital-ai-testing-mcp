import { defineConfig } from 'vitest/config';

// Live-probe harness — NOT part of `npm test`. These tests make real API calls
// and assert backend BEHAVIORS that static review and the mocked handler tests
// cannot catch (param-honoring, list-vs-detail field parity, filter semantics).
// Run manually before a release: `npm run test:live` (requires a populated .env).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/live/**/*.live.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
