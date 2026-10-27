// Service worker: lưu khung ứng dụng để mở được khi không có mạng.
// Nội dung chương do trang đọc tự lưu trong IndexedDB, nên ở đây không lưu gói chương hay EPUB.
// Đổi VERSION khi thay danh sách CORE.
const VERSION = "v14";
const SHELL = `shell-${VERSION}`;
// v1 lưu ảnh bìa/thư viện CDN dạng opaque (no-cors): trang bật COEP thì trình duyệt chặn các bản đó
// → đổi tên để activate xoá sạch, từ nay chỉ lưu bản tải bằng CORS.
const RUNTIME = "runtime-v2";
const CORE = [
  "/", "/style.css", "/config.js", "/manifest.webmanifest",
  "/js/app.js", "/js/ai-voice/audio-store.js", "/js/ai-voice/nano-worker.js", "/js/ai-voice/vi-frontend.js", "/js/tts.js", "/js/cloud.js", "/js/epub.js", "/js/mobi.js", "/js/demo-data.js",
  "/icons/icon-192.png", "/icons/favicon-32.png", "/icons/favicon-16.png", "/brand/wordmark.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    // chỉ dọn cache của chính service worker; cache khác (vd model giọng AI "ai-voice-models-…", ~280 MB) phải giữ nguyên
    for (const k of await caches.keys()) {
      if (/^(shell|runtime)-/.test(k) && k !== SHELL && k !== RUNTIME) await caches.delete(k);
    }
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

// File khác domain (ảnh bìa Bunny, phông, thư viện CDN): tải bằng CORS chứ không no-cors.
// Trang có header Cross-Origin-Embedder-Policy nên phản hồi opaque do service worker trả về bị chặn
// (ảnh bìa hiện biểu tượng hỏng). Các máy chủ này đều trả CORS. Lỗi CORS thì để trình duyệt tự tải.
async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req.url);
  if (cached) return cached;
  let res;
  try { res = await fetch(req.url, { mode: "cors", credentials: "omit" }); }
  catch { return fetch(req); }
  if (res.ok) cache.put(req.url, res.clone());
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
  // Ảnh bìa, phông chữ, thư viện JSZip / Supabase (phiên bản cố định): không đổi theo thời gian.
  if (/\/bia\//.test(url.pathname) || /fonts\.(googleapis|gstatic)\.com$/.test(url.hostname) ||
      url.hostname === "cdnjs.cloudflare.com" || url.hostname === "cdn.jsdelivr.net") {
    return e.respondWith(cacheFirst(req, RUNTIME));
  }
  if (url.origin === location.origin) {
    if (req.mode === "navigate") return e.respondWith(staleWhileRevalidate(req, SHELL, "/"));
    // chỉ lưu các file của ứng dụng, không lưu file lớn khác cùng trang
    if (/\.(js|css|png|webmanifest)$/.test(url.pathname) && !url.pathname.startsWith("/_")) return e.respondWith(staleWhileRevalidate(req, SHELL));
  }
});
