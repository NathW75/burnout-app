import { afterEach, describe, expect, it } from 'vitest';
import { applyTheme, readThemePref, resolveTheme, saveThemePref } from './theme';

afterEach(() => document.documentElement.removeAttribute('data-theme'));

describe('theme (PRD-007 §11)', () => {
  it('defaults to dark, as on the landing page; "system" follows the device', () => {
    expect(readThemePref()).toBe('dark');
    expect(resolveTheme('system', true)).toBe('light');
    expect(resolveTheme('system', false)).toBe('dark');
    expect(resolveTheme('light', false)).toBe('light');
  });

  it('saving applies it to the page and the browser chrome color, and stores only a non-default choice', () => {
    const meta = Object.assign(document.createElement('meta'), { name: 'theme-color', content: '#0D0E0F' });
    document.head.appendChild(meta);
    saveThemePref('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(meta.getAttribute('content')).toBe('#F7F8F5');
    expect(localStorage.getItem('bl:theme')).toBe('light');
    expect(readThemePref()).toBe('light');
    saveThemePref('dark');
    expect(localStorage.getItem('bl:theme')).toBeNull();
    expect(applyTheme('dark')).toBe('dark');
    meta.remove();
  });

  it('ignores junk in storage', () => {
    localStorage.setItem('bl:theme', 'neon');
    expect(readThemePref()).toBe('dark');
  });
});
