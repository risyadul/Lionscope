import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['protocol', 'server', 'dashboard'],
    coverage: {
      provider: 'v8',
      include: ['protocol/src/**', 'server/src/**', 'dashboard/src/lib/**'],
      exclude: ['server/src/main.ts', '**/*.d.ts'],
      reporter: ['text-summary', 'text'],
    },
  },
});
