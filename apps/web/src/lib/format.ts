/**
 * Every kickoff and lock is shown in Eastern Time and labeled "ET"
 * (PRD-007 §5.2), whatever the device's own time zone.
 */
const TZ = 'America/New_York';

const fmt = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-US', { timeZone: TZ, ...opts });
const timeFmt = fmt({ hour: 'numeric', minute: '2-digit' });
const clockFmt = fmt({ hour: 'numeric', minute: '2-digit', second: '2-digit' });
const dayFmt = fmt({ weekday: 'short' });
const dateLineFmt = fmt({ weekday: 'short', month: 'short', day: 'numeric' });
const fullFmt = fmt({ weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' });

const d = (x: Date | string | number) => (x instanceof Date ? x : new Date(x));

/** "1:00 PM" */
export const timeET = (x: Date | string | number) => timeFmt.format(d(x));
/** "11:42:07 AM ET" */
export const clockET = (x: Date | string | number) => `${clockFmt.format(d(x))} ET`;
/** "Sun" */
export const dayET = (x: Date | string | number) => dayFmt.format(d(x));
/** "Sun 1:00 PM" */
export const dayTimeET = (x: Date | string | number) => `${dayET(x)} ${timeET(x)}`;
/** "SUN · NOV 1" */
export const dateLineET = (x: Date | string | number) => dateLineFmt.format(d(x)).replace(',', ' ·').toUpperCase();
/** "Sun, Nov 1, 1:00:07 PM ET" */
export const fullET = (x: Date | string | number) => `${fullFmt.format(d(x))} ET`;

/**
 * A countdown: "1:17:53" under a day, "MON" (the lock's weekday) beyond.
 * Never negative: zero means the server should be asked (PRD-007 §5.4).
 */
export function countdown(msLeft: number, target: Date | string): string {
  if (msLeft >= 24 * 3600_000) return dayET(target).toUpperCase();
  const s = Math.max(0, Math.floor(msLeft / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(h ? 2 : 1, '0');
  return h ? `${h}:${mm}:${String(sec).padStart(2, '0')}` : `${mm}:${String(sec).padStart(2, '0')}`;
}

/** Centipoints to "18.4"; one decimal, as the app shows points. */
export const points = (x100: number) => (x100 / 100).toFixed(1);
/** Exact, as the engine scores (hundredths): for breakdowns, where lines must visibly add up. */
export const pointsExact = (x100: number) => (x100 / 100).toFixed(2);
/** Signed and exact: +5.40, −2.00 (a real minus sign). */
export const pointsSigned = (x100: number) => `${x100 < 0 ? '−' : '+'}${(Math.abs(x100) / 100).toFixed(2)}`;

/** "C. Ellery" from "Cole Ellery": compact names for tight rows. */
export function shortName(name: string | null): string {
  if (!name) return '';
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2) return name;
  return `${parts[0][0]}. ${parts.slice(1).join(' ')}`;
}
