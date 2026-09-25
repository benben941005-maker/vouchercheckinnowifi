// Service worker for the Voucher Check-In / Check-Out app.
//
// Purpose: let the app OPEN even with zero network, as long as it has been
// opened at least once before while online (which installs this cache).
// Firebase sync still genuinely needs a live connection, but name-card
// scanning now has a local (in-browser) fallback via PaddleOCR
// (@paddlejs-models/ocr) for when Google Vision can't be reached — see the
// "cache everything except live API calls" fetch handling below — so staff
// can keep scanning (with lower accuracy) instead of only being able to
// fall back to manual name entry + signature + check-in/out (which already
// has its own offline-sync fallback built into the app).
//
// Bump CACHE_NAME whenever you want to force everyone's cached copy to
// refresh (e.g. after a meaningful update to index.html) — the old cache is
// deleted automatically on the next activate.
const CACHE_NAME = 'voucher-checkin-v7';

// This one service worker now covers FOUR separate pages in this repo:
// index.html (phone check-in counter), scan_station.html (computer scan
// station), local_checkin.html (fully offline computer check-in, no
// Firebase at all) and qr_sign.html (phone/iPad-side signature capture,
// paired with local_checkin.html's QR handoff feature — also no Firebase).
// Each is listed by its own path here — and the fetch handler below
// caches/serves each by its OWN url, never assuming "the page" means
// index.html — so opening any of the four directly with zero network
// still gets that same page back, not one of the others.
const APP_SHELL_URLS = [
  './',
  './index.html',
  './scan_station.html',
  './local_checkin.html',
  './qr_sign.html',
  'https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.4.0/exceljs.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
  'https://www.gstatic.com/firebasejs/10.7.1/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore-compat.js',
  'https://cdn.jsdelivr.net/npm/@paddlejs-models/ocr@1.2.4/lib/index.js',
  'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js',
  'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js'
];

// PaddleOCR (the local/offline OCR fallback) downloads its own model/weight
// files on first use, and the exact hosts/file names it uses internally
// aren't something this app controls or wants to hard-code. So instead of
// an allow-list, this uses a short DENY-list of hosts that must always stay
// LIVE (Firestore sync and the Google Vision API itself — caching those
// would mean showing stale data or a stale scan result). Every other GET
// request — including whatever PaddleOCR's model download turns out to be —
// is cached the first time it succeeds (while online) and served from cache
// after that (see the fetch handler below). This is what lets local OCR
// keep working with zero network, as long as it has run at least once
// before — index.html "primes" it automatically the first time the app is
// opened online.
const ALWAYS_LIVE_HOSTS = [
  'firestore.googleapis.com',
  'vision.googleapis.com',
  'www.googleapis.com',
  'identitytoolkit.googleapis.com',
  'securetoken.googleapis.com'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      // Cache each URL independently so one failure (e.g. a transient
      // network hiccup during the very first install) doesn't stop the
      // others from being cached.
      return Promise.all(APP_SHELL_URLS.map(url =>
        fetch(url, { cache: 'reload' })
          .then(resp => {
            if(resp && (resp.ok || resp.type === 'opaque')){
              return cache.put(url, resp);
            }
          })
          .catch(() => { /* ignore — best effort at install time */ })
      ));
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(names => Promise.all(names.filter(n => n !== CACHE_NAME).map(n => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if(req.method !== 'GET') return;

  // Loading a page itself: try the network first (so any update to that
  // page is picked up immediately whenever there IS a connection), and only
  // fall back to ITS OWN cached copy when the network request fails — keyed
  // by the actual request, never a hard-coded './' — that's the actual
  // "open with zero network" case this exists for. Falls back to
  // index.html only as a last resort, for a URL that was never cached at
  // all (e.g. the very first visit happened offline, which shouldn't
  // normally occur).
  if(req.mode === 'navigate'){
    event.respondWith(
      fetch(req)
        .then(resp => {
          // Clone SYNCHRONOUSLY, right here, before returning resp to the
          // browser. caches.open() is itself async — if the clone happened
          // inside its .then() callback instead, the browser could already
          // be reading resp's body by the time that callback finally runs,
          // and resp.clone() throws ("Response body is already used").
          const respClone = resp.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(req, respClone));
          return resp;
        })
        .catch(() => caches.match(req).then(cached => cached || caches.match('./index.html')))
    );
    return;
  }

  // The JS libraries the page depends on rarely change (their URLs are
  // pinned to a specific version), so these are cache-first: instant load,
  // no network round-trip needed once cached, with a network fetch (that
  // also refreshes the cache) as the fallback for anything not cached yet.
  if(APP_SHELL_URLS.includes(req.url)){
    event.respondWith(
      caches.match(req).then(cached => {
        if(cached) return cached;
        return fetch(req).then(resp => {
          if(resp && resp.ok){
            const respClone = resp.clone(); // clone synchronously — see the note in the navigate branch above
            caches.open(CACHE_NAME).then(cache => cache.put(req, respClone));
          }
          return resp;
        });
      })
    );
    return;
  }

  // Firestore sync and the Google Vision OCR calls must always hit the real
  // network — caching either would mean showing stale check-in data or
  // replaying an old scan result. Both already have their own
  // fallback/retry handling in the app itself when they fail.
  try{
    const url = new URL(req.url);
    if(ALWAYS_LIVE_HOSTS.includes(url.hostname)) return;
  }catch(e){ /* malformed/opaque request URL — treat as cacheable below */ }

  // Everything else — PaddleOCR's model/weight files (wherever they end up
  // being hosted), any other library asset, anything not explicitly listed
  // above — cache-first with the same "cache once, reuse forever" strategy
  // as the app shell: instant load once cached, with a network fetch (that
  // also populates the cache) as the fallback the first time.
  event.respondWith(
    caches.match(req).then(cached => {
      if(cached) return cached;
      return fetch(req).then(resp => {
        if(resp && (resp.ok || resp.type === 'opaque')){
          const respClone = resp.clone(); // clone synchronously — see the note in the navigate branch above
          caches.open(CACHE_NAME).then(cache => cache.put(req, respClone));
        }
        return resp;
      });
    })
  );
});
