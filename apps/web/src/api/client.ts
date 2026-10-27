/**
 * API client (PRD-007 §4).
 *
 * - The session is the API's httpOnly cookie: every request sends credentials
 *   and the app never sees or stores a token.
 * - Unsafe requests carry X-Burnout-CSRF: 1 (PRD-006 §5.7).
 * - Every request names the current screen in X-Current-Screen (feedback spec).
 */
export const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, '') || 'http://localhost:3001';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly body: Record<string, unknown> | null = null
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** The API could not be reached (offline, DNS, CORS). Distinct from an error answer. */
export class NetworkError extends Error {
  constructor() {
    super('Network error');
    this.name = 'NetworkError';
  }
}

let currentScreen = 'unknown';

/** Set by the router on every navigation; a readable slug like "lineup_builder". */
export function setCurrentScreen(slug: string): void {
  currentScreen = slug;
}

export function getCurrentScreen(): string {
  return currentScreen;
}

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
const UNSAFE: ReadonlySet<Method> = new Set(['POST', 'PUT', 'DELETE']);

export interface RequestOptions {
  method?: Method;
  body?: unknown;
  signal?: AbortSignal;
}

export async function api<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const method = opts.method ?? (opts.body === undefined ? 'GET' : 'POST');
  const headers: Record<string, string> = { 'X-Current-Screen': currentScreen };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (UNSAFE.has(method)) headers['X-Burnout-CSRF'] = '1';
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/v1${path}`, {
      method,
      headers,
      credentials: 'include',
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: opts.signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new NetworkError();
  }
  const text = await res.text();
  let data: Record<string, unknown> | null = null;
  if (text) {
    try {
      data = JSON.parse(text) as Record<string, unknown>;
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    const code = typeof data?.error === 'string' ? data.error : `HTTP_${res.status}`;
    const message = typeof data?.message === 'string' ? data.message : 'Something went wrong';
    throw new ApiError(res.status, code, message, data);
  }
  return data as T;
}

export const isApiError = (err: unknown, code?: string): err is ApiError => err instanceof ApiError && (code === undefined || err.code === code);
