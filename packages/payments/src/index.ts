/**
 * @burnout/payments — PRD-004
 *
 * Owns: prize tables, entry checkout and capture, the double-entry ledger,
 * entry close (overlay / cancellation), settlement from the official final
 * snapshot, payouts, refunds, disputes, identity and jurisdiction gates, and
 * the processor adapter (FakeProcessor only until written approval).
 * Does not own: points (PRD-002) or ranks (PRD-003).
 */
export * from './sql';
export * from './context';
export * from './prize-table';
export * from './awards';
export * from './ledger';
export * from './processor';
export * from './pools';
export * from './checkout';
export * from './refunds';
export * from './events';
export * from './settlement';
export * from './payouts';
export * from './integrity';
export * from './service';
