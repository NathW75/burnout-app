/**
 * Web push on this device (PRD-008 §9). The browser asks permission only when
 * the person taps "turn on"; the subscription is saved to their account.
 */
import { api } from '../api/client';

export type PushSupport = 'ready' | 'denied' | 'ios-install' | 'unsupported';

export interface PushConfig {
  enabled: boolean;
  publicKey: string | null;
}

function isIOS(): boolean {
  const ua = navigator.userAgent;
  return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

function isStandalone(): boolean {
  return window.matchMedia?.('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

/** What this browser can do. iPhone and iPad only allow push from the Home Screen app. */
export function pushSupport(): PushSupport {
  const capable = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  if (isIOS() && !isStandalone()) return 'ios-install';
  if (!capable) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  return 'ready';
}

/** Registers the worker that shows notifications. Safe to call on every load. */
export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
  });
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob((base64url + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** Only the fields the API takes (no expirationTime). */
function body(sub: PushSubscription) {
  const j = sub.toJSON();
  return { endpoint: sub.endpoint, keys: { p256dh: j.keys?.p256dh ?? '', auth: j.keys?.auth ?? '' } };
}

async function registration(): Promise<ServiceWorkerRegistration> {
  return (await navigator.serviceWorker.getRegistration('/')) ?? navigator.serviceWorker.register('/sw.js', { scope: '/' });
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  if (pushSupport() !== 'ready') return null;
  const reg = await navigator.serviceWorker.getRegistration('/');
  return (await reg?.pushManager.getSubscription()) ?? null;
}

export class PushPermissionError extends Error {
  constructor(readonly permission: NotificationPermission) {
    super('Notifications not allowed');
    this.name = 'PushPermissionError';
  }
}

/** Asks permission (from a tap), subscribes this browser and saves it to the account. */
export async function enablePush(publicKey: string): Promise<void> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new PushPermissionError(permission);
  const reg = await registration();
  await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  const key = keyBytes(publicKey);
  const same = (a: ArrayBuffer | null) => !!a && new Uint8Array(a).every((b, i) => b === key[i]) && a.byteLength === key.length;
  if (sub && !same(sub.options.applicationServerKey)) {
    await sub.unsubscribe(); // the server's key changed: start over
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  await api('/me/push-subscriptions', { method: 'POST', body: body(sub) });
}

/** Re-saves an existing subscription, so the device follows whoever is signed in here. */
export async function syncPush(): Promise<boolean> {
  const sub = await currentSubscription();
  if (!sub) return false;
  await api('/me/push-subscriptions', { method: 'POST', body: body(sub) });
  return true;
}

export async function disablePush(): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) return;
  await api('/me/push-subscriptions', { method: 'DELETE', body: { endpoint: sub.endpoint } }).catch(() => {});
  await sub.unsubscribe();
}

/** On sign-out: stop this device getting the account's notices. Never blocks signing out. */
export async function forgetPushOnSignOut(): Promise<void> {
  try {
    await Promise.race([disablePush(), new Promise((r) => setTimeout(r, 1500))]);
  } catch {
    /* signing out matters more */
  }
}
