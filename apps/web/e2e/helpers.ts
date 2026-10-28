import { expect, type Page } from '@playwright/test';
import { totp } from '../../../packages/api/src/auth/totp';

export const API = 'http://localhost:3001';
export const PASSWORD = 'correct horse battery staple';

export interface Account {
  email: string;
  handle: string;
  secret: string;
}

let n = 0;
const lastStep = new Map<string, number>();

/** A fresh TOTP code. A factor's codes can't be replayed, so wait for a new 30-second step when needed. */
export async function freshCode(secret: string): Promise<string> {
  for (;;) {
    const step = Math.floor(Date.now() / 30_000);
    if (step !== lastStep.get(secret)) {
      lastStep.set(secret, step);
      return totp(secret, new Date());
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

export async function mailLink(email: string, template: 'verify_email' | 'password_reset'): Promise<string> {
  const res = await fetch(`${API}/__e2e/mail?template=${template}&to=${encodeURIComponent(email)}`);
  expect(res.ok).toBe(true);
  return ((await res.json()) as { link: string }).link;
}

/** The whole sign-up process through the UI (PRD-007 §6.1.1). */
export async function signUp(page: Page): Promise<Account> {
  const handle = `e2e_${Date.now() % 1_000_000}_${n++}`;
  const email = `${handle}@example.com`;
  await page.goto('/signup');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByLabel('Handle').fill(handle);
  await page.getByRole('button', { name: 'CREATE ACCOUNT' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();

  await page.goto(await mailLink(email, 'verify_email'));
  await expect(page.getByRole('heading', { name: 'Email verified' })).toBeVisible();
  await page.getByRole('link', { name: 'SIGN IN TO CONTINUE' }).click();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'CONTINUE' }).click();

  await expect(page).toHaveURL(/\/setup-2fa/);
  // The setup screen loads on demand: wait for it, or the password lands in the outgoing sign-in form.
  await expect(page.getByRole('heading', { name: 'Set up your authenticator' })).toBeVisible();
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'CONTINUE' }).click();
  const key = page.locator('code');
  await expect(key).toBeVisible();
  const secret = (await key.innerText()).replace(/\s+/g, '');
  await page.getByLabel('6-digit code from the app').fill(await freshCode(secret));
  await page.getByRole('button', { name: 'CONFIRM' }).click();
  await expect(page.getByRole('heading', { name: 'Save your backup codes' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'CONTINUE' })).toBeDisabled();
  await page.getByLabel('I’ve saved these codes.').check();
  await page.getByRole('button', { name: 'CONTINUE' }).click();
  await expect(page).toHaveURL(/\/welcome/);
  await page.getByRole('link', { name: 'Skip' }).click();
  await expect(page.getByRole('heading', { name: 'Week 8' })).toBeVisible();
  return { email, handle, secret };
}

export async function pick(page: Page, slot: string, player: string) {
  await page.getByRole('link', { name: `PICK ${slot}`, exact: true }).click();
  await page.getByRole('button', { name: `Select ${player}` }).click();
  await expect(page.getByRole('heading', { name: /LINEUP$/ })).toBeVisible();
}

export const FULL_LINEUP: Array<[string, string]> = [
  ['QB', 'Quade Buff'], ['RB1', 'Rex Mia'], ['RB2', 'Rod Sfo'], ['WR1', 'Will Buff'], ['WR2', 'Walt Dal'],
  ['WR3', 'Wade Phi'], ['TE', 'Ty Sfo'], ['FLEX', 'Fred Sfo'], ['K', 'Kai Mia'],
];

export async function fillLineup(page: Page, lineup = FULL_LINEUP) {
  await page.goto('/lineup');
  for (const [slot, player] of lineup) await pick(page, slot, player);
}

/** Press and hold the Gate 3 button with the mouse for `ms`. */
export async function hold(page: Page, ms: number) {
  const box = (await page.getByRole('button', { name: /Hold to lock in/ }).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(ms);
  await page.mouse.up();
}
