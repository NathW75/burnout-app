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

export interface Mailer {
  send(msg: MailMessage): Promise<void>;
}

/** Records messages in memory (tests and local development). */
export class MemoryMailer implements Mailer {
  readonly sent: MailMessage[] = [];
  async send(msg: MailMessage): Promise<void> {
    this.sent.push(msg);
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
  constructor(private readonly apiKey: string, private readonly from: string) {}
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
