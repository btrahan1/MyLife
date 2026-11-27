/**
 * MyLife PWA Service Worker (Offline Cache & Background Sync)
 */

const CACHE_NAME = 'mylife-v1.4.11';
const STATIC_ASSETS = [
    './',
    './index.html',
    './manifest.json',
    './css/mylife.css',
    './js/app.js',
    './js/db.js',
    './js/ai.js',
    './js/voice.js',
    './js/statementParser.js',
    './js/sync.js',
    './coi-serviceworker.js',
    './vendor/sql-wasm.js',
    './vendor/sql-wasm.wasm',
    './vendor/pdf.min.js',
    './vendor/pdf.worker.min.js',
    './icons/icon.svg',
    './icons/icon-192.png',
    './icons/icon-512.png'
];

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => {
            return cache.addAll(STATIC_ASSETS);
        }).then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys => {
            return Promise.all(
                keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
            );
        }).then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', event => {
    // Only cache GET requests
    if (event.request.method !== 'GET') return;

    // Skip external API endpoints and WebLLM CDNs
    const url = new URL(event.request.url);
    if (url.port === '8081' || url.hostname.includes('api.openai.com') || url.hostname.includes('anthropic.com') ||
        url.hostname.includes('jsdelivr.net') || url.hostname.includes('esm.run') || url.hostname.includes('huggingface.co') || url.hostname.includes('mlc.ai')) {
        return;
    }

    event.respondWith(
        caches.match(event.request).then(cached => {
            if (cached) return cached;
            return fetch(event.request).then(response => {
                if (!response || response.status !== 200 || response.type !== 'basic') {
                    return response;
                }
                const responseToCache = response.clone();
                caches.open(CACHE_NAME).then(cache => {
                    cache.put(event.request, responseToCache);
                });
                return response;
            }).catch(() => {
                // If offline and requesting page, return index.html
                if (event.request.headers.get('accept')?.includes('text/html')) {
                    return caches.match('./index.html');
                }
            });
        })
    );
});
