import { describe, expect, it } from 'vitest';
import { securityHeaders } from '../../headers';

describe('security headers (PRD-007 §9)', () => {
  it('a strict CSP: self, the API origin, Turnstile and Google Fonts only; no framing', () => {
    const h = securityHeaders('https://api-staging.burnoutfantasy.com/');
    expect(h).toContain("connect-src 'self' https://api-staging.burnoutfantasy.com;");
    expect(h).toContain("script-src 'self' https://challenges.cloudflare.com;");
    expect(h).toContain("frame-ancestors 'none'");
    expect(h).toContain('Strict-Transport-Security: max-age=31536000');
    expect(h).toContain('Referrer-Policy: strict-origin-when-cross-origin');
    expect(h).not.toMatch(/script-src[^;]*unsafe/);
    expect(h).toContain("worker-src 'self';");
    expect(h).toContain("manifest-src 'self';");
    expect(h).toMatch(/\/sw\.js\n  Cache-Control: no-cache/); // a new service worker is picked up at once
  });
});
