/**
 * Gate 3 press-and-hold (PRD-007 §7): hold 1.5 s while a lime ring fills and
 * the center fills red from 0 to 100% opacity in step with it. Releasing
 * early cancels and resets both. Keyboard: hold Space or Enter. With reduced
 * motion the ring and fill move in quarter steps instead of animating.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { FlameIcon } from './icons';

export const HOLD_MS = 1500;
const CIRCUMFERENCE = 439.8; // 2π × 70

interface Props {
  label: string;
  onComplete: () => void;
  busy?: boolean;
  /** For tests. */
  now?: () => number;
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

export function HoldButton({ label, onComplete, busy = false, now = () => performance.now() }: Props) {
  const [progress, setProgress] = useState(0);
  const startedAt = useRef<number | null>(null);
  const frame = useRef<number | null>(null);
  const fired = useRef(false);
  const reduced = useRef(prefersReducedMotion());

  const stop = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    startedAt.current = null;
  }, []);

  useEffect(() => stop, [stop]);

  const tick = useCallback(() => {
    if (startedAt.current === null) return;
    const raw = Math.min(1, (now() - startedAt.current) / HOLD_MS);
    const p = reduced.current && raw < 1 ? Math.floor(raw * 4) / 4 : raw;
    setProgress(p);
    if (raw >= 1) {
      stop();
      if (!fired.current) {
        fired.current = true;
        onComplete();
      }
      return;
    }
    frame.current = requestAnimationFrame(tick);
  }, [now, onComplete, stop]);

  const begin = () => {
    if (busy || fired.current || startedAt.current !== null) return;
    startedAt.current = now();
    frame.current = requestAnimationFrame(tick);
  };
  const cancel = () => {
    if (fired.current) return;
    stop();
    setProgress(0);
  };

  const hot = progress > 0.5;
  const text = busy || fired.current ? 'LOCKING IN…' : progress > 0 ? 'KEEP HOLDING' : 'HOLD TO LOCK IN';
  return (
    <button
      type="button"
      aria-label={label}
      aria-describedby="hold-hint"
      aria-disabled={busy || fired.current || undefined}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture?.(e.pointerId);
        begin();
      }}
      onPointerUp={cancel}
      onPointerCancel={cancel}
      onLostPointerCapture={cancel}
      onKeyDown={(e) => {
        if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
          e.preventDefault();
          begin();
        }
      }}
      onKeyUp={(e) => {
        if (e.key === ' ' || e.key === 'Enter') cancel();
      }}
      onBlur={cancel}
      onContextMenu={(e) => e.preventDefault()}
      onClick={(e) => e.preventDefault()}
      className="relative size-[200px] cursor-pointer touch-none rounded-full border-0 bg-paper p-0 select-none"
      style={{ color: hot ? 'var(--hold-hot-fg)' : 'var(--color-type)', WebkitTouchCallout: 'none' }}
    >
      <span aria-hidden="true" data-testid="hold-fill" className="absolute inset-[19px] rounded-full bg-pencil" style={{ opacity: progress }} />
      <svg aria-hidden="true" width="200" height="200" viewBox="0 0 160 160" className="absolute inset-0 -rotate-90">
        <circle cx="80" cy="80" r="70" fill="none" stroke="var(--color-rule)" strokeWidth="10" />
        <circle data-testid="hold-ring" cx="80" cy="80" r="70" fill="none" stroke="var(--color-accent)" strokeWidth="10" strokeDasharray={CIRCUMFERENCE} strokeDashoffset={CIRCUMFERENCE * (1 - progress)} />
      </svg>
      <span className="relative flex flex-col items-center gap-[6px]">
        <FlameIcon width={30} height={30} stroke={hot ? 'var(--hold-hot-fg)' : 'var(--color-accent)'} />
        <span className="font-mono text-[14px] font-medium tracking-[1px]">{text}</span>
      </span>
    </button>
  );
}
