import { defineConfig } from 'vitest/config';

// Two projects, one convention:
//  - offline  tests/**/*.test.ts except tests/api — unit and handler tests against stub servers; no .env, runs in CI
//  - api      tests/api/*.test.ts — integration tests against the live tenant through tests/helpers/test-client.ts;
//             needs a populated .env and is local-only
// `npm test` runs both (needs .env); `npm run test:offline` / `npm run test:api` pick one.
// tests/live/*.live.ts (vitest.live.config.ts) are the separate pre-release behaviour probes.
const shared = { environment: 'node' as const, testTimeout: 30000, hookTimeout: 30000 };

export default defineConfig({
  test: {
    ...shared,
    projects: [
      { test: { ...shared, name: 'offline', include: ['tests/**/*.test.ts'], exclude: ['tests/api/**', '**/node_modules/**'] } },
      { test: { ...shared, name: 'api', include: ['tests/api/**/*.test.ts'] } },
    ],
  },
});
