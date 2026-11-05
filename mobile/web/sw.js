// Service worker of the browser build: Web Push → a system notification; a tap opens the place it points at.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))
self.addEventListener('push', (e) => {
  let data = { title: 'Assistant', body: '' }
  try { data = e.data.json() } catch { data.body = e.data ? e.data.text() : '' }
  e.waitUntil(self.registration.showNotification(data.title, { body: data.body, tag: data.tag || undefined, renotify: Boolean(data.tag), data: { url: data.url || '/' } }))
})
self.addEventListener('notificationclick', (e) => {
  e.notification.close()
  const url = (e.notification.data && e.notification.data.url) || '/'
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) if ('focus' in c) { c.postMessage({ type: 'notification', url }); return c.focus() }
    // the place is the app's (/threads/…), not a page of the server: the app opens it (web/host.js launch.params)
    return self.clients.openWindow('/?open=' + encodeURIComponent(url))
  }))
})
