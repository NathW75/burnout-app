/**
 * @burnout/shared
 * Cross-package constants and utilities. Keep this package dependency-free.
 */

/** Season identifier format used by MySportsFeeds, e.g. '2026-2027-regular'. */
export type SeasonId = string;

/** Server time zone for display. Lock decisions compare absolute instants, never wall-clock strings. */
export const LEAGUE_TIME_ZONE = 'America/New_York';
