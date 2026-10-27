import { describe, expect, it } from 'vitest';
import type { Me } from '../api/types';
import { nextStep, safeNext } from './guards';

const me = (o: Partial<Me>): Me => ({ id: 'u', email: 'a@b.c', handle: 'h', role: 'user', emailVerified: true, mfaEnrolled: true, stepUpUntil: null, ...o });

describe('one sign-up process (PRD-007 §6.1.1)', () => {
  it('resumes at the step the user left', () => {
    expect(nextStep(null)).toBe('/login');
    expect(nextStep(me({ emailVerified: false, mfaEnrolled: false }))).toBe('/verify-pending');
    expect(nextStep(me({ mfaEnrolled: false }))).toBe('/setup-2fa');
    expect(nextStep(me({}))).toBeNull();
  });
  it('only follows same-app return paths', () => {
    expect(safeNext('/lineup')).toBe('/lineup');
    expect(safeNext('https://evil.example')).toBe('/');
    expect(safeNext('//evil.example')).toBe('/');
    expect(safeNext('/\\evil.example')).toBe('/');
    expect(safeNext(null)).toBe('/');
  });
});
