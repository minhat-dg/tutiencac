// Service worker: lưu khung ứng dụng để mở được khi không có mạng.
// Nội dung chương do trang đọc tự lưu trong IndexedDB, nên ở đây không lưu gói chương hay EPUB.
// Đổi VERSION khi thay danh sách CORE.
const VERSION = "v3";
const SHELL = `shell-${VERSION}`;
const RUNTIME = "runtime-v1";
const CORE = [
  "/", "/style.css", "/config.js", "/manifest.webmanifest",
  "/js/app.js", "/js/music.js", "/js/tts.js", "/js/epub.js", "/js/demo-data.js",
  "/icons/icon-192.png", "/icons/favicon-64.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== SHELL && k !== RUNTIME) await caches.delete(k);
    await self.clients.claim();
  })());
});

// Trả bản đã lưu ngay, đồng thời tải bản mới cho lần sau.
async function staleWhileRevalidate(req, cacheName, key = req) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(key, { ignoreSearch: true });
  const fresh = fetch(req).then((res) => {
    if (res.ok || res.type === "opaque") cache.put(key, res.clone());
    return res;
  }).catch(() => null);
  return cached || (await fresh) || Response.error();
}

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    return (await cache.match(req, { ignoreSearch: true })) || Response.error();
  }
}

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  if (cached) return cached;
  const res = await fetch(req);
  if (res.ok || res.type === "opaque") cache.put(req, res.clone());
  return res;
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Trang quản trị và Bunny Storage API luôn đi thẳng ra mạng.
  if (url.pathname.startsWith("/admin") || url.hostname.endsWith("storage.bunnycdn.com")) return;

  // Danh sách truyện: ưu tiên bản mới, mất mạng thì dùng bản đã lưu.
  if (url.pathname.endsWith("/catalog.json")) return e.respondWith(networkFirst(req, RUNTIME));
  // Ảnh bìa, phông chữ, thư viện JSZip: không đổi theo thời gian.
  if (/\/bia\//.test(url.pathname) || /fonts\.(googleapis|gstatic)\.com$/.test(url.hostname) || url.hostname === "cdnjs.cloudflare.com") {
    return e.respondWith(cacheFirst(req, RUNTIME));
  }
  if (url.origin === location.origin) {
    if (req.mode === "navigate") return e.respondWith(staleWhileRevalidate(req, SHELL, "/"));
    // chỉ lưu các file của ứng dụng, không lưu file lớn khác cùng trang
    if (/\.(js|css|png|webmanifest)$/.test(url.pathname)) return e.respondWith(staleWhileRevalidate(req, SHELL));
  }
});
