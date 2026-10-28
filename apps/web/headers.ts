/**
 * Security headers for the static app (PRD-007 §9), served by Cloudflare
 * from the `_headers` file. Kept separate so a test can check the CSP.
 */
export function securityHeaders(apiBase: string): string {
  const api = new URL(apiBase).origin;
  const csp = [
    "default-src 'self'",
    "script-src 'self' https://challenges.cloudflare.com",
    "frame-src https://challenges.cloudflare.com",
    `connect-src 'self' ${api}`,
    "style-src 'self' https://fonts.googleapis.com",
    "style-src-attr 'unsafe-inline'", // progress rings and countdown fills set inline style values
    "font-src https://fonts.gstatic.com",
    "img-src 'self' data:",
    "worker-src 'self'", // sw.js: push notifications (PRD-008 §9)
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
  return [
    '/*',
    `  Content-Security-Policy: ${csp}`,
    '  Strict-Transport-Security: max-age=31536000; includeSubDomains',
    '  Referrer-Policy: strict-origin-when-cross-origin',
    '  X-Content-Type-Options: nosniff',
    '  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()',
    '/assets/*',
    '  Cache-Control: public, max-age=31536000, immutable',
    '/index.html',
    '  Cache-Control: no-cache',
    '/sw.js',
    '  Cache-Control: no-cache',
    '/manifest.webmanifest',
    '  Content-Type: application/manifest+json',
    '',
  ].join('\n');
}
