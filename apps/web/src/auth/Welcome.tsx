/** First run (PRD-007 §6.1): three cards, then This Week. */
import { useState } from 'react';
import { Link } from 'react-router';
import { FlameIcon } from '../components/icons';
import { useScreen } from '../components/layout';
import { AuthLayout } from './AuthLayout';

const CARDS = [
  {
    title: 'Start him. Lose him.',
    body: 'A player in your lineup when his game window locks is burned once his game goes Final, win or lose. He’s gone from your pool for the rest of the season.',
  },
  {
    title: 'Locks at the scheduled kickoff.',
    body: 'Each slot locks at its game’s scheduled kickoff, not the actual kickoff. All times are Eastern, from the official clock at the top of the screen.',
  },
  {
    title: 'Nine slots, one season.',
    body: 'QB, RB1, RB2, WR1, WR2, WR3, TE, FLEX and K. An empty slot scores 0 and burns nothing. Out or IR players can’t be picked and are never burned.',
  },
];

export function WelcomePage() {
  useScreen('welcome', 'Welcome');
  const [i, setI] = useState(0);
  const card = CARDS[i];
  const last = i === CARDS.length - 1;
  return (
    <AuthLayout title="You’re in." intro="Three things to know before your first lineup.">
      <section aria-live="polite" className="flex flex-col gap-3 rounded-sm border border-rule bg-paper p-5">
        <FlameIcon className="text-mark" />
        <span className="font-mono text-[11px] tracking-[1px] text-muted">{String(i + 1).padStart(2, '0')} / 03</span>
        <h2 className="m-0 font-mono text-[22px] leading-[1.15] font-medium">{card.title}</h2>
        <p className="m-0 text-[15px] leading-[1.55] text-muted">{card.body}</p>
      </section>
      {last ? (
        <Link to="/" className="btn-primary">TO THIS WEEK</Link>
      ) : (
        <button type="button" className="btn-primary" onClick={() => setI(i + 1)}>NEXT</button>
      )}
      {!last && <Link to="/" className="self-center text-[14px]">Skip</Link>}
    </AuthLayout>
  );
}
