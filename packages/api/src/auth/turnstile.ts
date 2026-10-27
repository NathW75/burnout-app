/**
 * Cloudflare Turnstile on sign-up — PRD-007 §8.4 (Q6)
 *
 * The token is checked server-side against siteverify. Skipped only when no
 * secret is configured (local and tests). A Cloudflare outage fails closed:
 * sign-up waits rather than letting bots through.
 */
import type { Log } from '../context';

export type TurnstileVerifier = (token: string, remoteIp: string | undefined) => Promise<boolean>;

const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export function cloudflareTurnstile(secret: string, log: Log, fetchImpl: typeof fetch = fetch): TurnstileVerifier {
  return async (token, remoteIp) => {
    try {
      const form = new URLSearchParams({ secret, response: token });
      if (remoteIp) form.set('remoteip', remoteIp);
      const res = await fetchImpl(SITEVERIFY, { method: 'POST', body: form, signal: AbortSignal.timeout(5_000) });
      if (!res.ok) {
        log('warn', 'turnstile siteverify failed', { status: res.status });
        return false;
      }
      const out = (await res.json()) as { success?: boolean; 'error-codes'?: string[] };
      if (!out.success) log('info', 'turnstile rejected a sign-up', { codes: out['error-codes'] ?? [] });
      return out.success === true;
    } catch (err) {
      log('warn', 'turnstile siteverify unreachable', { error: err instanceof Error ? err.message : String(err) });
      return false;
    }
  };
}
