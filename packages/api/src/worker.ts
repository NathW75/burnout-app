/**
 * Worker entry point (Railway: `npm -w packages/api run worker`) — PRD-006 §11.
 */
import { createContext } from './app';
import { createJobs, dueJobs, msfFetcher } from './jobs';
import { createRuntime, jsonLog, requireEnv } from './runtime';

async function main() {
  const rt = await createRuntime();
  const season = process.env.CURRENT_SEASON ?? '2026-2027-regular';
  const apiContext = createContext({
    db: rt.db, redis: rt.redis, payments: rt.payments, mailer: rt.mailer,
    totpEncryptionKey: requireEnv('TOTP_ENCRYPTION_KEY'), log: jsonLog, config: { currentSeason: season },
  });
  const jobs = createJobs({
    db: rt.db, redis: rt.redis, payments: rt.payments, season, now: () => new Date(), log: jsonLog, apiContext,
    msf: msfFetcher(process.env.MSF_BASE_URL ?? 'https://api.mysportsfeeds.com/v2.1/pull/nfl', requireEnv('MSF_API_KEY')),
  });

  let running = false;
  const tick = async () => {
    if (running) return; // a slow tick never overlaps the next
    running = true;
    try {
      const now = new Date();
      const windowsActive = (await jobs.activeWeeks()).length > 0;
      for (const job of dueJobs(now, { windowsActive })) await jobs.run(job);
    } finally {
      running = false;
    }
  };
  // Align to the top of each minute: locks fire within a minute of scheduled_et (PRD-001 §4.4).
  const startIn = 60_000 - (Date.now() % 60_000);
  setTimeout(() => {
    void tick();
    setInterval(() => void tick(), 60_000);
  }, startIn);
  jsonLog('info', 'worker started', { season, firstTickInMs: startIn });
}

main().catch((err) => {
  jsonLog('error', 'worker failed to start', { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
