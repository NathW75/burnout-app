/**
 * Notice emails (PRD-008 §5): one email per user per batch, plain text plus
 * a minimal HTML version. Players as text only (NIL); times in ET, labeled;
 * no tracking; never another manager's picks; links open the app, which asks
 * for sign-in as usual.
 */
const TZ = 'America/New_York';
const timeFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
/** "Thu, Oct 29, 8:15 PM ET" */
export const etTime = (iso: string | Date) => `${timeFmt.format(new Date(iso))} ET`;

export interface QueuedNotice {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  createdAt: Date;
}

export interface PlayerText {
  name: string;
  position: string;
  team: string | null;
}

export interface BurnText {
  slotKey: string | null;
  pointsX100: number | null;
}

export interface Lookup {
  players: ReadonlyMap<string, PlayerText>;
  /** By burn record id. */
  burns: ReadonlyMap<string, BurnText>;
}

export interface Links {
  appBaseUrl: string;
  /** Footer link: the app's confirm page. */
  unsubscribePageUrl: string;
}

interface Section {
  /** Lower sorts first; also picks the subject. */
  priority: number;
  subject: string;
  heading: string;
  lines: string[];
  link: { label: string; path: string } | null;
}

const SLOT: Record<string, string> = { qb: 'QB', rb1: 'RB1', rb2: 'RB2', wr1: 'WR1', wr2: 'WR2', wr3: 'WR3', te: 'TE', flex: 'FLEX', k: 'K' };
const slotLabel = (v: unknown) => (typeof v === 'string' && SLOT[v] ? SLOT[v] : null);
const str = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : null);
const pts = (x100: number | null) => (x100 === null ? null : `${(x100 / 100).toFixed(1)} pts`);

/** "Wes Kay (WR, KC)"; an unknown id reads "a player" rather than leaking a raw id. */
function who(lookup: Lookup, playerId: unknown, fallbackName?: unknown): string {
  const p = typeof playerId === 'string' ? lookup.players.get(playerId) : undefined;
  if (p) return `${p.name} (${[p.position, p.team].filter(Boolean).join(', ')})`;
  return str(fallbackName) ?? 'a player';
}
const shortWho = (lookup: Lookup, playerId: unknown, fallback?: unknown) => who(lookup, playerId, fallback).replace(/ \(.*\)$/, '');

function list(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  if (names.length <= 3) return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  return `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
}

function players(p: Record<string, unknown>): Array<Record<string, unknown>> {
  return Array.isArray(p.players) ? p.players.filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null) : [];
}

export function section(n: QueuedNotice, lookup: Lookup): Section | null {
  const p = n.payload;
  const week = typeof p.week === 'number' ? p.week : null;
  switch (n.kind) {
    case 'SUBMISSION_VOIDED': {
      const slot = slotLabel(p.slot) ?? 'A slot';
      const name = who(lookup, p.playerId, p.playerName);
      const why =
        p.reason === 'PLAYER_INACTIVE' ? `he was listed ${str(p.injuryStatus) ?? 'Out'} before his lock`
        : p.reason === 'PLAYER_NO_GAME' ? 'he has no game this week'
        : p.reason === 'PLAYER_MERGED' ? 'he was listed twice and is already in your lineup'
        : 'his pick was voided';
      return {
        priority: 0,
        subject: `Action needed: your ${slot} is open (${shortWho(lookup, p.playerId, p.playerName)})`,
        heading: `Your ${slot} is open`,
        lines: [`${name} was voided: ${why}. He isn't burned.`, `Pick someone for ${slot} before its window locks.`],
        link: { label: 'Fill the slot', path: '/lineup' },
      };
    }
    case 'SUBMISSION_REPOINTED': {
      const slot = slotLabel(p.slot) ?? 'His slot';
      const at = str(p.newLockAt);
      return {
        priority: 0,
        subject: `Lock time changed: ${shortWho(lookup, p.playerId, p.playerName)}`,
        heading: 'A lock time changed',
        lines: [`${who(lookup, p.playerId, p.playerName)} changed teams or games.`, `${slot} now locks with ${str(p.newWindowLabel) ?? 'his new game'}${at ? `, ${etTime(at)}` : ''}.`],
        link: { label: 'See this week', path: '/' },
      };
    }
    case 'SLOT_REOPENED': {
      const slot = slotLabel(p.slotKey) ?? 'A slot';
      return {
        priority: 0,
        subject: `Your ${slot} is open again`,
        heading: `Your ${slot} is open again`,
        lines: [`The game was canceled, so ${who(lookup, p.playerId)} isn't burned.`, `You can pick someone else for ${slot} if a window is still open.`],
        link: { label: 'Open the lineup', path: '/lineup' },
      };
    }
    case 'BURN': {
      const ps = players(p);
      const names = ps.map((x) => shortWho(lookup, x.playerId));
      const lines = ps.map((x) => {
        const b = typeof x.burnRecordId === 'string' ? lookup.burns.get(x.burnRecordId) : undefined;
        const slot = b?.slotKey ? `${slotLabel(b.slotKey) ?? b.slotKey}: ` : '';
        const score = pts(b?.pointsX100 ?? null);
        return `${slot}${who(lookup, x.playerId)}${score ? `, ${score}` : ''}`;
      });
      return {
        priority: 1,
        subject: names.length ? `Burned: ${list(names)}` : 'Players burned',
        heading: ps.length === 1 ? 'Burned' : `${ps.length} players burned`,
        lines: [`${ps.length === 1 ? 'His game' : 'Their games'} went Final${str(p.burnedAt) ? ` (${etTime(String(p.burnedAt))})` : ''}:`, ...lines, `${ps.length === 1 ? 'He’s' : 'They’re'} gone for the rest of the season.`],
        link: { label: 'Burned roster', path: '/burned' },
      };
    }
    case 'LOCK': {
      const ps = players(p);
      const label = str(p.windowLabel) ?? 'A window';
      const lines = ps.map((x) => `${slotLabel(x.slotKey) ? `${slotLabel(x.slotKey)}: ` : ''}${who(lookup, x.playerId)}`);
      return {
        priority: 2,
        subject: `Locked: ${label.split(' · ')[0]} · ${ps.length} ${ps.length === 1 ? 'player' : 'players'}`,
        heading: `${label} locked`,
        lines: [`Locked${str(p.lockedAt) ? ` ${etTime(String(p.lockedAt))}` : ''}. In your lineup:`, ...lines, `${ps.length === 1 ? 'He burns' : 'They burn'} when the game goes Final.`],
        link: { label: 'See this week', path: '/' },
      };
    }
    case 'LINEUP_RECEIPT': {
      const slots = Array.isArray(p.slots) ? (p.slots as Array<Record<string, unknown>>) : [];
      const lines = slots.filter((s) => s.playerId).map((s) => `${slotLabel(s.slot) ?? String(s.slot)}: ${who(lookup, s.playerId)}`);
      const sha = str(p.sha256);
      return {
        priority: 3,
        subject: week !== null ? `Week ${week} lineup confirmed` : 'Lineup confirmed',
        heading: week !== null ? `Week ${week} lineup confirmed` : 'Lineup confirmed',
        lines: [
          `Confirmed${str(p.gate3At) ? ` ${etTime(String(p.gate3At))}` : ''}.`,
          ...lines,
          ...(sha ? [`Checksum (SHA-256): ${sha}`] : []),
        ],
        link: str(p.receiptId) ? { label: 'View the receipt', path: `/receipts/${p.receiptId}` } : null,
      };
    }
    case 'ENTRY_RECEIPT':
      return generic(4, 'Entry confirmed', 'Your pool entry is confirmed.');
    case 'REFUND':
      return generic(4, 'Refund issued', 'A refund was issued to your payment method.');
    case 'POOL_CANCELLED':
      return generic(4, 'A pool was cancelled', 'A pool you entered was cancelled. Your entry fee is refunded.');
    case 'PAYOUT_SENT':
      return generic(4, 'Payout sent', 'Your winnings are on the way.');
    case 'PAYOUT_FAILED':
      return generic(4, 'Payout failed', 'We couldn’t send your payout. Check your payout account.');
    case 'PAYOUT_BLOCKED':
      return generic(4, 'Payout on hold', 'Your payout is on hold until your account details are complete.');
    default:
      return null;
  }
}

function generic(priority: number, subject: string, line: string): Section {
  return { priority, subject, heading: subject, lines: [line, 'Details are in your inbox.'], link: { label: 'Open your inbox', path: '/inbox' } };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

/** One email for one user's batch. null when none of the notices can be shown. */
export function renderEmail(notices: QueuedNotice[], lookup: Lookup, links: Links): RenderedEmail | null {
  const sections = notices
    .map((n, i) => ({ s: section(n, lookup), i }))
    .filter((x): x is { s: Section; i: number } => x.s !== null)
    .sort((a, b) => a.s.priority - b.s.priority || a.i - b.i)
    .map((x) => x.s);
  if (!sections.length) return null;
  const base = links.appBaseUrl.replace(/\/$/, '');
  const url = (path: string) => `${base}${path}`;
  const extra = sections.length - 1;
  const subject = `${sections[0].subject}${extra ? ` (+${extra} more)` : ''}`.slice(0, 150);
  const manage = url('/account/notifications');

  const text = [
    ...sections.flatMap((s) => [s.heading.toUpperCase(), ...s.lines, ...(s.link ? [`${s.link.label}: ${url(s.link.path)}`] : []), '']),
    '—',
    'Burnout League. Start him. Lose him.',
    `Choose which emails you get: ${manage}`,
    `Unsubscribe from optional emails: ${links.unsubscribePageUrl}`,
  ].join('\n');

  const mono = "'DM Mono',ui-monospace,Menlo,monospace";
  const sans = "'IBM Plex Sans',-apple-system,Segoe UI,Roboto,sans-serif";
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#EDEFEA;">
<div style="max-width:560px;margin:0 auto;padding:24px 16px;font-family:${sans};color:#141414;">
<div style="font-family:${mono};font-size:13px;letter-spacing:1px;margin-bottom:20px;"><span style="color:#C8102E;">///</span> BURNOUT LEAGUE</div>
${sections
  .map(
    (s) => `<div style="background:#F7F8F5;border:1px solid #BFC5C7;border-radius:4px;padding:16px;margin-bottom:12px;">
<div style="font-family:${mono};font-size:15px;font-weight:500;letter-spacing:0.5px;margin-bottom:8px;">${esc(s.heading)}</div>
${s.lines.map((l) => `<div style="font-size:15px;line-height:1.5;">${esc(l)}</div>`).join('\n')}
${s.link ? `<div style="margin-top:14px;"><a href="${esc(url(s.link.path))}" style="display:inline-block;background:#141414;color:#E6FF3D;font-family:${mono};font-size:13px;letter-spacing:1px;text-decoration:none;padding:10px 16px;border-radius:4px;">${esc(s.link.label.toUpperCase())}</a></div>` : ''}
</div>`
  )
  .join('\n')}
<div style="font-size:12px;line-height:1.5;color:#52585B;margin-top:20px;">Burnout League. Start him. Lose him.<br>
<a href="${esc(manage)}" style="color:#52585B;">Choose which emails you get</a> · <a href="${esc(links.unsubscribePageUrl)}" style="color:#52585B;">Unsubscribe from optional emails</a></div>
</div></body></html>`;

  return { subject, text, html };
}
