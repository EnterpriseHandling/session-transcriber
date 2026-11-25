// Service worker for Session Transcriber.
// Three jobs:
//  1. Keep a copy of the app (and speech models) on the device so it works offline.
//  2. Refuse every request that is not a plain download from this app's own address,
//     so nothing running in the app can send data anywhere else.
//  3. Add the security headers that let the speech engine use several processor cores.

const BUILD = '__BUILD__';
const SHELL = `st-shell-${BUILD}`;
const MODELS = 'st-models-__MODELS__';
const SHELL_FILES = __SHELL_FILES__;

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval' blob:",
  "worker-src 'self' blob:",
  "connect-src 'self' blob: data:",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const EXTRA_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy': CSP,
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    await cache.addAll(SHELL_FILES.map((f) => new Request(f, { cache: 'reload' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter((n) => n.startsWith('st-') && n !== SHELL && n !== MODELS)
      .map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || event.request.method !== 'GET') {
    event.respondWith(Response.error());
    return;
  }
  event.respondWith(handle(event.request, url));
});

async function handle(request, url) {
  const isModel = url.pathname.includes('/models/') && !url.pathname.endsWith('/manifest.json');
  const key = request.mode === 'navigate' ? self.registration.scope : url.origin + url.pathname;

  const cache = await caches.open(isModel ? MODELS : SHELL);
  const cached = await cache.match(key);
  if (cached) return withHeaders(cached);

  const response = await fetch(url.origin + url.pathname, { credentials: 'omit' });
  if (response.ok && isModel) {
    try { await cache.put(key, response.clone()); } catch (_) { /* storage full: carry on without caching */ }
  }
  return withHeaders(response);
}

function withHeaders(response) {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(EXTRA_HEADERS)) headers.set(k, v);
  const bodyless = [101, 204, 205, 304].includes(response.status);
  return new Response(bodyless ? null : response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
