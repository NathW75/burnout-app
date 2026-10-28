/**
 * Theme (PRD-007 §11): dark by default, as on the landing page; light uses
 * the landing page's light tokens. The choice is a per-browser preference in
 * localStorage (not account data). public/theme.js applies it before paint.
 */
import { useEffect, useState } from 'react';

export type ThemePref = 'dark' | 'light' | 'system';
const KEY = 'bl:theme';
const CHROME = { dark: '#0D0E0F', light: '#FBFAF6' } as const;

export function readThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'system' ? v : 'dark';
  } catch {
    return 'dark';
  }
}

export function resolveTheme(pref: ThemePref, prefersLight: boolean): 'dark' | 'light' {
  return pref === 'system' ? (prefersLight ? 'light' : 'dark') : pref;
}

const prefersLight = () => typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: light)').matches;

export function applyTheme(pref: ThemePref): 'dark' | 'light' {
  const t = resolveTheme(pref, prefersLight());
  document.documentElement.setAttribute('data-theme', t);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', CHROME[t]);
  return t;
}

export function saveThemePref(pref: ThemePref): void {
  try {
    if (pref === 'dark') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, pref);
  } catch {
    // Private mode or storage blocked: the choice lasts for this page only.
  }
  applyTheme(pref);
}

/** The current preference, kept applied (and following the device while "system"). */
export function useThemePref(): [ThemePref, (p: ThemePref) => void] {
  const [pref, setPref] = useState<ThemePref>(readThemePref);
  useEffect(() => {
    applyTheme(pref);
    if (pref !== 'system' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const on = () => applyTheme('system');
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [pref]);
  return [pref, (p) => (saveThemePref(p), setPref(p))];
}

/** The theme in effect right now, for the few things that can't read CSS (Turnstile). */
export function currentTheme(): 'dark' | 'light' {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}
