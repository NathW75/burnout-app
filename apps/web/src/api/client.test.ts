import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, NetworkError, setCurrentScreen } from './client';

afterEach(() => vi.unstubAllGlobals());

describe('API client (PRD-007 §4)', () => {
  it('sends the session cookie, the screen, and the CSRF header on unsafe requests only', async () => {
    const f = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal('fetch', f);
    setCurrentScreen('lineup_builder');
    await api('/me');
    await api('/feedback', { body: { body: 'hi' } });
    const [getUrl, getInit] = f.mock.calls[0] as unknown as [string, RequestInit];
    const [, postInit] = f.mock.calls[1] as unknown as [string, RequestInit];
    expect(getUrl).toMatch(/\/v1\/me$/);
    expect(getInit.credentials).toBe('include');
    expect(getInit.headers).toEqual({ 'X-Current-Screen': 'lineup_builder' });
    expect(postInit.method).toBe('POST');
    expect(postInit.headers).toMatchObject({ 'X-Burnout-CSRF': '1', 'Content-Type': 'application/json', 'X-Current-Screen': 'lineup_builder' });
  });

  it('turns error answers into ApiError with the code, and failed fetches into NetworkError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"WEEK_CLOSED","message":"closed"}', { status: 409 })));
    await expect(api('/x')).rejects.toMatchObject({ status: 409, code: 'WEEK_CLOSED' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>oops</html>', { status: 502 })));
    await expect(api('/x')).rejects.toBeInstanceOf(ApiError);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await expect(api('/x')).rejects.toBeInstanceOf(NetworkError);
  });
});
