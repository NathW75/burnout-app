/**
 * Mailer for messages that carry a secret (verification and reset links).
 * These never go through the notification outbox, so the token is never
 * stored in plaintext (PRD-006 §6.1). Everything else uses the outbox.
 */
export type MailTemplate = 'verify_email' | 'password_reset' | 'account_exists' | 'mfa_reset';

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

export interface Mailer {
  send(msg: MailMessage): Promise<void>;
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
  /** Tests set this to make the next notice sends fail. */
  failNotices: MailSendError | null = null;
  async send(msg: MailMessage): Promise<void> {
    this.sent.push(msg);
  }
  async sendNotice(msg: NoticeMail): Promise<{ id: string | null }> {
    if (this.failNotices) throw this.failNotices;
    this.notices.push(msg);
    return { id: `mem-${this.notices.length}` };
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
  }
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

  async send(msg: MailMessage): Promise<void> {
    const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: msg.to }] }],
        from: { email: this.from },
        subject: SUBJECTS[msg.template],
        content: [{ type: 'text/plain', value: body(msg) }],
      }),
    });
    if (!res.ok) throw new Error(`SendGrid send failed: ${res.status}`);
  }
}
