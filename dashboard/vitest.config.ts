import { defineProject } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineProject({
  plugins: [react()],
  test: {
    name: 'dashboard',
    environment: 'jsdom',
    include: ['test/**/*.test.{ts,tsx}'],
  },
});
