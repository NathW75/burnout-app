/**
 * @burnout/burn-engine
 *
 * Core burn mechanic engine. Implements PRD-001.
 *
 * This package owns:
 * - Lock evaluation (fires at scheduled_et per game window)
 * - Burn criterion evaluation (lock + Final = burned)
 * - Pool entry state management
 * - Game disruption handling (cancellation → slot reopen)
 * - Lineup draft validation ahead of the three-gate confirmation flow
 *
 * This package does NOT own:
 * - HTTP transport (lives in @burnout/api)
 * - Push notification delivery (lives in @burnout/api/notifications; it drains notification_queue)
 * - Scoring calculation (PRD-002)
 * - Payment processing (PRD-004)
 */

export * from './types';
export * from './sql';
export * from './lock-engine';
export * from './burn-evaluator';
export * from './pool-manager';
export * from './disruption-handler';
export * from './submission-validator';
export * from './adapters/postgres-store';
export * from './adapters/prisma';
