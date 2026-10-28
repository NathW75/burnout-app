/**
 * PRD-007 §12 end-to-end flows and §13 acceptance criteria, in a phone-sized
 * browser against the real API.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { API, fillLineup, freshCode, FULL_LINEUP, hold, mailLink, PASSWORD, pick, signUp, type Account } from './helpers';

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
  const stored = await page.evaluate(() => Object.keys(localStorage).filter((k) => !k.startsWith('bl:draft:') && k !== 'bl:theme'));
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

test('after a lock and a burn: burned roster, inbox with read state, standings, and a reveal that shows locked picks only', async ({ page }) => {
  const acc = await signUp(page);
  // Last week through the real lock and scoring jobs: three picks lock, the game goes Final, they burn.
  const r = await fetch(`${API}/__e2e/history`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: acc.handle }) });
  expect(r.status).toBe(200);
  const jobs = (await r.json()) as { locks: { windowsLocked: number }; scoring: { weeks: Array<{ week: number; burns?: number }> } };
  expect(jobs.scoring.weeks.find((w) => w.week === 7)?.burns).toBeGreaterThanOrEqual(3);

  // Burned roster (§6.4).
  await page.goto('/burned');
  await expect(page.getByRole('heading', { name: 'Burned' })).toBeVisible();
  const week7 = page.getByRole('list', { name: 'Burned in Week 7' });
  await expect(week7.getByRole('listitem')).toHaveCount(3);
  await expect(week7.getByText('Quinn Kay')).toBeVisible();
  await expect(week7.getByText('QB · KC · Sunday Early · 1:00 PM')).toBeVisible();
  await noPlayerImages(page);
  await noSeriousA11yIssues(page, 'burned roster');

  // Inbox (§6.6): lock and burn notices name the players; read state per item and for all.
  await expect(page.getByRole('link', { name: /^Inbox, \d+ unread$/ })).toBeVisible();
  await page.getByRole('link', { name: /^Inbox/ }).click();
  const notices = page.getByRole('list', { name: 'Notices' });
  await expect(notices.getByText('Quinn Kay, Ray Dent and Wes Kay are burned: their games went Final.')).toBeVisible();
  await expect(notices.getByText(/^Sunday Early · 1:00 PM locked with /)).toBeVisible();
  await expect(notices.getByText('NEW').first()).toBeVisible();
  await noSeriousA11yIssues(page, 'inbox');
  await page.getByRole('button', { name: 'MARK ALL READ' }).click();
  await expect(page.getByText('All read')).toBeVisible();
  await expect(notices.getByText('NEW')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Inbox', exact: true })).toBeVisible();

  // Standings (§6.5): the field with my row marked.
  await page.getByRole('link', { name: 'BOARD' }).click();
  const table = page.getByRole('table');
  await expect(table.getByRole('row').filter({ hasText: acc.handle }).getByText('YOU')).toBeVisible();
  await expect(table.getByRole('link', { name: 'rival_e2e' })).toBeVisible();
  await noSeriousA11yIssues(page, 'standings');

  // Reveal: the rival's Thursday pick is locked and shown; the Sunday pick isn't locked and never reaches the page.
  const revealed = page.waitForResponse((res) => /\/managers\/rival_e2e\/lineup$/.test(new URL(res.url()).pathname) && res.request().method() === 'GET');
  await table.getByRole('link', { name: 'rival_e2e' }).click();
  const body = await (await revealed).text();
  expect(body).toContain('wrKC');
  expect(body).not.toContain('wrDAL');
  const slots = page.getByRole('list', { name: 'rival_e2e, Week 8' });
  await expect(slots.getByText('Wes Kay')).toBeVisible();
  await expect(slots.getByText('Walt Dal')).toHaveCount(0);
  await expect(slots.getByText('Hidden until its window locks')).toHaveCount(8);
  await noPlayerImages(page);
  await noSeriousA11yIssues(page, 'reveal');
  // Last week: the rival's locked pick from Week 7.
  await page.getByRole('combobox').selectOption('7');
  const w7 = page.getByRole('list', { name: 'rival_e2e, Week 7' });
  await expect(w7.getByText('Ray Dent')).toHaveClass(/line-through/);
  await expect(w7.getByText('RB1 · BURNED')).toBeVisible();
});

/** Signs in through the UI in a fresh page (another "device"). */
async function signIn(page: Page, acc: Account, secret = acc.secret, password = PASSWORD) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(acc.email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'CONTINUE' }).click();
  await expect(page).toHaveURL(/\/login\/code/);
  await page.getByLabel('Code').fill(await freshCode(secret));
  await page.getByRole('button', { name: 'SIGN IN' }).click();
  await expect(page.getByRole('heading', { name: 'Week 8' })).toBeVisible();
}

/** Waits for the screen to settle on either the step-up prompt or `next`, and answers the prompt if asked. */
async function stepUpIfAsked(page: Page, secret: string, next: Locator) {
  const prompt = page.getByText('CONFIRM IT’S YOU');
  await expect(prompt.or(next).first()).toBeVisible();
  if (await prompt.isVisible()) {
    await page.getByLabel('Code').fill(await freshCode(secret));
    await page.getByRole('button', { name: 'CONFIRM' }).click();
    await expect(prompt).toHaveCount(0);
  }
}

test('account: sessions on two devices, revoke one; change password; new backup codes after a step-up', async ({ page, browser }) => {
  test.setTimeout(150_000);
  const acc = await signUp(page);
  // A second device signs in.
  const other = await browser.newContext({ baseURL: 'http://localhost:4173' });
  const phone = await other.newPage();
  await signIn(phone, acc);

  await page.goto('/account');
  await noSeriousA11yIssues(page, 'account');
  await page.getByRole('list', { name: 'Security' }).getByRole('link', { name: /^Sessions/ }).click();
  const devices = page.getByRole('list', { name: 'Signed-in devices' });
  await expect(devices.getByRole('listitem')).toHaveCount(2);
  await expect(devices.getByText('THIS DEVICE')).toHaveCount(1);
  await noSeriousA11yIssues(page, 'sessions');
  await devices.getByRole('button', { name: /^Sign out / }).click();
  await expect(devices.getByRole('listitem')).toHaveCount(1);
  // The revoked device is signed out on its next request.
  await phone.goto('/lineup');
  await expect(phone).toHaveURL(/\/login/);
  await other.close();

  // Password: this device stays signed in.
  await page.goto('/account/password');
  await page.getByLabel('Current password').fill(PASSWORD);
  await page.getByLabel('NEW PASSWORD', { exact: true }).fill('an even better passphrase');
  await page.getByLabel('New password again').fill('an even better passphrase');
  await page.getByRole('button', { name: 'CHANGE PASSWORD' }).click();
  await expect(page.getByText('Password changed. Your other devices are signed out.')).toBeVisible();
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Week 8' })).toBeVisible();

  // Backup codes need a fresh code first; the new ones are shown once.
  await page.goto('/account/backup-codes');
  await stepUpIfAsked(page, acc.secret, page.getByRole('button', { name: 'GET NEW BACKUP CODES' }));
  await page.getByRole('button', { name: 'GET NEW BACKUP CODES' }).click();
  await expect(page.getByRole('list', { name: 'Backup codes' }).getByRole('listitem')).toHaveCount(10);
  await noSeriousA11yIssues(page, 'backup codes');
  await page.getByLabel('I’ve saved these codes.').check();
  await page.getByRole('button', { name: 'DONE' }).click();
  await expect(page.getByText('New backup codes saved. The old ones no longer work.')).toBeVisible();
});

test('account: replace the authenticator; the old one stops working and the new one signs in', async ({ page, context }) => {
  test.setTimeout(150_000);
  const acc = await signUp(page);
  await page.goto('/account/authenticator');
  await stepUpIfAsked(page, acc.secret, page.getByLabel('Password'));
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'CONTINUE' }).click();
  const key = (await page.locator('code').first().innerText()).replace(/\s+/g, '');
  expect(key).toMatch(/^[A-Z2-7]{16,}$/);
  await noPlayerImages(page);
  await page.getByLabel('6-digit code from the new app').fill(await freshCode(key));
  await page.getByRole('button', { name: 'CONFIRM' }).click();
  await expect(page.getByRole('heading', { name: 'Save your new backup codes' })).toBeVisible();
  await page.getByLabel('I’ve saved these codes.').check();
  await page.getByRole('button', { name: 'DONE' }).click();
  await expect(page.getByText(/Your new authenticator is set up/)).toBeVisible();

  // Sign out; the old authenticator's code is refused, the new one works.
  await page.goto('/account');
  await page.getByRole('button', { name: 'SIGN OUT', exact: true }).click();
  await context.clearCookies();
  await page.goto('/login');
  await page.getByLabel('Email').fill(acc.email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'CONTINUE' }).click();
  await page.getByLabel('Code').fill(await freshCode(acc.secret));
  await page.getByRole('button', { name: 'SIGN IN' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await page.getByLabel('Code').fill(await freshCode(key));
  await page.getByRole('button', { name: 'SIGN IN' }).click();
  await expect(page.getByRole('heading', { name: 'Week 8' })).toBeVisible();
});

test('feedback from any signed-in screen; the light theme sticks across reloads and passes axe', async ({ page }) => {
  await signUp(page);
  // Feedback: floats above the bottom nav, sends, confirms.
  await page.goto('/burned');
  const fab = page.getByRole('button', { name: 'Send feedback' });
  const nav = page.getByRole('navigation', { name: 'Main' });
  const [fb, nb] = [await fab.boundingBox(), await nav.boundingBox()];
  expect(fb!.y + fb!.height).toBeLessThanOrEqual(nb!.y);
  const sent = page.waitForRequest((r) => r.url().endsWith('/v1/feedback') && r.method() === 'POST');
  await fab.click();
  const dialog = page.getByRole('dialog', { name: '/// FEEDBACK' });
  await expect(dialog).toBeVisible();
  await noSeriousA11yIssues(page, 'feedback');
  await dialog.getByRole('textbox').fill('The burned roster reads well.');
  await dialog.getByRole('button', { name: 'SEND FEEDBACK' }).click();
  const req = await sent;
  expect(req.headers()['x-current-screen']).toBe('burned_roster');
  expect(req.postDataJSON()).toEqual({ body: 'The burned roster reads well.' });
  await expect(dialog.getByText('Sent. Thanks, we read every one.')).toBeVisible();
  await expect(dialog).toHaveCount(0, { timeout: 4000 });
  // Not on signed-out screens.
  await page.goto('/help');
  await expect(fab).toBeVisible();

  // Light theme.
  await page.goto('/account');
  await page.getByText('LIGHT', { exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(243, 240, 232)');
  await noSeriousA11yIssues(page, 'account (light)');
  await page.goto('/');
  await noSeriousA11yIssues(page, 'this week (light)');
  await page.goto('/lineup');
  await noSeriousA11yIssues(page, 'lineup (light)');
  await page.goto('/account');
  await page.getByText('DARK', { exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

test('a window that locks during Gate 2 is rejected at Gate 3 and the user is sent back with the reason (runs last)', async ({ page }) => {
  await signUp(page);
  await fillLineup(page);
  await page.getByRole('button', { name: 'REVIEW LINEUP' }).click();
  await expect(page.getByRole('heading', { name: 'Review Week 8' })).toBeVisible();
  await page.getByRole('button', { name: 'CONTINUE' }).click();
  // Wait for Gate 2 itself: its checkboxes don't exist until the screen has rendered.
  await expect(page.getByRole('heading', { name: 'Before you lock in' })).toBeVisible();
  const boxes = page.getByRole('checkbox');
  await expect(boxes).toHaveCount(3);
  for (let i = 0; i < 3; i++) await boxes.nth(i).check();
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
