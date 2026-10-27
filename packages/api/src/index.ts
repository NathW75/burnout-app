/**
 * API server entry point (Railway: `npm -w packages/api start`).
 */
import { createApp } from './app';
import { createRuntime, jsonLog, requireEnv } from './runtime';

async function main() {
  const rt = await createRuntime();
  const { app } = createApp({
    db: rt.db,
    redis: rt.redis,
    payments: rt.payments,
    mailer: rt.mailer,
    totpEncryptionKey: requireEnv('TOTP_ENCRYPTION_KEY'),
    log: jsonLog,
    config: {
      cookieSecure: process.env.SESSION_COOKIE_SECURE !== 'false',
      corsOrigins: (process.env.CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
      appBaseUrl: process.env.APP_BASE_URL ?? 'https://burnoutfantasy.com',
      currentSeason: process.env.CURRENT_SEASON ?? '2026-2027-regular',
    },
  });
  const port = Number(process.env.PORT ?? 3000);
  const server = app.listen(port, () => jsonLog('info', 'api listening', { port }));
  const shutdown = () => {
    server.close(() => {
      void rt.pool.end();
      rt.redis?.disconnect();
      process.exit(0);
    });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  jsonLog('error', 'api failed to start', { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
