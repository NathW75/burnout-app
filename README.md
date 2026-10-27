# Burnout League

Fantasy football with a mechanic you won't find anywhere else.

## Monorepo Structure

```
burnout/
├── apps/
│   ├── web/          React.js frontend (burnoutfantasy.com)
│   └── mobile/       Expo React Native (iOS + Android)
├── packages/
│   ├── api/          Node.js/Express backend (Railway)
│   ├── burn-engine/  Core burn mechanic (PRD-001)
│   ├── scoring-engine/ Fantasy scoring, MSF ingestion, corrections (PRD-002)
│   ├── leaderboard/  Pool rankings, projected movement, reveal, handles (PRD-003)
│   ├── test-support/ Test-only Postgres + Redis harness (never imported at runtime)
│   ├── db/           Prisma schema + migrations (PostgreSQL)
│   └── shared/       Types, constants, utilities
├── docs/
│   └── prd/          Product Requirements Documents
│       └── PRD-001-burn-engine.md   ← START HERE
└── infrastructure/   Railway config, deployment scripts
```

## Getting Started

```bash
# 1. Copy env file and fill in values
cp .env.example .env

# 2. Install dependencies
npm install

# 3. Generate Prisma client
npm run db:generate

# 4. Run migrations (requires DATABASE_URL in .env)
npm run db:migrate

# 5. Start API in dev mode
npm run dev:api

# 6. Start web in dev mode
npm run dev:web
```

## Testing

```bash
npm run typecheck
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres \
TEST_REDIS_URL=redis://localhost:6379 npm test
```

`TEST_DATABASE_URL` points at any Postgres 16 server; the suite only uses it to
create and drop throwaway databases. Each integration suite gets its own
database cloned from a template built from the real files in
`packages/db/prisma/migrations`. Without `TEST_DATABASE_URL`, the PRD-001 §11
acceptance suite is skipped and only unit tests run. CI (`.github/workflows/ci.yml`)
always runs it against a Postgres service container.

## Burn engine guarantees (PRD-001)

Enforced twice, in the application and in the database:

| Guarantee | Application | Database |
|---|---|---|
| Lock at `scheduled_et`, never actual kickoff | `lock-engine.ts`, claim re-checks `scheduled_et` | — |
| Burn only on lock AND Final | `burn-evaluator.ts` (every game in the window Final) | `burn_records` INSERT trigger |
| `burn_records` write-once | `createDbClient()` rejects update/delete/upsert | UPDATE/DELETE/TRUNCATE trigger; SLOT_REOPENED audit row required to override |
| Weekly contests never burn | engine never reads `weekly_submissions` | `burn_records.submission_id` → `season_submissions` only |
| Lock notification in lock transaction | `notification_queue` outbox row written in the lock tx | — |
| Concurrent workers fire once | conditional state-claim UPDATE per window | row lock on `game_windows` |

Always build the Prisma client with `createDbClient()` from `@burnout/db`.

## Environment Variables

See `.env.example` for all required variables.

**NEVER commit `.env`** — MSF API key and Stripe keys go in Railway dashboard env vars only.

## PRDs

All implementation is spec-driven. PRDs live in `docs/prd/`. Each component has
a corresponding PRD that is the authoritative source of truth. Read the PRD
before implementing any feature.

| PRD | Component | Status |
|-----|-----------|--------|
| PRD-001 | Burn Engine | APPROVED |
| PRD-002 | Scoring Engine | APPROVED |
| PRD-003 | Leaderboard | APPROVED |
| PRD-004 | Payment Processing (Stripe) | TODO |
| PRD-005 | Pri/Alt Insurance (P2) | TODO |

## Stack

- **Frontend**: React.js + Vite + TailwindCSS
- **Mobile**: Expo (React Native) + EAS for builds
- **API**: Node.js + Express + TypeScript
- **Database**: PostgreSQL (Railway managed)
- **Cache/Queue**: Redis (Railway) + Bull
- **ORM**: Prisma
- **Payments**: Stripe (web checkout primary; IAP supplement only)
- **Sports Data**: MySportsFeeds v2.1
- **Deploy**: Railway (Hobby tier → Pro at scale)
- **Domain**: burnoutfantasy.com (Cloudflare)
- **Notifications**: Expo Push + SendGrid

## Legal

Engage gaming attorney before first paid contest. See project docs for
DFS classification analysis and T&C framework.
