/**
 * PRD-007 §12 end-to-end flows and §13 acceptance criteria, in a phone-sized
 * browser against the real API.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { API, fillLineup, freshCode, FULL_LINEUP, hold, mailLink, PASSWORD, pick, signUp } from './helpers';

test.describe.configure({ mode: 'serial' });

async function noSeriousA11yIssues(page: Page, where: string) {
  const r = await new AxeBuilder({ page: page as never }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  const bad = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(bad.map((v) => `${where}: ${v.id} (${v.nodes.length})`)).toEqual([]);
}

/** NIL (PRD-007 §5.1): no player or team images anywhere. The only image the app ever shows is the 2FA QR code. */
async function noPlayerImages(page: Page) {
  const imgs = await page.locator('img').evaluateAll((els) => els.map((e) => (e as HTMLImageElement).alt));
  expect(imgs.filter((alt) => alt !== 'QR code for your authenticator app')).toEqual([]);
  expect(await page.locator('[style*="background-image"]').count()).toBe(0);
}

test('the API refuses everything but sign-up steps until the authenticator is set up (server-enforced)', async ({ page }) => {
  // Sign up and verify, but stop before the authenticator.
  const handle = `e2e_half_${Date.now() % 100000}`;
  const email = `${handle}@example.com`;
  await page.goto('/signup');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByLabel('Handle').fill(handle);
  await page.getByRole('button', { name: 'CREATE ACCOUNT' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  await page.goto(await mailLink(email, 'verify_email'));
  await expect(page.getByRole('heading', { name: 'Email verified' })).toBeVisible();
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'CONTINUE' }).click();
  await expect(page).toHaveURL(/\/setup-2fa/);
  // Any other screen sends the user back to the setup step...
  await page.goto('/lineup');
  await expect(page).toHaveURL(/\/setup-2fa/);
  // ...and the API itself refuses, whatever the client does.
  const status = await page.evaluate(async (api) => {
    const r = await fetch(`${api}/v1/seasons/current`, { credentials: 'include' });
    return [r.status, (await r.json()).error];
  }, API);
  expect(status).toEqual([403, 'MFA_ENROLLMENT_REQUIRED']);
});

test('sign up → verify → authenticator → a lineup through all three gates → receipt', async ({ page }) => {
  await signUp(page);
  await noPlayerImages(page);
  await noSeriousA11yIssues(page, 'this week');

  // Every window shows its time ET and the scheduled-kickoff rule.
  await expect(page.getByText('Locks at scheduled kickoff, not actual kickoff. All times ET.')).toBeVisible();
  await expect(page.getByRole('list', { name: 'Game windows' }).getByText(/ET$/).first()).toBeVisible();

  await page.goto('/lineup');
  await noSeriousA11yIssues(page, 'builder');
  // The picker: FB is offered at RB and FLEX only; Out, bye and locked players can't be picked and say why.
  await page.getByRole('link', { name: 'PICK RB1', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Select Fred Sfo' })).toBeVisible();
  await expect(page.getByText('Out: not selectable, not burned')).toBeVisible();
  await expect(page.getByText('No game this week')).toBeVisible();
  await expect(page.getByText('vs KC · window has locked')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Select Rhett Bay' })).toHaveCount(0);
  await noSeriousA11yIssues(page, 'picker');
  await page.getByRole('link', { name: 'Back to lineup' }).click();
  await page.getByRole('link', { name: 'PICK WR1', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Select Fred Sfo' })).toHaveCount(0);
  await page.getByRole('link', { name: 'Back to lineup' }).click();

  // Every open slot is needed to submit (PRD-006 §9): review waits until all nine are filled.
  await pick(page, 'QB', 'Quade Buff');
  await expect(page.getByText('Fill RB1, RB2, WR1, WR2, WR3, TE, FLEX, K to review')).toBeVisible();
  await expect(page.getByRole('button', { name: 'REVIEW LINEUP' })).toBeDisabled();
  for (const [slot, player] of FULL_LINEUP.slice(1)) await pick(page, slot, player);
  await expect(page.getByText('9 changes not submitted')).toBeVisible();
  await page.getByRole('button', { name: 'REVIEW LINEUP' }).click();

  // Gate 1
  await expect(page.getByRole('heading', { name: 'Review Week 8' })).toBeVisible();
  await expect(page.getByText(/Expires in/)).toBeVisible();
  await noSeriousA11yIssues(page, 'gate 1');
  await page.getByRole('button', { name: 'CONTINUE' }).click();

  // Gate 2: untappable until all three are ticked.
  await expect(page.getByRole('heading', { name: 'Before you lock in' })).toBeVisible();
  const cont = page.getByRole('button', { name: 'CONTINUE' });
  await expect(cont).toBeDisabled();
  const boxes = page.getByRole('checkbox');
  await boxes.nth(0).check();
  await boxes.nth(1).check();
  await expect(cont).toBeDisabled();
  await boxes.nth(2).check();
  await expect(cont).toBeEnabled();
  await expect(cont).toHaveCSS('background-color', 'rgb(217, 54, 63)');
  await expect(cont).toHaveCSS('color', 'rgb(255, 255, 255)');
  await noSeriousA11yIssues(page, 'gate 2');
  await cont.click();

  // Gate 3: letting go early never submits; a full 1.5 s hold does.
  await expect(page.getByRole('heading', { name: 'Lock in Week 8' })).toBeVisible();
  await noSeriousA11yIssues(page, 'gate 3');
  const confirms: string[] = [];
  page.on('request', (r) => r.url().includes('/confirm') && confirms.push(r.url()));
  await hold(page, 700);
  await page.waitForTimeout(400);
  expect(confirms).toEqual([]);
  await hold(page, 1800);
  await expect(page.getByRole('heading', { name: 'Locked in.' })).toBeVisible();
  expect(confirms).toHaveLength(1);
  const checksum = await page.getByText(/^[0-9a-f]{64}$/).innerText();

  await page.getByRole('button', { name: 'VIEW RECEIPT' }).click();
  await expect(page).toHaveURL(/\/receipts\//);
  await expect(page.getByText(checksum)).toBeVisible();
  await expect(page.getByText('Quade Buff')).toBeVisible();
  await noPlayerImages(page);

  // This Week now shows the lineup, and a reload keeps the session (cookie, nothing in localStorage).
  await page.goto('/');
  await expect(page.getByText('9 / 9 SET')).toBeVisible();
  const stored = await page.evaluate(() => Object.keys(localStorage).filter((k) => !k.startsWith('bl:draft:')));
  expect(stored).toEqual([]);
});

test('sign in again: password, then a code', async ({ page, context }) => {
  const acc = await signUp(page);
  await page.goto('/account');
  await page.getByRole('button', { name: 'SIGN OUT', exact: true }).click();
  await expect(page).toHaveURL(/\/login/);
  await context.clearCookies();
  await page.goto('/lineup');
  await expect(page).toHaveURL(/\/login\?next=%2Flineup/);
  await page.getByLabel('Email').fill(acc.email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'CONTINUE' }).click();
  await expect(page).toHaveURL(/\/login\/code/);
  await page.getByLabel('Code').fill('000000');
  await page.getByRole('button', { name: 'SIGN IN' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await page.getByLabel('Code').fill(await freshCode(acc.secret));
  await page.getByRole('button', { name: 'SIGN IN' }).click();
  await expect(page).toHaveURL(/\/lineup$/);
});

test('a window that locks during Gate 2 is rejected at Gate 3 and the user is sent back with the reason (runs last)', async ({ page }) => {
  await signUp(page);
  await fillLineup(page);
  await page.getByRole('button', { name: 'REVIEW LINEUP' }).click();
  await page.getByRole('button', { name: 'CONTINUE' }).click();
  for (const b of await page.getByRole('checkbox').all()) await b.check();
  await page.getByRole('button', { name: 'CONTINUE' }).click();
  await expect(page.getByRole('heading', { name: 'Lock in Week 8' })).toBeVisible();

  // The Sunday Early window (QB, RB1, WR1, K) reaches its scheduled kickoff.
  const r = await fetch(`${API}/__e2e/windows/Sunday Early/lock-now`, { method: 'POST' });
  expect(((await r.json()) as { updated: number }).updated).toBe(1);

  await hold(page, 1800);
  await expect(page).toHaveURL(/\/lineup$/);
  await expect(page.getByRole('alert').first()).toContainText('locked before you confirmed');
  await expect(page.getByRole('alert').first()).toContainText('Your lineup was not confirmed');
  // Fresh data: the draft picks from the locked window are flagged, and review waits until they're replaced.
  await expect(page.getByText('His window locked. Pick someone else.')).toHaveCount(4);
  await expect(page.getByRole('button', { name: 'REVIEW LINEUP' })).toBeDisabled();
});
