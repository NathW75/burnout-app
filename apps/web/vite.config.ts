/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import { securityHeaders } from './headers';

/**
 * Writes Cloudflare's `_headers` file into the build (PRD-007 §9): a strict
 * CSP that allows only this origin, the API origin, Turnstile and Google Fonts.
 */
function headersFile(apiBase: string): Plugin {
  return {
    name: 'burnout-headers',
    apply: 'build',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: '_headers', source: securityHeaders(apiBase) });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const apiBase = env.VITE_API_BASE_URL || 'http://localhost:3001';
  return {
    plugins: [react(), tailwindcss(), headersFile(apiBase)],
    server: { port: 3000, strictPort: true },
    build: { target: 'es2022', sourcemap: false },
    test: {
      environment: 'jsdom',
      setupFiles: ['./src/test/setup.ts'],
      include: ['src/**/*.test.{ts,tsx}'],
      css: false,
    },
  };
});
