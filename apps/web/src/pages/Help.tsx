/** The rules in plain language (PRD-007 §6.8). */
import { useEffect, type ReactNode } from 'react';
import { useLocation } from 'react-router';
import { SectionTitle, TabPage, useScreen } from '../components/layout';

function Rule({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="flex scroll-mt-20 flex-col gap-2 px-4 pt-6">
      <SectionTitle>{title}</SectionTitle>
      <div className="flex flex-col gap-2 text-[15px] leading-[1.55] text-type [&_p]:m-0">{children}</div>
    </section>
  );
}

export function HelpPage() {
  useScreen('help', 'The rules');
  const { hash } = useLocation();
  useEffect(() => {
    if (hash) document.getElementById(hash.slice(1))?.scrollIntoView();
  }, [hash]);
  return (
    <TabPage>
      <section className="flex flex-col gap-2 px-4 pt-[22px]">
        <h1 className="m-0 font-mono text-[40px] leading-none font-medium tracking-[-1px]">The rules</h1>
        <p className="m-0 text-[14px] text-muted">Short version: start him, lose him.</p>
      </section>
      <Rule id="burn" title="THE BURN">
        <p>A player is <b>burned</b> when both of these are true: he was in your lineup when his game window locked, and his game went Final. Lock alone doesn’t burn him. Final alone doesn’t either.</p>
        <p>A burned player is gone from your pool for the rest of the season. No undo, win or lose.</p>
      </Rule>
      <Rule id="lock" title="LOCKS">
        <p>Each slot locks at its game’s <b>scheduled</b> kickoff, the time the NFL published, not when the ball is actually kicked. The official clock at the top of the screen is Burnout League time from our server; your device’s clock doesn’t count.</p>
        <p>Games that kick off at the same time share a window. A locked slot can’t change.</p>
      </Rule>
      <Rule id="slots" title="NINE SLOTS">
        <p>QB, RB1, RB2, WR1, WR2, WR3, TE, FLEX and K. A fullback (FB) can play RB or FLEX. FLEX takes an RB, FB, WR or TE.</p>
        <p>An <b>empty slot</b> scores 0 and burns nothing. To confirm a lineup, though, every slot that hasn’t locked needs a player; a slot ends up empty only when a pick is voided after you confirmed.</p>
      </Rule>
      <Rule id="out" title="OUT, IR AND MOVES">
        <p>Players listed Out or on IR can’t be picked. If your pick is listed Out or IR before his lock, the pick is voided: he isn’t burned and the slot opens again.</p>
        <p>If a player changes teams during the week, your pick follows him to his new game and locks with it. If he has no game, the pick is voided.</p>
      </Rule>
      <Rule id="disruptions" title="CANCELED OR POSTPONED GAMES">
        <p>A canceled game’s picks are voided and nobody is burned. If a game is postponed after it locked, Burnout League follows the published disruption rules; you’ll get a notice about any slot that reopens.</p>
      </Rule>
      <Rule id="free-play" title="FREE PLAY">
        <p>Free play is for trying the game: Weeks 1 and 2, no prizes. Free play and late paid entry both close at the Week 3 lock. A late entrant’s prize standings count from the week they joined.</p>
      </Rule>
      <Rule id="gates" title="CONFIRMING A LINEUP">
        <p>Every lineup goes through three steps: review it, tick the three acknowledgments, then press and hold to confirm. Our server timestamps each step, and you get a receipt.</p>
        <p id="terms">The acknowledgments summarize the Terms. The Terms are the final word.</p>
      </Rule>
      <Rule id="checksum" title="RECOMPUTING A RECEIPT CHECKSUM">
        <p>Each receipt has a SHA-256 checksum of exactly what you confirmed. To check it yourself, build this JSON with no spaces, keys in this order, and hash it:</p>
        <pre className="m-0 overflow-x-auto rounded-sm border border-rule bg-paper p-3 font-mono text-[12px] leading-[1.5] whitespace-pre-wrap">
{`{"userId":"<your account id>","season":"<season>","week":<week>,
 "gate3At":"<Gate 3 time, ISO 8601 UTC>",
 "slots":[{"slot":"qb","playerId":"<id or null>","gameWindowId":"<id or null>","locked":<true|false>}, …]}`}
        </pre>
        <p>Slots go in the order qb, rb1, rb2, wr1, wr2, wr3, te, flex, k, with the values shown on the receipt. The hash, written in lowercase hex, matches the receipt’s checksum.</p>
      </Rule>
    </TabPage>
  );
}
