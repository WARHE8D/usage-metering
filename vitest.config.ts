import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit-node',
          environment: 'node',
          include: ['{shared,api,worker}/src/**/*.test.ts'],
          exclude: ['**/*.int.test.ts', '**/node_modules/**', '**/dist/**'],
        },
      },
      {
        plugins: [react()],
        test: {
          name: 'unit-web',
          environment: 'jsdom',
          include: ['web/src/**/*.test.{ts,tsx}'],
          exclude: ['**/*.int.test.{ts,tsx}', '**/node_modules/**', '**/dist/**'],
        },
      },
      {
        test: {
          name: 'integration',
          environment: 'node',
          include: ['**/src/**/*.int.test.ts'],
          exclude: ['**/node_modules/**', '**/dist/**'],
          testTimeout: 30_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
