/**
 * Mailer for messages that carry a secret (verification and reset links).
 * These never go through the notification outbox, so the token is never
 * stored in plaintext (PRD-006 §6.1). Everything else uses the outbox.
 */
export type MailTemplate = 'verify_email' | 'password_reset' | 'account_exists' | 'mfa_reset' | 'invite';

export interface MailMessage {
  to: string;
  template: MailTemplate;
  data: Record<string, string>;
}

/** A notice email from the outbox (PRD-008): no secrets, rendered by notify/templates. */
export interface NoticeMail {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** One-click unsubscribe (RFC 8058): https URL that accepts POST. */
  unsubscribeUrl: string;
  /** Notice ids, for tracing in SendGrid. */
  noticeIds: string[];
}

/** A plain-text email to the team (feedback alerts, PRD-007 §10.1). Never to players. */
export interface AdminMail {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(msg: MailMessage): Promise<void>;
  sendAdmin(msg: AdminMail): Promise<void>;
  /** Sends a notice email; returns the provider's message id when it gives one. */
  sendNotice(msg: NoticeMail): Promise<{ id: string | null }>;
}

/** A send the provider refused. permanent = retrying won't help (bad address, rejected content). */
export class MailSendError extends Error {
  constructor(readonly status: number, readonly permanent: boolean) {
    super(`Mail send failed: HTTP ${status}`);
    this.name = 'MailSendError';
  }
}

/** Records messages in memory (tests and local development). */
export class MemoryMailer implements Mailer {
  readonly sent: MailMessage[] = [];
  readonly notices: NoticeMail[] = [];
  readonly admin: AdminMail[] = [];
  /** Tests set this to make admin sends fail. */
  failAdmin: MailSendError | null = null;
  /** Tests set this to make the next notice sends fail. */
  failNotices: MailSendError | null = null;
  /** Tests set this to make secret-carrying sends (verification, invites) fail. */
  failSend: Error | null = null;
  async send(msg: MailMessage): Promise<void> {
    if (this.failSend) throw this.failSend;
    this.sent.push(msg);
  }
  async sendNotice(msg: NoticeMail): Promise<{ id: string | null }> {
    if (this.failNotices) throw this.failNotices;
    this.notices.push(msg);
    return { id: `mem-${this.notices.length}` };
  }
  async sendAdmin(msg: AdminMail): Promise<void> {
    if (this.failAdmin) throw this.failAdmin;
    this.admin.push(msg);
  }
  last(template: MailTemplate, to?: string): MailMessage | undefined {
    return [...this.sent].reverse().find((m) => m.template === template && (!to || m.to === to));
  }
}

const SUBJECTS: Record<MailTemplate, string> = {
  verify_email: 'Verify your Burnout League email',
  password_reset: 'Reset your Burnout League password',
  account_exists: 'You already have a Burnout League account',
  mfa_reset: 'Your Burnout League two-factor setup was reset',
  invite: 'You’re invited to Burnout League',
};

function body(msg: MailMessage): string {
  switch (msg.template) {
    case 'verify_email':
      return `Confirm your email: ${msg.data.link}\n\nThe link works once and expires in 48 hours.`;
    case 'password_reset':
      return `Reset your password: ${msg.data.link}\n\nThe link works once and expires in 1 hour. If you didn't ask for this, ignore this email.`;
    case 'account_exists':
      return `Someone tried to sign up with this email, but you already have an account. Sign in, or reset your password: ${msg.data.link}`;
    case 'mfa_reset':
      return `An administrator reset your two-factor authentication after verifying your identity. You've been signed out everywhere. Sign in and set up a new authenticator: ${msg.data.link}\n\nIf you didn't ask for this, reply to this email right away.`;
    case 'invite':
      return [
        'You’re invited to test Burnout League: season-long fantasy football with one rule. Start him, lose him.',
        '',
        `Sign up here (your code is already filled in): ${msg.data.link}`,
        '',
        `Invite code: ${msg.data.code}`,
        msg.data.expires ? `It works once and expires ${msg.data.expires}.` : 'It works once.',
        '',
        'Sign-up takes a couple of minutes, including setting up an authenticator app (Google Authenticator, 1Password or similar) to keep your account secure.',
      ].join('\n');
  }
}

/** Subject and body as sent, for tests. */
export function renderForTest(msg: MailMessage): string {
  return `${SUBJECTS[msg.template]}\n\n${body(msg)}`;
}

/** SendGrid v3 mail send. The API key comes from SENDGRID_API_KEY (Railway env vars only). */
export class SendGridMailer implements Mailer {
  /** noticeFrom: "Burnout League <alerts@burnoutfantasy.com>" (NOTIFY_FROM). */
  constructor(private readonly apiKey: string, private readonly from: string, private readonly noticeFrom: string = from) {}

  async sendNotice(msg: NoticeMail): Promise<{ id: string | null }> {
    const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(this.noticeFrom);
    const from = m ? { name: m[1], email: m[2] } : { email: this.noticeFrom };
    let res: Response;
    try {
      res = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: msg.to }] }],
          from,
          subject: msg.subject,
          content: [
            { type: 'text/plain', value: msg.text },
            { type: 'text/html', value: msg.html },
          ],
          headers: { 'List-Unsubscribe': `<${msg.unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
          // No tracking (PRD-007 §9, PRD-008 §5): links go straight to the app, no open pixel.
          tracking_settings: { click_tracking: { enable: false, enable_text: false }, open_tracking: { enable: false }, subscription_tracking: { enable: false } },
          custom_args: { notice_ids: msg.noticeIds.join(',').slice(0, 900) },
          categories: ['notice'],
        }),
      });
    } catch {
      throw new MailSendError(0, false); // network: retry
    }
    if (!res.ok) throw new MailSendError(res.status, res.status >= 400 && res.status < 500 && res.status !== 429);
    return { id: res.headers.get('x-message-id') };
  }

  async sendAdmin(msg: AdminMail): Promise<void> {
    const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(this.noticeFrom);
    const from = m ? { name: m[1], email: m[2] } : { email: this.noticeFrom };
    let res: Response;
    try {
      res = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: msg.to }] }],
          from,
          subject: msg.subject,
          content: [{ type: 'text/plain', value: msg.text }],
          tracking_settings: { click_tracking: { enable: false, enable_text: false }, open_tracking: { enable: false }, subscription_tracking: { enable: false } },
          categories: ['admin'],
        }),
      });
    } catch {
      throw new MailSendError(0, false);
    }
    if (!res.ok) throw new MailSendError(res.status, res.status >= 400 && res.status < 500 && res.status !== 429);
  }

  async send(msg: MailMessage): Promise<void> {
    const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: msg.to }] }],
        from: { email: this.from },
        subject: SUBJECTS[msg.template],
        content: [{ type: 'text/plain', value: body(msg) }],
        // These links carry a one-time secret: never rewrite them through a click tracker.
        tracking_settings: { click_tracking: { enable: false, enable_text: false }, open_tracking: { enable: false }, subscription_tracking: { enable: false } },
      }),
    });
    if (!res.ok) throw new Error(`SendGrid send failed: ${res.status}`);
  }
}
