'use strict';

const CACHE_NAME = 'workbench-shell-v20261113';
const BASE = new URL('./', self.location.href);

const SHELL = [
  './',
  './index.html',
  './assets/tokens.css?v=20261113',
  './assets/ambient-gl.js',
  './styles.css?v=20261028',
  './app.js?v=20261028',
  './reader/store.js',
  './manifest.webmanifest',
  './icon.svg',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
];

const SHELL_PATHS = new Set(
  SHELL.filter((path) => !path.endsWith('/') && path !== './index.html')
    .map((path) => new URL(path, BASE).pathname)
);

const INDEX_URL = new URL('./index.html', BASE).href;

function isShellAsset(url) {
  return SHELL_PATHS.has(url.pathname);
}

function staleWhileRevalidate(request) {
  return caches.open(CACHE_NAME).then((cache) =>
    cache.match(request).then((cached) => {
      const networkFetch = fetch(request).then((response) => {
        if (response && response.ok) {
          cache.put(request, response.clone());
        }
        return response;
      }).catch(() => cached);
      return cached || networkFetch;
    })
  );
}

function networkFirstNavigation(request) {
  return fetch(request).then((response) => {
    if (response && response.ok) {
      const copy = response.clone();
      caches.open(CACHE_NAME).then((cache) => cache.put(INDEX_URL, copy));
    }
    return response;
  }).catch(() => caches.match(INDEX_URL).then((cached) => cached || caches.match(BASE.href)));
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys
        .filter((key) => key.startsWith('workbench-shell-') && key !== CACHE_NAME)
        .map((key) => caches.delete(key))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // 阅读器 / 围棋各自有独立页面与资源，不拦截。
  // reader/store.js 是“继续阅读”卡片需要的共享脚本，单独缓存。
  if (url.pathname.startsWith('/reader/') && url.pathname !== '/reader/store.js') return;
  if (url.pathname.startsWith('/weiqi/')) return;
  if (url.pathname.startsWith('/music/')) return;

  if (request.mode === 'navigate') {
    if (url.pathname !== '/' && url.pathname !== '/index.html') return;
    event.respondWith(networkFirstNavigation(request));
    return;
  }

  if (isShellAsset(url)) {
    event.respondWith(staleWhileRevalidate(request));
  }
});
