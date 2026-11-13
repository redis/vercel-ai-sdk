import { defineConfig } from 'vitest/config';

// Patterns resolve against --dir, so `vitest run --dir test` finds test/*.test.ts.
export default defineConfig({ test: { include: ['**/*.test.ts'] } });
