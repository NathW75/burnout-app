/**
 * Production wiring shared by the server and the worker. All secrets come
 * from env (Railway variables only — never committed).
 */
import Redis from 'ioredis';
import { Pool } from 'pg';
import { createPaymentsService, FakeProcessor } from '@burnout/payments';
import type { Log } from './context';
import { MemoryMailer, SendGridMailer, type Mailer } from './mailer';
import { pgDatabase } from './sql';

export const jsonLog: Log = (level, message, meta) => {
  const line = JSON.stringify({ t: new Date().toISOString(), level, message, ...(meta ?? {}) });
  if (level === 'error') console.error(line);
  else console.log(line);
};

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable ${name}`);
  return v;
}

export async function createRuntime() {
  const pool = new Pool({ connectionString: requireEnv('DATABASE_URL'), max: Number(process.env.PG_POOL_MAX ?? 10) });
  pool.on('error', (err) => jsonLog('error', 'postgres pool error', { error: err.message }));
  const db = pgDatabase(pool);
  const redis = process.env.REDIS_URL ? new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 2 }) : undefined;
  redis?.on('error', (err) => jsonLog('warn', 'redis error', { error: err.message }));

  // No live adapter exists until a processor approves the use case in writing (PRD-004 §7.3).
  const payments = await createPaymentsService({ db, processor: new FakeProcessor(requireEnv('PAYMENT_WEBHOOK_SECRET')), log: jsonLog });

  const mailer: Mailer = process.env.SENDGRID_API_KEY
    ? new SendGridMailer(process.env.SENDGRID_API_KEY, requireEnv('MAIL_FROM'), process.env.NOTIFY_FROM || 'Burnout League <alerts@burnoutfantasy.com>')
    : new MemoryMailer();
  if (!process.env.SENDGRID_API_KEY) jsonLog('warn', 'SENDGRID_API_KEY not set: verification and reset emails are not delivered');

  return { pool, db, redis, payments, mailer };
}
