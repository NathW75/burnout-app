/**
 * Jest global setup: builds a template database from the real Prisma migration
 * files so every integration suite starts from exactly the schema that ships.
 *
 * Integration suites need TEST_DATABASE_URL pointing at a Postgres server
 * (any database on it; it is only used to create and drop test databases),
 * e.g. postgresql://postgres@127.0.0.1:5432/postgres
 * Without it, integration suites are skipped and only unit suites run.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';

export const TEMPLATE_DB = 'burnout_test_template';
const MIGRATIONS_DIR = join(__dirname, '../../db/prisma/migrations');

export default async function globalSetup(): Promise<void> {
  const adminUrl = process.env.TEST_DATABASE_URL;
  if (!adminUrl) {
    console.warn(
      '\n[tests] TEST_DATABASE_URL is not set: Postgres integration suites (PRD acceptance) are SKIPPED.\n'
    );
    return;
  }

  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${TEMPLATE_DB} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${TEMPLATE_DB}`);
  } finally {
    await admin.end();
  }

  const url = new URL(adminUrl);
  url.pathname = `/${TEMPLATE_DB}`;
  const tpl = new Client({ connectionString: url.toString() });
  await tpl.connect();
  try {
    const migrations = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    for (const name of migrations) {
      await tpl.query(readFileSync(join(MIGRATIONS_DIR, name, 'migration.sql'), 'utf8'));
    }
  } finally {
    await tpl.end();
  }
}
