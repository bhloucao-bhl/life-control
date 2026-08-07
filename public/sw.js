// Service worker do Life Control: cacheia o "shell" do app (HTML de navegação
// + JS/CSS do Next) pra abrir mesmo sem rede. Não intercepta /api/* nem
// domínios externos (Supabase, Anthropic, Google...) — esses seguem indo
// direto pra rede e falham normalmente quando offline, como antes; a
// camada de dados (IndexedDB, em page.js) já trata esse caso.
const SW_VERSION = 'v1';
const SHELL_CACHE = 'lcc-shell-' + SW_VERSION;
const RUNTIME_CACHE = 'lcc-runtime-' + SW_VERSION;

self.addEventListener('install', () => { self.skipWaiting(); });

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== SHELL_CACHE && k !== RUNTIME_CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(SHELL_CACHE);
        cache.put('/', fresh.clone());
        return fresh;
      } catch (e) {
        const cache = await caches.open(SHELL_CACHE);
        return (await cache.match('/')) || (await cache.match(req)) || Response.error();
      }
    })());
    return;
  }

  if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith((async () => {
      const cache = await caches.open(RUNTIME_CACHE);
      const cached = await cache.match(req);
      if (cached) return cached;
      try {
        const fresh = await fetch(req);
        cache.put(req, fresh.clone());
        return fresh;
      } catch (e) { return cached || Response.error(); }
    })());
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(RUNTIME_CACHE);
    const cached = await cache.match(req);
    const network = fetch(req).then((res) => { cache.put(req, res.clone()); return res; }).catch(() => null);
    return cached || (await network) || Response.error();
  })());
});
