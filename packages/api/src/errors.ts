/**
 * HTTP error with a stable machine-readable code — PRD-006 §4.
 */
export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message?: string, readonly details?: object) {
    super(message ?? code);
    this.name = 'HttpError';
  }
}

export const unauthorized = (code = 'UNAUTHENTICATED', message = 'Sign in required') => new HttpError(401, code, message);
export const forbidden = (code = 'FORBIDDEN', message = 'Not allowed') => new HttpError(403, code, message);
export const notFound = (message = 'Not found') => new HttpError(404, 'NOT_FOUND', message);
export const conflict = (code: string, message: string) => new HttpError(409, code, message);
export const tooMany = () => new HttpError(429, 'RATE_LIMITED', 'Too many attempts. Try again later.');
