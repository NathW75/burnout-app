/**
 * End-to-end tests (PRD-007 §12) against the real API with Postgres and
 * Redis. Needs E2E_DATABASE_URL and E2E_REDIS_URL (CI sets them from its
 * service containers).
 */
import { defineConfig, devices } from '@playwright/test';

const API = 'http://localhost:3001';
const WEB = 'http://localhost:4173';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1, // one shared database, and the stale-lock test moves a window
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  timeout: 60_000,
  use: {
    baseURL: WEB,
    trace: 'retain-on-failure',
    ...devices['Pixel 7'], // 412px wide, touch: the phone the PRD designs for
  },
  projects: [{ name: 'chromium-mobile', use: { browserName: 'chromium' } }],
  webServer: [
    {
      command: 'tsx --tsconfig e2e/tsconfig.json e2e/api-server.cts',
      url: `${API}/healthz`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: { E2E_WEB_ORIGIN: WEB },
      stdout: 'pipe',
    },
    {
      command: 'vite build --mode e2e && vite preview --port 4173 --strictPort',
      url: WEB,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: { VITE_API_BASE_URL: API, VITE_TURNSTILE_SITE_KEY: '' },
    },
  ],
});
