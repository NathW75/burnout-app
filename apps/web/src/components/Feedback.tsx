/**
 * Feedback button (PRD-007 §10, SPEC-feedback-system): on every signed-in
 * screen, bottom right, kept clear of the bottom nav and sticky footers.
 * One text box; the screen goes along in X-Current-Screen, set by the API
 * client from the page underneath.
 */
import { useMutation } from '@tanstack/react-query';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router';
import { api } from '../api/client';
import { errorText } from '../lib/errors';

export const FEEDBACK_MAX = 2000;

/** Height of whatever bar is pinned to the bottom of the screen (nav, lineup footer, gate footer). */
function useBottomBarHeight(): number {
  const { pathname } = useLocation();
  const [h, setH] = useState(0);
  useLayoutEffect(() => {
    const measure = () => {
      const bars = [...document.querySelectorAll<HTMLElement>('[data-bottom-bar]')];
      // Bars stack (a lineup or gate footer sits on the tabs): clear the topmost one.
      const tops = bars.map((el) => el.getBoundingClientRect().top).filter((t) => t > 0 && t < window.innerHeight);
      setH(tops.length ? Math.max(0, window.innerHeight - Math.min(...tops)) : bars.reduce((max, el) => Math.max(max, el.getBoundingClientRect().height), 0));
    };
    measure();
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    document.querySelectorAll('[data-bottom-bar]').forEach((el) => ro?.observe(el));
    const mo = new MutationObserver(() => {
      measure();
      document.querySelectorAll('[data-bottom-bar]').forEach((el) => ro?.observe(el));
    });
    mo.observe(document.body, { childList: true, subtree: true });
    return () => {
      ro?.disconnect();
      mo.disconnect();
    };
  }, [pathname]);
  return h;
}

export function FeedbackButton() {
  const [open, setOpen] = useState(false);
  const bar = useBottomBarHeight();
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Send feedback"
        aria-haspopup="dialog"
        className="fixed right-4 z-20 flex size-12 items-center justify-center rounded-full border border-frame bg-chrome text-type hover:text-accent"
        style={{ bottom: `calc(${Math.round(bar)}px + 12px + ${bar ? '0px' : 'env(safe-area-inset-bottom)'})` }}
      >
        <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 5h16v11H9l-5 4z" />
          <path d="M8 9.5h8M8 12.5h5" />
        </svg>
      </button>
      {open && <FeedbackSheet onClose={() => setOpen(false)} />}
    </>
  );
}

export function FeedbackSheet({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [body, setBody] = useState('');
  const send = useMutation({ mutationFn: () => api<{ id: string }>('/feedback', { body: { body: body.trim() } }) });
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) {
      if (typeof d.showModal === 'function') d.showModal();
      else d.setAttribute('open', '');
    }
  }, []);
  useEffect(() => {
    if (!send.isSuccess) return;
    const t = window.setTimeout(onClose, 1600);
    return () => window.clearTimeout(t);
  }, [send.isSuccess, onClose]);
  const trimmed = body.trim().length;
  return (
    <dialog
      ref={ref}
      aria-labelledby="feedback-title"
      onClose={onClose}
      onCancel={onClose}
      onClick={(e) => e.target === ref.current && onClose()}
      className="m-0 mt-auto w-full max-w-none border-0 bg-transparent p-0 text-type backdrop:bg-black/60 md:mr-0 md:ml-auto md:h-full md:max-h-none md:w-[420px]"
    >
      <div className="flex flex-col gap-3 rounded-t-sm border-t border-accent bg-newsprint p-4 pb-[max(16px,env(safe-area-inset-bottom))] md:h-full md:rounded-none md:border-t-0 md:border-l">
        <div className="flex items-center justify-between">
          <h2 id="feedback-title" className="m-0 font-mono text-[15px] font-medium tracking-[1px]"><span className="text-mark">///</span> FEEDBACK</h2>
          <button type="button" onClick={onClose} className="-mr-2 flex size-11 items-center justify-center text-muted hover:text-type" aria-label="Close">
            <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
          </button>
        </div>
        {send.isSuccess ? (
          <p role="status" className="m-0 py-6 text-center text-[15px]">Sent. Thanks, we read every one.</p>
        ) : (
          <form onSubmit={(e) => (e.preventDefault(), send.mutate())} className="flex flex-col gap-3" noValidate>
            <label htmlFor="feedback-body" className="text-[14px] leading-[1.45] text-muted">
              A bug, something confusing, an idea. We’ll know which screen you’re on.
            </label>
            <textarea
              id="feedback-body"
              autoFocus
              rows={6}
              maxLength={FEEDBACK_MAX}
              placeholder="Tell us what you’re thinking…"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              aria-describedby="feedback-count"
              className="field min-h-36 resize-y py-3 leading-[1.45]"
            />
            <div className="flex items-center justify-between gap-3">
              <span id="feedback-count" className={`tnum font-mono text-[12px] ${body.length >= FEEDBACK_MAX ? 'text-pencil' : 'text-muted'}`}>{body.length} / {FEEDBACK_MAX}</span>
              <button type="submit" className="btn-primary px-6 disabled:opacity-60" disabled={trimmed === 0 || send.isPending}>
                {send.isPending ? 'SENDING…' : 'SEND FEEDBACK'}
              </button>
            </div>
            {send.isError && <p role="alert" className="m-0 rounded-sm border border-pencil/60 bg-pencil/10 px-3 py-[10px] text-[14px]">Couldn’t send. {errorText(send.error)}</p>}
          </form>
        )}
      </div>
    </dialog>
  );
}
