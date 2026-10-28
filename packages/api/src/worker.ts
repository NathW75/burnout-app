/**
 * Worker entry point (Railway: `npm -w packages/api run worker`) — PRD-006 §11.
 */
import { createContext } from './app';
import { anthropicClassifier } from './feedback/service';
import { createJobs, dueJobs, msfFetcher } from './jobs';
import { DEFAULT_NOTIFY_CONFIG, type NotifyConfig } from './notify/dispatcher';
import { createRuntime, jsonLog, requireEnv } from './runtime';

async function main() {
  const rt = await createRuntime();
  const season = process.env.CURRENT_SEASON ?? '2026-2027-regular';
  const apiContext = createContext({
    db: rt.db, redis: rt.redis, payments: rt.payments, mailer: rt.mailer,
    totpEncryptionKey: requireEnv('TOTP_ENCRYPTION_KEY'), log: jsonLog, config: { currentSeason: season },
  });
  // Feedback tagging is optional: without a key, feedback is stored untagged (PRD-007 §10).
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const classifier = anthropicKey ? anthropicClassifier(anthropicKey, process.env.FEEDBACK_MODEL || 'claude-haiku-5-5') : undefined;
  if (!classifier) jsonLog('warn', 'ANTHROPIC_API_KEY not set: feedback is stored untagged');
  // Email delivery (PRD-008): off unless NOTIFY_EMAIL=on. The grouping window is a setting (§12.1).
  const notify: NotifyConfig | undefined =
    process.env.NOTIFY_EMAIL === 'on'
      ? {
          ...DEFAULT_NOTIFY_CONFIG,
          groupSeconds: Number(process.env.NOTIFY_GROUP_SECONDS ?? DEFAULT_NOTIFY_CONFIG.groupSeconds),
          apiBaseUrl: process.env.API_PUBLIC_URL ?? DEFAULT_NOTIFY_CONFIG.apiBaseUrl,
        }
      : undefined;
  if (!notify) jsonLog('warn', 'NOTIFY_EMAIL is not on: notices stay in the in-app inbox only');
  if (notify && !process.env.SENDGRID_API_KEY) jsonLog('warn', 'NOTIFY_EMAIL is on but SENDGRID_API_KEY is not set: notice emails are only recorded in memory');
  const jobs = createJobs({
    db: rt.db, redis: rt.redis, payments: rt.payments, season, now: () => new Date(), log: jsonLog, apiContext, classifier, notify,
    msf: msfFetcher(process.env.MSF_BASE_URL ?? 'https://api.mysportsfeeds.com/v2.1/pull/nfl', requireEnv('MSF_API_KEY')),
  });

  // The schedule first, so a fresh database has windows before the first lock check (§11.6).
  await jobs.run('schedule');
  // Then the rosters, so player identity (§7.5) is current after every deploy, not only at the nightly sync.
  await jobs.run('roster');

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
  if (classifier) {
    let tagging = false;
    setInterval(() => {
      if (tagging) return;
      tagging = true;
      void jobs.run('feedback').finally(() => { tagging = false; });
    }, 15_000);
  }
  if (notify) {
    let sending = false;
    setInterval(() => {
      if (sending) return;
      sending = true;
      void jobs.run('notify').finally(() => { sending = false; });
    }, 30_000);
  }
  jsonLog('info', 'worker started', { season, firstTickInMs: startIn, feedbackTagging: !!classifier, notifyEmail: !!notify, notifyGroupSeconds: notify?.groupSeconds ?? null });
}

main().catch((err) => {
  jsonLog('error', 'worker failed to start', { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
