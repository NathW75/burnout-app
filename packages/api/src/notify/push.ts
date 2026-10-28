/**
 * Web push delivery (PRD-008 §9): VAPID-signed, encrypted messages to the
 * push service each browser chose. The server only ever posts to known push
 * services, never to an arbitrary URL a client hands it.
 */
import webpush from 'web-push';

export interface PushSubscriptionKeys {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface PushSender {
  send(sub: PushSubscriptionKeys, payload: string): Promise<void>;
}

/** gone = the push service says this subscription no longer exists (404/410): remove it. */
export class PushSendError extends Error {
  constructor(readonly status: number) {
    super(`Push send failed: HTTP ${status}`);
    this.name = 'PushSendError';
  }
  get gone(): boolean {
    return this.status === 404 || this.status === 410;
  }
}

/** The push services browsers use (Chrome/Edge/Android, Firefox, Safari/iOS, Windows). */
const PUSH_HOSTS: ReadonlyArray<RegExp> = [
  /^fcm\.googleapis\.com$/,
  /^android\.googleapis\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /^web\.push\.apple\.com$/,
  /^[a-z0-9-]+\.notify\.windows\.com$/,
];

export function isAllowedPushEndpoint(endpoint: string): boolean {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  return u.protocol === 'https:' && !u.port && !u.username && !u.password && PUSH_HOSTS.some((re) => re.test(u.hostname));
}

export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  /** mailto: or https: contact for push services (VAPID_SUBJECT). */
  subject: string;
}

export function webPushSender(v: VapidConfig): PushSender {
  return {
    async send(sub, payload) {
      if (!isAllowedPushEndpoint(sub.endpoint)) throw new PushSendError(410); // treat as gone: never post elsewhere
      try {
        await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload, {
          vapidDetails: { subject: v.subject, publicKey: v.publicKey, privateKey: v.privateKey },
          TTL: 6 * 3600, // a notice older than 6 hours isn't worth showing (PRD-008 §4)
          urgency: 'high',
          timeout: 10_000,
        });
      } catch (err) {
        const status = typeof (err as { statusCode?: unknown }).statusCode === 'number' ? (err as { statusCode: number }).statusCode : 0;
        throw new PushSendError(status);
      }
    },
  };
}
