(() => {
  "use strict";

  const CFG = window.TT_CONFIG || {};
  const CDN = (CFG.cdnBase || "").replace(/\/+$/, "");
  const DEMO = !CDN;

  const $app = document.getElementById("app");
  const $toast = document.getElementById("toast");

  // ---------- local storage (dữ liệu người đọc chỉ nằm trên máy họ) ----------
  const LS = {
    get(key, fallback) {
      try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); }
      catch { return fallback; }
    },
    set(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch {} },
  };
  const DEFAULT_SETTINGS = { theme: "sepia", fontSize: 20, lineHeight: 1.8, font: "serif", width: 720 };
  const settings = Object.assign({}, DEFAULT_SETTINGS, LS.get("settings", {}));
  const saveSettings = () => LS.set("settings", settings);
  // progress: { [novelId]: { ch, scroll, t, read: [chapterIdx...] } }
  let progress = LS.get("progress", {});
  const saveProgress = () => LS.set("progress", progress);
  let shelf = new Set(LS.get("shelf", []));
  const saveShelf = () => LS.set("shelf", [...shelf]);

  // ---------- IndexedDB: whole EPUBs ("books") and chapter packs ("chunks") read on this device ----------
  function store(name, keyPath) {
    return {
      async tx(mode, fn) {
        const db = await IDB.open();
        return new Promise((resolve, reject) => {
          const t = db.transaction(name, mode);
          const r = fn(t.objectStore(name));
          t.oncomplete = () => resolve(r && r.result);
          t.onerror = () => reject(t.error);
        });
      },
      get(k) { return this.tx("readonly", (s) => s.get(k)).catch(() => null); },
      put(v) { return this.tx("readwrite", (s) => s.put(v)); },
      clear() { return this.tx("readwrite", (s) => s.clear()); },
      keys() { return this.tx("readonly", (s) => s.getAllKeys()).catch(() => []); },
      keyPath,
    };
  }
  const IDB = {
    _db: null,
    open() {
      if (this._db) return Promise.resolve(this._db);
      return new Promise((resolve, reject) => {
        const req = indexedDB.open("tutiencac-books", 2);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains("books")) db.createObjectStore("books", { keyPath: "id" });
          if (!db.objectStoreNames.contains("chunks")) db.createObjectStore("chunks", { keyPath: "key" });
        };
        req.onsuccess = () => resolve((this._db = req.result));
        req.onerror = () => reject(req.error);
      });
    },
  };
  const Books = store("books");
  const Chunks = store("chunks");

  // ---------- helpers ----------
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const cdnUrl = (p) => /^https?:\/\//.test(p) ? p : `${CDN}/${String(p).replace(/^\/+/, "").split("/").map(encodeURIComponent).join("/")}`;

  function slug(s) {
    return String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/gi, "d")
      .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "truyen";
  }
  const prettify = (file) => file.replace(/^.*\//, "").replace(/\.epub$/i, "").replace(/[-_]+/g, " ").trim();

  function toast(msg) {
    $toast.textContent = msg;
    $toast.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => $toast.classList.remove("show"), 2400);
  }

  function hashColors(str) {
    let h = 0;
    for (const c of str) h = (h * 31 + c.codePointAt(0)) >>> 0;
    const hue = h % 360;
    return [`hsl(${hue} 45% 25%)`, `hsl(${(hue + 40) % 360} 50% 50%)`];
  }

  function timeAgo(t) {
    const s = (Date.now() - t) / 1000;
    if (s < 60) return "vừa xong";
    if (s < 3600) return Math.floor(s / 60) + " phút trước";
    if (s < 86400) return Math.floor(s / 3600) + " giờ trước";
    return Math.floor(s / 86400) + " ngày trước";
  }

  // ---------- catalog ----------
  let novels = [];
  const books = new Map(); // id -> parsed book (memory cache)
  const coverUrls = new Map(); // id -> object URL of a cover extracted from the EPUB

  function normalize(e) {
    const file = String(e.file || "");
    return {
      id: e.id ? slug(e.id) : slug(file.replace(/^.*\//, "").replace(/\.epub$/i, "")),
      file,
      // Admin-published novels are split into packs: <dir>/toc.json + <dir>/c<k>.json
      dir: String(e.dir || "").replace(/\/+$/, ""),
      chunk: +e.chunk || 50,
      words: +e.words || 0,
      title: e.title || prettify(file || e.id || ""),
      author: e.author || "",
      tags: [].concat(e.tags || []),
      status: e.status || "",
      description: e.description || "",
      cover: e.cover ? cdnUrl(e.cover) : null,
      chapters: +e.chapters || 0,
      updated: String(e.updated || ""),
    };
  }

  async function loadCatalog() {
    if (DEMO) {
      novels = window.SAMPLE_NOVELS.map((n) => ({
        ...normalize({ id: n.id, file: n.id, title: n.title, author: n.author, tags: n.tags, status: n.status, description: n.description, chapters: n.chapters.length }),
        colors: n.colors, demo: n,
      }));
      return [];
    }
    // catalog.json là file duy nhất thay đổi thường xuyên: chặn cache bằng query theo phút.
    const r = await fetch(cdnUrl("catalog.json") + "?v=" + Math.floor(Date.now() / 60000), { cache: "no-cache" });
    if (!r.ok) throw new Error(`Không tải được catalog.json (${r.status})`);
    const cat = await r.json();
    applySite((!Array.isArray(cat) && cat.site) || {});
    const list = Array.isArray(cat) ? cat : cat.novels || [];
    novels = list.filter((e) => e && (e.file || e.dir) && !e.hidden).map(normalize);
    const seen = new Set();
    novels = novels.filter((n) => !seen.has(n.id) && seen.add(n.id));
    return Array.isArray(cat) ? [] : cat.music || [];
  }
  const findNovel = (id) => novels.find((n) => n.id === id);

  // Tên trang và thông báo do admin đặt trong catalog.json
  let site = {};
  let siteName = "Tu Tiên Các";
  function applySite(s) {
    site = s;
    if (s.name) {
      siteName = s.name;
      document.title = s.name;
      const b = document.querySelector(".brand-text");
      if (b) b.textContent = " " + s.name;
    }
  }

  // ---------- books (EPUB) ----------
  async function download(url, onProgress) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Không tải được truyện (${r.status})`);
    const stamp = [r.headers.get("last-modified"), r.headers.get("content-length")].join("|");
    const total = +r.headers.get("content-length") || 0;
    if (!r.body || !total) return { buf: await r.arrayBuffer(), stamp };
    const reader = r.body.getReader();
    const parts = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      got += value.length;
      onProgress && onProgress(Math.min(1, got / total));
    }
    return { buf: await new Blob(parts).arrayBuffer(), stamp };
  }

  // When catalog.json carries no "updated" value, check the file headers to notice a replaced EPUB.
  async function remoteStamp(n) {
    try {
      const r = await fetch(cdnUrl(n.file), { method: "HEAD", cache: "no-cache" });
      return r.ok ? [r.headers.get("last-modified"), r.headers.get("content-length")].join("|") : null;
    } catch { return null; }
  }

  async function getBook(n, onProgress) {
    if (books.has(n.id)) return books.get(n.id);
    let book;
    if (n.demo) {
      book = { id: n.id, chapters: n.demo.chapters };
    } else {
      const cached = await Books.get(n.id);
      let fresh = cached && cached.file === n.file && cached.updated === n.updated;
      if (fresh && !n.updated) {
        const s = await remoteStamp(n);
        fresh = !s || s === cached.stamp;
      }
      if (fresh) book = cached;
      else {
        const { buf, stamp } = await download(cdnUrl(n.file), onProgress);
        const p = await window.Epub.parse(buf);
        book = {
          id: n.id, file: n.file, updated: n.updated, stamp,
          chapters: p.chapters, cover: p.cover,
          meta: { title: p.title, author: p.author, description: p.description, tags: p.tags },
        };
        Books.put(book).catch(() => toast("Bộ nhớ trình duyệt đầy, truyện sẽ phải tải lại lần sau"));
      }
    }
    books.set(n.id, book);
    fillFromBook(n, book);
    return book;
  }

  // Use metadata inside the EPUB for anything catalog.json left empty.
  function fillFromBook(n, book) {
    const m = book.meta || {};
    if (n.title === prettify(n.file) && m.title) n.title = m.title;
    if (!n.author && m.author) n.author = m.author;
    if (!n.description && m.description) n.description = m.description;
    if (!n.tags.length && m.tags && m.tags.length) n.tags = m.tags.slice(0, 5);
    n.chapters = book.chapters.length;
    if (!n.cover && book.cover && !coverUrls.has(n.id)) coverUrls.set(n.id, URL.createObjectURL(book.cover));
  }

  // On startup, enrich the library from books already cached on this device.
  async function hydrateFromCache() {
    if (DEMO) return;
    const ids = new Set(await Books.keys());
    await Promise.all(novels.filter((n) => !n.dir && ids.has(n.id)).map(async (n) => {
      const b = await Books.get(n.id);
      if (b && b.file === n.file) fillFromBook(n, b);
    }));
  }

  // ---------- chapter source: packs on the CDN, a whole EPUB, or the demo data ----------
  const packs = new Map(); // "<dir>/<name>" -> parsed JSON (memory cache)

  // Packs live in versioned folders and never change, so a copy on this device is always valid.
  async function getPack(dir, name) {
    const key = `${dir}/${name}`;
    if (packs.has(key)) return packs.get(key);
    const job = (async () => {
      const saved = await Chunks.get(key);
      if (saved) return saved.data;
      const r = await fetch(cdnUrl(key));
      if (!r.ok) throw new Error(`Không tải được dữ liệu truyện (${r.status})`);
      const data = await r.json();
      Chunks.put({ key, data, t: Date.now() }).catch(() => {});
      return data;
    })();
    packs.set(key, job);
    try { return await job; } catch (e) { packs.delete(key); throw e; }
  }

  // Chapter titles, in order.
  async function getTitles(n, onProgress) {
    if (n.demo) return n.demo.chapters.map((c) => c.title);
    if (n.dir) {
      const toc = await getPack(n.dir, "toc.json");
      n.chapters = toc.titles.length;
      if (toc.chunk) n.chunk = toc.chunk;
      return toc.titles;
    }
    return (await getBook(n, onProgress)).chapters.map((c) => c.title);
  }

  async function getChapter(n, i) {
    if (n.demo) return n.demo.chapters[i];
    if (!n.dir) return (await getBook(n)).chapters[i];
    const k = Math.floor(i / n.chunk);
    const pack = await getPack(n.dir, `c${k}.json`);
    // read ahead: fetch the next pack while the reader is near the end of this one
    if (i % n.chunk >= n.chunk - 3 && (k + 1) * n.chunk < n.chapters) getPack(n.dir, `c${k + 1}.json`).catch(() => {});
    return pack[i - k * n.chunk];
  }
  const isLoaded = (n) => n.demo || (n.dir ? packs.has(`${n.dir}/toc.json`) : books.has(n.id));

  // ---------- views ----------
  function coverHTML(n) {
    const img = n.cover || coverUrls.get(n.id);
    if (img) return `<div class="cover img"><img src="${esc(img)}" alt="" loading="lazy"></div>`;
    const [a, b] = n.colors || hashColors(n.title);
    return `<div class="cover" style="background:linear-gradient(160deg, ${a}, ${b})">
      <div class="ct">${esc(n.title)}</div><div class="ca">${esc(n.author || "Khuyết danh")}</div></div>`;
  }

  function cardHTML(n) {
    const p = progress[n.id];
    const total = n.chapters;
    const pct = p && total ? Math.round(((p.ch + 1) / total) * 100) : 0;
    const sub = p
      ? `Chương ${p.ch + 1}${total ? "/" + total : ""} · ${timeAgo(p.t)}`
      : [total ? `${total} chương` : "", n.status].filter(Boolean).join(" · ");
    return `<a class="card" href="#/novel/${encodeURIComponent(n.id)}">
      ${coverHTML(n)}
      <div class="name">${esc(n.title)}</div>
      ${p ? `<div class="progress"><div style="width:${pct}%"></div></div>` : ""}
      <div class="meta">${esc(sub)}</div>
    </a>`;
  }

  const libState = { q: "", tag: "" };

  function viewHome() {
    const allTags = [...new Set(novels.flatMap((n) => n.tags))];
    const q = libState.q.trim().toLowerCase();
    const list = novels.filter((n) =>
      (!libState.tag || n.tags.includes(libState.tag)) &&
      (!q || n.title.toLowerCase().includes(q) || n.author.toLowerCase().includes(q))
    );
    const recent = novels.filter((n) => progress[n.id]).sort((a, b) => progress[b.id].t - progress[a.id].t).slice(0, 6);

    $app.innerHTML = `
      ${DEMO ? `<div class="notice">Đang chạy chế độ demo với truyện mẫu. Điền <code>cdnBase</code> trong <code>config.js</code> để đọc truyện từ Bunny.</div>` : ""}
      ${site.notice ? `<div class="notice">${esc(site.notice)}</div>` : ""}
      ${recent.length && !q && !libState.tag ? `<h2 class="section-title">Đọc tiếp</h2><div class="grid">${recent.map(cardHTML).join("")}</div>` : ""}
      <h2 class="section-title">Thư viện</h2>
      <div class="toolbar"><input id="q" type="search" placeholder="Tìm tên truyện, tác giả…" value="${esc(libState.q)}"></div>
      ${allTags.length ? `<div class="tags">
        <button class="tag ${!libState.tag ? "active" : ""}" data-tag="">Tất cả</button>
        ${allTags.map((t) => `<button class="tag ${libState.tag === t ? "active" : ""}" data-tag="${esc(t)}">${esc(t)}</button>`).join("")}
      </div>` : ""}
      ${list.length ? `<div class="grid">${list.map(cardHTML).join("")}</div>` : `<div class="empty">${novels.length ? "Không tìm thấy truyện nào." : "Chưa có truyện nào."}</div>`}
    `;
    const qi = document.getElementById("q");
    qi.addEventListener("input", () => {
      libState.q = qi.value;
      const pos = qi.selectionStart;
      viewHome();
      const el = document.getElementById("q");
      el.focus(); el.setSelectionRange(pos, pos);
    });
    $app.querySelectorAll("[data-tag]").forEach((b) =>
      b.addEventListener("click", () => { libState.tag = b.dataset.tag; viewHome(); })
    );
  }

  function viewShelf() {
    const list = novels.filter((n) => shelf.has(n.id) || progress[n.id])
      .sort((a, b) => ((progress[b.id] || {}).t || 0) - ((progress[a.id] || {}).t || 0));
    $app.innerHTML = `
      <h2 class="section-title">Tủ sách của bạn</h2>
      ${list.length ? `<div class="grid">${list.map(cardHTML).join("")}</div>`
        : `<div class="empty">Tủ sách trống. Chọn truyện trong <a href="#/" class="link">Thư viện</a> để bắt đầu.</div>`}
      <h2 class="section-title">Dữ liệu trên máy này</h2>
      <p class="hint">Tiến độ đọc, tủ sách và cài đặt chỉ lưu trong trình duyệt này. Sao lưu để chuyển sang máy khác.</p>
      <div class="actions">
        <button class="btn ghost" id="exportBtn">⤓ Sao lưu</button>
        <button class="btn ghost" id="importBtn">⤒ Khôi phục</button>
        ${DEMO ? "" : `<button class="btn ghost" id="clearBtn">Xoá truyện đã tải</button>`}
        <input type="file" id="importFile" accept=".json,application/json" hidden>
      </div>
    `;
    document.getElementById("exportBtn").onclick = () => {
      const data = { app: "tutiencac", v: 1, progress, shelf: [...shelf], settings, music: LS.get("music", {}) };
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: "application/json" }));
      a.download = `tutiencac-saoluu-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    };
    const $file = document.getElementById("importFile");
    document.getElementById("importBtn").onclick = () => $file.click();
    $file.onchange = async () => {
      try {
        const d = JSON.parse(await $file.files[0].text());
        if (d.app !== "tutiencac") throw new Error();
        // keep whichever entry was read more recently
        for (const [id, p] of Object.entries(d.progress || {})) if (!progress[id] || progress[id].t < p.t) progress[id] = p;
        (d.shelf || []).forEach((id) => shelf.add(id));
        Object.assign(settings, d.settings || {});
        saveProgress(); saveShelf(); saveSettings();
        toast("Đã khôi phục dữ liệu");
        viewShelf();
      } catch { toast("File sao lưu không hợp lệ"); }
    };
    const clear = document.getElementById("clearBtn");
    if (clear) clear.onclick = async () => {
      await Promise.all([Books.clear(), Chunks.clear()]);
      books.clear();
      packs.clear();
      toast("Đã xoá các truyện tải về (tiến độ đọc vẫn giữ nguyên)");
    };
  }

  function chapterListHTML(n, titles) {
    const p = progress[n.id];
    const read = new Set(p ? p.read : []);
    return `<ul class="chapters">${titles.map((t, i) =>
      `<li><a href="#/read/${encodeURIComponent(n.id)}/${i}" class="${p && p.ch === i ? "current" : read.has(i) ? "read" : ""}">${esc(t)}</a></li>`
    ).join("")}</ul>`;
  }

  async function viewNovel(id, stale) {
    const n = findNovel(id);
    if (!n) return notFound();
    const render = (titles) => {
      const p = progress[n.id];
      const book = books.get(n.id) || (n.demo && n.demo);
      const words = n.words || (book ? book.chapters.reduce((s, c) => s + c.content.split(/\s+/).length, 0) : 0);
      $app.innerHTML = `
        <div class="detail">
          <div>${coverHTML(n)}</div>
          <div>
            <h1>${esc(n.title)}</h1>
            <div class="author">Tác giả: ${esc(n.author || "Khuyết danh")}</div>
            <div class="tags">${n.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</div>
            <div class="stat">
              ${n.chapters ? `<span>📖 ${n.chapters} chương</span>` : ""}
              ${words ? `<span>✍️ ${words.toLocaleString("vi-VN")} chữ</span>` : ""}
              ${n.status ? `<span>⏳ ${esc(n.status)}</span>` : ""}
            </div>
            <div class="actions">
              <a class="btn" href="#/read/${encodeURIComponent(n.id)}/${p ? p.ch : 0}">${p ? `Đọc tiếp chương ${p.ch + 1}` : "Đọc từ đầu"}</a>
              ${p ? `<a class="btn ghost" href="#/read/${encodeURIComponent(n.id)}/0">Đọc từ đầu</a>` : ""}
              <button class="btn ghost" id="shelfBtn">${shelf.has(n.id) ? "✓ Trong tủ sách" : "＋ Thêm vào tủ"}</button>
            </div>
            <div class="desc">${esc(n.description)}</div>
          </div>
        </div>
        <h2 class="section-title">Danh sách chương</h2>
        ${titles ? chapterListHTML(n, titles) : `<div class="loading" id="dl"><div class="bar"><div id="dlBar"></div></div><span id="dlText">Đang tải truyện…</span></div>`}
      `;
      document.getElementById("shelfBtn").addEventListener("click", (e) => {
        if (shelf.has(n.id)) { shelf.delete(n.id); e.target.textContent = "＋ Thêm vào tủ"; toast("Đã bỏ khỏi tủ sách"); }
        else { shelf.add(n.id); e.target.textContent = "✓ Trong tủ sách"; toast("Đã thêm vào tủ sách"); }
        saveShelf();
      });
    };

    if (!isLoaded(n)) render(null);
    const titles = await getTitles(n, (r) => {
      const bar = document.getElementById("dlBar"), txt = document.getElementById("dlText");
      if (bar) bar.style.width = Math.round(r * 100) + "%";
      if (txt) txt.textContent = `Đang tải truyện… ${Math.round(r * 100)}%`;
    });
    if (!stale()) render(titles);
  }

  function notFound(msg) {
    document.body.classList.remove("reading");
    $app.innerHTML = `<div class="empty">${esc(msg || "Không tìm thấy truyện.")} <a href="#/" class="link">Về thư viện</a></div>`;
  }

  // ---------- reader ----------
  let readerCleanup = null;
  const FONTS = { serif: '"Noto Serif", Georgia, serif', sans: '"Be Vietnam Pro", system-ui, sans-serif', mono: "ui-monospace, Consolas, monospace" };

  async function viewReader(id, chIdx, stale) {
    const n = findNovel(id);
    if (!n) return notFound();
    const loading = setTimeout(() => {
      if (!stale()) $app.innerHTML = `<div class="loading"><span id="dlText">Đang tải truyện…</span></div>`;
    }, 150);
    let titles, ch;
    try {
      titles = await getTitles(n, (r) => {
        const t = document.getElementById("dlText");
        if (t) t.textContent = `Đang tải truyện… ${Math.round(r * 100)}%`;
      });
      chIdx = Math.max(0, Math.min(titles.length - 1, chIdx | 0));
      ch = await getChapter(n, chIdx);
    } finally { clearTimeout(loading); }
    if (stale()) return;
    if (!ch) return notFound("Không tìm thấy chương này.");

    document.body.classList.add("reading");
    const paras = ch.content.split(/\n+/).map((s) => s.trim()).filter(Boolean);
    const base = `#/read/${encodeURIComponent(n.id)}/`;
    const hasPrev = chIdx > 0, hasNext = chIdx < titles.length - 1;
    document.title = `${ch.title} · ${n.title}`;

    $app.innerHTML = `
      <div class="reader" data-theme="${settings.theme}">
        <div class="rbar" id="rbar">
          <a class="ibtn" href="#/novel/${encodeURIComponent(n.id)}" title="Về trang truyện">←</a>
          <button class="ibtn" id="tocBtn" title="Mục lục">☰</button>
          <div class="ttl">${esc(n.title)} · ${esc(ch.title)}</div>
          <button class="ibtn music-btn" data-music title="Nhạc nền">♪</button>
          <button class="ibtn" id="setBtn" title="Tuỳ chỉnh">Aa</button>
        </div>
        <article class="rcontent" id="rcontent">
          <h2>${esc(ch.title)}</h2>
          <div class="body">${paras.map((p) => `<p>${esc(p)}</p>`).join("")}</div>
        </article>
        <div class="rnav">
          <button class="ibtn" id="prevBtn" ${hasPrev ? "" : "disabled"}>‹ Chương trước</button>
          <button class="ibtn" id="tocBtn2">Mục lục</button>
          <button class="ibtn" id="nextBtn" ${hasNext ? "" : "disabled"}>Chương sau ›</button>
        </div>
        <div class="rprogress" id="rprog"></div>

        <div class="backdrop" id="backdrop"></div>
        <aside class="panel left" id="tocPanel">
          <h3>Mục lục <button class="ibtn" data-close>✕</button></h3>
          <ul class="toc">${titles.map((t, i) => `<li><a href="${base}${i}" class="${i === chIdx ? "current" : ""}">${esc(t)}</a></li>`).join("")}</ul>
        </aside>
        <aside class="panel" id="setPanel">
          <h3>Tuỳ chỉnh <button class="ibtn" data-close>✕</button></h3>
          <div class="setrow"><label>Màu nền</label><div class="ctl">
            ${[["light", "#fff", "Trắng"], ["sepia", "#f4ecd8", "Giấy cũ"], ["green", "#dbe8d4", "Xanh lá"], ["dark", "#1c1a18", "Tối"], ["black", "#000", "Đen"]]
              .map(([k, c, l]) => `<button class="swatch ${settings.theme === k ? "active" : ""}" data-theme="${k}" style="background:${c}" title="${l}"></button>`).join("")}
          </div></div>
          <div class="setrow"><label>Cỡ chữ</label><div class="ctl">
            <button class="ibtn" data-fs="-1">A−</button><span class="val" id="fsVal">${settings.fontSize}</span><button class="ibtn" data-fs="1">A+</button>
          </div></div>
          <div class="setrow"><label>Giãn dòng</label><div class="ctl">
            ${[1.5, 1.8, 2.1, 2.4].map((v) => `<button class="seg ${settings.lineHeight === v ? "active" : ""}" data-lh="${v}">${v}</button>`).join("")}
          </div></div>
          <div class="setrow"><label>Phông chữ</label><div class="ctl">
            ${[["serif", "Có chân"], ["sans", "Không chân"], ["mono", "Đơn cách"]].map(([k, l]) => `<button class="seg ${settings.font === k ? "active" : ""}" data-font="${k}">${l}</button>`).join("")}
          </div></div>
          <div class="setrow"><label>Độ rộng trang</label><div class="ctl">
            ${[[600, "Hẹp"], [720, "Vừa"], [900, "Rộng"]].map(([v, l]) => `<button class="seg ${settings.width === v ? "active" : ""}" data-w="${v}">${l}</button>`).join("")}
          </div></div>
          <div class="setrow"><label>Nhạc nền</label><div class="ctl">
            <button class="seg" id="rMusicPlay">▶ Phát</button>
            <select class="rselect" id="rMusicTrack" aria-label="Chọn bài nhạc"></select>
          </div></div>
          <div class="setrow"><label for="rMusicVol">Âm lượng nhạc</label><input type="range" class="rrange" id="rMusicVol" min="0" max="100"></div>
          <div class="setrow"><label>Phím tắt</label><div class="hint">← → : chuyển chương<br>Chạm giữa màn hình : ẩn/hiện thanh công cụ</div></div>
        </aside>
      </div>
    `;
    syncMusicButtons();

    const $reader = $app.querySelector(".reader");
    const $content = document.getElementById("rcontent");
    function applyStyle() {
      $reader.dataset.theme = settings.theme;
      $content.style.fontSize = settings.fontSize + "px";
      $content.style.lineHeight = settings.lineHeight;
      $content.style.fontFamily = FONTS[settings.font];
      $content.style.setProperty("--r-width", settings.width + "px");
    }
    applyStyle();

    const $back = document.getElementById("backdrop");
    const closePanels = () => { $app.querySelectorAll(".panel.open").forEach((p) => p.classList.remove("open")); $back.classList.remove("open"); };
    const openPanel = (el) => { closePanels(); el.classList.add("open"); $back.classList.add("open"); };
    const tocPanel = document.getElementById("tocPanel");
    const openToc = () => { openPanel(tocPanel); tocPanel.querySelector(".current")?.scrollIntoView({ block: "center" }); };
    document.getElementById("tocBtn").onclick = openToc;
    document.getElementById("tocBtn2").onclick = openToc;
    document.getElementById("setBtn").onclick = () => openPanel(document.getElementById("setPanel"));
    $back.onclick = closePanels;
    $app.querySelectorAll("[data-close]").forEach((b) => (b.onclick = closePanels));

    const setPanel = document.getElementById("setPanel");
    setPanel.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      const group = (sel) => setPanel.querySelectorAll(sel).forEach((x) => x.classList.toggle("active", x === b));
      if (b.dataset.theme) { settings.theme = b.dataset.theme; group("[data-theme]"); }
      else if (b.dataset.fs) { settings.fontSize = Math.max(12, Math.min(40, settings.fontSize + +b.dataset.fs)); document.getElementById("fsVal").textContent = settings.fontSize; }
      else if (b.dataset.lh) { settings.lineHeight = +b.dataset.lh; group("[data-lh]"); }
      else if (b.dataset.font) { settings.font = b.dataset.font; group("[data-font]"); }
      else if (b.dataset.w) { settings.width = +b.dataset.w; group("[data-w]"); }
      else return;
      saveSettings(); applyStyle();
    });

    document.getElementById("rMusicPlay").onclick = () => window.Music.toggle();
    document.getElementById("rMusicTrack").onchange = (e) => window.Music.play(e.target.value);
    document.getElementById("rMusicVol").oninput = (e) => window.Music.setVolume(e.target.value / 100);
    syncReaderMusic();

    const go = (i) => { location.hash = base + i; };
    document.getElementById("prevBtn").onclick = () => hasPrev && go(chIdx - 1);
    document.getElementById("nextBtn").onclick = () => hasNext && go(chIdx + 1);

    // progress
    const prev = progress[n.id];
    const sameCh = prev && prev.ch === chIdx;
    const entry = progress[n.id] = { ch: chIdx, scroll: sameCh ? prev.scroll : 0, t: Date.now(), read: [...new Set([...(prev ? prev.read : []), chIdx])] };
    saveProgress();
    window.scrollTo(0, sameCh ? entry.scroll * (document.documentElement.scrollHeight - innerHeight) : 0);

    const $bar = document.getElementById("rbar");
    const $prog = document.getElementById("rprog");
    let lastY = scrollY, saveT;
    function onScroll() {
      const max = document.documentElement.scrollHeight - innerHeight;
      const r = max > 0 ? scrollY / max : 1;
      $prog.style.width = (r * 100) + "%";
      if (scrollY > lastY + 8 && scrollY > 80) $bar.classList.add("hidden");
      else if (scrollY < lastY - 8) $bar.classList.remove("hidden");
      lastY = scrollY;
      clearTimeout(saveT);
      saveT = setTimeout(() => { entry.scroll = r; entry.t = Date.now(); saveProgress(); }, 300);
    }
    function onKey(e) {
      if (e.target.matches("input, textarea")) return;
      if (e.key === "ArrowLeft" && hasPrev) go(chIdx - 1);
      else if (e.key === "ArrowRight" && hasNext) go(chIdx + 1);
      else if (e.key === "Escape") closePanels();
    }
    function onTap(e) {
      if (e.target.closest("button, a, .panel")) return;
      const x = e.clientX / innerWidth;
      if (x > .3 && x < .7) $bar.classList.toggle("hidden");
    }
    addEventListener("scroll", onScroll, { passive: true });
    addEventListener("keydown", onKey);
    $content.addEventListener("click", onTap);
    onScroll();

    readerCleanup = () => {
      removeEventListener("scroll", onScroll);
      removeEventListener("keydown", onKey);
      document.body.classList.remove("reading");
      document.title = siteName;
    };
  }

  // ---------- music panel ----------
  const $mPanel = document.getElementById("musicPanel");
  const $mBack = document.getElementById("musicBackdrop");
  function renderMusicPanel() {
    const s = window.Music.state;
    document.getElementById("musicList").innerHTML = window.Music.list().map((t) =>
      `<li><button class="mtrack ${t.id === s.id ? "active" : ""}" data-track="${esc(t.id)}">
        <span class="mt">${t.id === s.id && s.playing ? "♫ " : ""}${esc(t.title)}</span>
        ${t.desc ? `<span class="md">${esc(t.desc)}</span>` : ""}</button></li>`
    ).join("");
    document.getElementById("musicPlay").textContent = s.playing ? "❚❚ Tạm dừng" : "▶ Phát";
    document.getElementById("musicVol").value = Math.round(s.volume * 100);
  }
  function syncMusicButtons() {
    document.querySelectorAll("[data-music]").forEach((b) => b.classList.toggle("on", window.Music.state.playing));
  }
  // Music controls inside the reader's settings panel
  function syncReaderMusic() {
    const play = document.getElementById("rMusicPlay");
    if (!play) return;
    const s = window.Music.state;
    play.textContent = s.playing ? "❚❚ Tạm dừng" : "▶ Phát";
    play.classList.toggle("active", s.playing);
    const sel = document.getElementById("rMusicTrack");
    const tracks = window.Music.list();
    if (sel.options.length !== tracks.length) {
      sel.innerHTML = tracks.map((t) => `<option value="${esc(t.id)}">${esc(t.title)}</option>`).join("");
    }
    sel.value = s.id;
    document.getElementById("rMusicVol").value = Math.round(s.volume * 100);
  }
  function openMusic() { renderMusicPanel(); $mPanel.classList.add("open"); $mBack.classList.add("open"); }
  function closeMusic() { $mPanel.classList.remove("open"); $mBack.classList.remove("open"); }
  document.addEventListener("click", (e) => { if (e.target.closest("[data-music]")) openMusic(); });
  $mBack.onclick = closeMusic;
  document.getElementById("musicClose").onclick = closeMusic;
  document.getElementById("musicPlay").onclick = () => window.Music.toggle();
  document.getElementById("musicVol").oninput = (e) => window.Music.setVolume(e.target.value / 100);
  document.getElementById("musicList").addEventListener("click", (e) => {
    const b = e.target.closest("[data-track]");
    if (b) window.Music.play(b.dataset.track);
  });
  window.Music.on(() => { syncMusicButtons(); syncReaderMusic(); if ($mPanel.classList.contains("open")) renderMusicPanel(); });

  // ---------- router ----------
  let routeSeq = 0;
  async function route() {
    const seq = ++routeSeq;
    const stale = () => seq !== routeSeq;
    if (readerCleanup) { readerCleanup(); readerCleanup = null; }
    const parts = location.hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent);
    document.querySelectorAll("[data-nav]").forEach((a) => a.classList.toggle("active", a.dataset.nav === (parts[0] || "home")));
    window.scrollTo(0, 0);
    try {
      switch (parts[0]) {
        case "shelf": return viewShelf();
        case "novel": return await viewNovel(parts[1], stale);
        case "read": return await viewReader(parts[1], parseInt(parts[2], 10) || 0, stale);
        default: return viewHome();
      }
    } catch (err) {
      console.error(err);
      if (!stale()) notFound(err.message || "Có lỗi xảy ra.");
    }
  }

  addEventListener("hashchange", route);
  syncMusicButtons();
  loadCatalog()
    .then(async (music) => {
      window.Music.setUploaded(music.filter((m) => m && m.file).map((m) => ({
        id: "up:" + m.file, title: m.title || prettify(m.file), desc: m.desc || "", url: cdnUrl(m.file),
      })));
      await hydrateFromCache();
    })
    .then(route)
    .catch((err) => {
      console.error(err);
      $app.innerHTML = `<div class="empty">${esc(err.message)}<br><br>Kiểm tra <code>cdnBase</code> trong config.js và cài đặt CORS của Pull Zone.</div>`;
    });
})();
