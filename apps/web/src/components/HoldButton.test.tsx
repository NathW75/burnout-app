import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HOLD_MS, HoldButton } from './HoldButton';

/** A hand-cranked clock and animation frames. */
let t = 0;
let frames: Array<FrameRequestCallback> = [];
const advance = (ms: number) => {
  const end = t + ms;
  while (t < end) {
    t = Math.min(end, t + 16);
    const run = frames;
    frames = [];
    act(() => run.forEach((f) => f(t)));
  }
};

beforeEach(() => {
  t = 0;
  frames = [];
  vi.stubGlobal('requestAnimationFrame', (f: FrameRequestCallback) => (frames.push(f), frames.length));
  vi.stubGlobal('cancelAnimationFrame', () => { frames = []; });
});
afterEach(() => vi.unstubAllGlobals());

const setup = () => {
  const onComplete = vi.fn();
  render(<HoldButton label="Hold to confirm" onComplete={onComplete} now={() => t} />);
  const btn = screen.getByRole('button', { name: 'Hold to confirm' });
  const fill = () => Number((screen.getByTestId('hold-fill') as HTMLElement).style.opacity);
  const offset = () => Number(screen.getByTestId('hold-ring').getAttribute('stroke-dashoffset'));
  return { onComplete, btn, fill, offset };
};

describe('Gate 3 press and hold (PRD-007 §7)', () => {
  it('holding 1.5 s fills the ring and the red center together, then confirms once', () => {
    const { onComplete, btn, fill, offset } = setup();
    expect(fill()).toBe(0);
    fireEvent.pointerDown(btn, { button: 0, pointerId: 1 });
    advance(HOLD_MS / 2);
    expect(fill()).toBeGreaterThan(0.4);
    expect(fill()).toBeLessThan(0.6);
    expect(offset()).toBeCloseTo(439.8 * (1 - fill()), 1); // ring and fill move in step
    expect(btn).toHaveTextContent('KEEP HOLDING');
    expect(onComplete).not.toHaveBeenCalled();
    advance(HOLD_MS);
    expect(fill()).toBe(1);
    expect(offset()).toBe(0);
    expect(onComplete).toHaveBeenCalledTimes(1);
    fireEvent.pointerUp(btn);
    fireEvent.pointerDown(btn, { button: 0, pointerId: 1 });
    advance(HOLD_MS * 2);
    expect(onComplete).toHaveBeenCalledTimes(1); // never twice
  });

  it('letting go early cancels and resets both the ring and the fill', () => {
    const { onComplete, btn, fill, offset } = setup();
    fireEvent.pointerDown(btn, { button: 0, pointerId: 1 });
    advance(HOLD_MS - 200);
    fireEvent.pointerUp(btn);
    expect(fill()).toBe(0);
    expect(offset()).toBeCloseTo(439.8, 1);
    advance(HOLD_MS);
    expect(onComplete).not.toHaveBeenCalled();
    expect(btn).toHaveTextContent('HOLD TO LOCK IN');
  });

  it('keyboard: holding Space or Enter works; key repeat does not restart; releasing cancels', () => {
    const { onComplete, btn, fill } = setup();
    // A held key repeats keydown; the hold keeps counting from the first press.
    fireEvent.keyDown(btn, { key: ' ' });
    for (let i = 0; i < 6; i++) {
      advance(100);
      fireEvent.keyDown(btn, { key: ' ', repeat: true });
    }
    expect(fill()).toBeGreaterThan(0.35);
    advance(600);
    fireEvent.keyUp(btn, { key: ' ' });
    expect(fill()).toBe(0);
    expect(onComplete).not.toHaveBeenCalled();
    fireEvent.keyDown(btn, { key: 'Enter' });
    advance(HOLD_MS + 50);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('a plain click or tap does nothing', () => {
    const { onComplete, btn } = setup();
    fireEvent.click(btn);
    advance(HOLD_MS * 2);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('reduced motion: the ring and fill step in quarters', () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('reduce'), addEventListener() {}, removeEventListener() {} }));
    const { btn, fill } = setup();
    fireEvent.pointerDown(btn, { button: 0, pointerId: 1 });
    advance(HOLD_MS * 0.6);
    expect(fill()).toBe(0.5);
  });
});
