/*
 * Burnout League service worker (PRD-008 §9). Push notifications only: it
 * doesn't cache or intercept anything, so the app always loads fresh.
 */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

/** Only ever opens a page of this app: the path from the message, on this origin. */
function appUrl(raw) {
  try {
    const u = new URL(typeof raw === 'string' ? raw : '/inbox', self.location.origin);
    return new URL(u.pathname + u.search + u.hash, self.location.origin).href;
  } catch {
    return new URL('/inbox', self.location.origin).href;
  }
}

self.addEventListener('push', (event) => {
  let d = {};
  try {
    d = event.data ? event.data.json() : {};
  } catch {
    d = {};
  }
  const title = typeof d.title === 'string' && d.title ? d.title : 'Burnout League';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: typeof d.body === 'string' ? d.body : '',
      icon: '/icon-192.png',
      badge: '/badge-96.png',
      tag: typeof d.tag === 'string' ? d.tag : undefined,
      data: { url: appUrl(d.url) },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || appUrl('/inbox');
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const open = wins.find((c) => new URL(c.url).origin === self.location.origin);
      if (open) {
        await open.focus();
        if ('navigate' in open) await open.navigate(url).catch(() => {});
        return;
      }
      await self.clients.openWindow(url);
    })()
  );
});
