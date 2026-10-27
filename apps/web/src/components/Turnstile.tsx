/**
 * Cloudflare Turnstile on sign-up (PRD-007 §6.1, Q6). The only third-party
 * script in Phase A. Without a site key (local, tests) nothing renders and
 * the API, which has no secret there either, skips the check.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';

export const TURNSTILE_SITE_KEY = (import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined) ?? '';

interface TurnstileApi {
  render(el: HTMLElement, opts: Record<string, unknown>): string;
  reset(id?: string): void;
  remove(id: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
let loading: Promise<TurnstileApi> | null = null;

function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (!loading) {
    loading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = SCRIPT_SRC;
      s.async = true;
      s.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error('turnstile missing')));
      s.onerror = () => {
        loading = null;
        reject(new Error('turnstile failed to load'));
      };
      document.head.appendChild(s);
    });
  }
  return loading;
}

export interface TurnstileHandle {
  /** Tokens work once: reset after every submit attempt. */
  reset(): void;
}

interface Props {
  onToken: (token: string | null) => void;
  onError?: () => void;
}

export const Turnstile = forwardRef<TurnstileHandle, Props>(function Turnstile({ onToken, onError }, ref) {
  const el = useRef<HTMLDivElement>(null);
  const widget = useRef<string | null>(null);
  const cb = useRef({ onToken, onError });
  cb.current = { onToken, onError };

  useImperativeHandle(ref, () => ({
    reset() {
      if (widget.current && window.turnstile) window.turnstile.reset(widget.current);
      cb.current.onToken(null);
    },
  }));

  useEffect(() => {
    if (!TURNSTILE_SITE_KEY || !el.current) return;
    let cancelled = false;
    loadTurnstile()
      .then((t) => {
        if (cancelled || !el.current) return;
        widget.current = t.render(el.current, {
          sitekey: TURNSTILE_SITE_KEY,
          theme: 'dark',
          action: 'signup',
          callback: (token: string) => cb.current.onToken(token),
          'expired-callback': () => cb.current.onToken(null),
          'error-callback': () => {
            cb.current.onToken(null);
            cb.current.onError?.();
          },
        });
      })
      .catch(() => cb.current.onError?.());
    return () => {
      cancelled = true;
      if (widget.current && window.turnstile) window.turnstile.remove(widget.current);
      widget.current = null;
    };
  }, []);

  if (!TURNSTILE_SITE_KEY) return null;
  return <div ref={el} className="min-h-[65px]" />;
});
