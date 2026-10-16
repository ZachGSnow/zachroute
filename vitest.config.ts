import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts, whose root is src/ (the app). Tests live in test/ and run in
// Node against fixtures captured from the real upstream sources (see test/fixtures/README.md).
export default defineConfig({
  test: {
    root: '.',
    include: ['test/**/*.test.ts'],
    environment: 'node',
    restoreMocks: true,
    unstubGlobals: true,
  },
});
