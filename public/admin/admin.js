// Trang quản trị: upload trực tiếp lên Bunny Storage từ trình duyệt, không cần backend.
// Mật khẩu quản trị dùng để giải mã mật khẩu Storage Zone (được mã hoá AES-GCM, lưu ở _admin/key.json trên Bunny).
(() => {
  "use strict";

  const CFG = window.TT_CONFIG || {};
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const slug = (s) => String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/gi, "d")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "truyen";
  const stamp = () => Date.now().toString(36);
  const store = {
    get(k, s = localStorage) { try { return JSON.parse(s.getItem(k)); } catch { return null; } },
    set(k, v, s = localStorage) { try { s.setItem(k, JSON.stringify(v)); } catch {} },
    del(k) { try { localStorage.removeItem(k); sessionStorage.removeItem(k); } catch {} },
  };

  function toast(msg) {
    const t = $("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove("show"), 2800);
  }

  // ---------- kết nối Bunny ----------
  const HOSTS = [
    ["storage.bunnycdn.com", "Falkenstein (mặc định)"], ["uk.storage.bunnycdn.com", "London"],
    ["ny.storage.bunnycdn.com", "New York"], ["la.storage.bunnycdn.com", "Los Angeles"],
    ["sg.storage.bunnycdn.com", "Singapore"], ["se.storage.bunnycdn.com", "Stockholm"],
    ["br.storage.bunnycdn.com", "São Paulo"], ["jh.storage.bunnycdn.com", "Johannesburg"],
    ["syd.storage.bunnycdn.com", "Sydney"],
  ];
  const conn = Object.assign(
    { zone: CFG.storageZone || "", host: CFG.storageHost || HOSTS[0][0], cdn: CFG.cdnBase || "" },
    store.get("admin-conn") || {}
  );
  const cdnUrl = (p) => `${conn.cdn.replace(/\/+$/, "")}/${p.split("/").map(encodeURIComponent).join("/")}`;

  let accessKey = null;

  function xhr(method, url, { headers = {}, body = null, onProgress } = {}) {
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open(method, url);
      for (const [k, v] of Object.entries(headers)) x.setRequestHeader(k, v);
      if (onProgress) x.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
      x.onload = () => resolve(x);
      x.onerror = () => reject(new Error("Không kết nối được Bunny (lỗi mạng hoặc sai máy chủ Storage)"));
      x.send(body);
    });
  }

  const Bunny = {
    url(path = "") {
      const host = /^https?:\/\//.test(conn.host) ? conn.host : "https://" + conn.host;
      return `${host.replace(/\/+$/, "")}/${encodeURIComponent(conn.zone)}/${path.split("/").map(encodeURIComponent).join("/")}`;
    },
    async req(method, path, { body, onProgress, allow404 } = {}) {
      const headers = { AccessKey: accessKey };
      if (body != null) headers["Content-Type"] = "application/octet-stream";
      const x = await xhr(method, this.url(path), { headers, body, onProgress });
      if (x.status === 404 && allow404) return null;
      if (x.status === 401) throw Object.assign(new Error("Mật khẩu Storage không đúng"), { auth: true });
      if (x.status < 200 || x.status >= 300) throw new Error(`Bunny báo lỗi ${x.status} khi ${method} ${path || "/"}`);
      return x;
    },
    async getJSON(path) {
      const x = await this.req("GET", path, { allow404: true });
      return x ? JSON.parse(x.responseText) : null;
    },
    put(path, body, onProgress) { return this.req("PUT", path, { body, onProgress }); },
    del(path) { return this.req("DELETE", path, { allow404: true }); },
  };

  // ---------- mã hoá mật khẩu Storage bằng mật khẩu quản trị ----------
  const ITER = 600000;
  const b64 = (u8) => btoa(String.fromCharCode(...u8));
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  async function aesKey(pw, salt, iter) {
    const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(pw), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: iter, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  }
  async function seal(secret, pw) {
    const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(pw, salt, ITER), new TextEncoder().encode(secret));
    return { v: 1, kdf: "PBKDF2-SHA256", iter: ITER, salt: b64(salt), iv: b64(iv), ct: b64(new Uint8Array(ct)) };
  }
  async function unseal(blob, pw) {
    try {
      const k = await aesKey(pw, unb64(blob.salt), blob.iter || ITER);
      return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(blob.iv) }, k, unb64(blob.ct)));
    } catch { return null; }
  }
  async function fetchSealed() {
    if (!conn.cdn) return null;
    try {
      const r = await fetch(cdnUrl("_admin/key.json") + "?v=" + Date.now(), { cache: "no-store" });
      return r.ok ? await r.json() : null;
    } catch { return null; }
  }

  // ---------- đăng nhập ----------
  async function verify(key) {
    accessKey = key;
    try { await Bunny.req("GET", ""); return true; }
    catch (e) { accessKey = null; if (e.auth) return false; throw e; }
  }

  // A correct password is still rejected (401) when sent to another region's storage host,
  // so on failure try every region and remember the one that accepts it.
  async function findRegion(candidates) {
    const original = conn.host;
    for (const [host, label] of HOSTS) {
      if (host === original) continue;
      conn.host = host;
      for (const k of candidates) {
        try { if (await verify(k)) return { key: k, host, label }; } catch { /* lỗi mạng: thử vùng khác */ }
      }
    }
    conn.host = original;
    return null;
  }

  async function login(pw) {
    if (!conn.zone) throw new Error("Chưa điền tên Storage Zone (mục Kết nối Bunny)");
    const sealed = await fetchSealed();
    const key = sealed ? await unseal(sealed, pw) : null;
    const candidates = key ? [key, pw] : [pw]; // mật khẩu Storage gốc luôn dùng được
    for (const k of candidates) if (await verify(k)) return k;

    const found = await findRegion(candidates);
    if (found) {
      store.set("admin-conn", { zone: conn.zone, host: conn.host, cdn: conn.cdn });
      regionNotice = `Storage Zone của bạn ở vùng ${found.label}. Hãy sửa storageHost trong config.js thành "${found.host}" rồi deploy lại (máy này đã tự nhớ).`;
      return found.key;
    }
    if (sealed && key) throw new Error("Mật khẩu Storage đã đổi — hãy đăng nhập bằng mật khẩu Storage mới rồi đặt lại mật khẩu quản trị");
    throw new Error(`Sai mật khẩu cho Storage Zone "${conn.zone}". Kiểm tra: dùng ô Password trong Storage → FTP & API Access (không phải Read-only password hay API Key của tài khoản), và tên Storage Zone đúng.`);
  }
  let regionNotice = "";

  function showLogin(msg) {
    $("shell").hidden = true;
    $("login").hidden = false;
    $("loginError").textContent = msg || "";
    $("cZone").value = conn.zone;
    $("cCdn").value = conn.cdn;
    $("cHost").value = conn.host;
    $("hostList").innerHTML = HOSTS.map(([h, l]) => `<option value="${esc(h)}">${esc(l)}</option>`).join("");
    $("pw").focus();
  }

  $("loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const zone = $("cZone").value.trim(), host = $("cHost").value.trim() || HOSTS[0][0], cdn = $("cCdn").value.trim().replace(/\/+$/, "");
    if (zone !== conn.zone || host !== conn.host || cdn !== conn.cdn) {
      Object.assign(conn, { zone, host, cdn });
      store.set("admin-conn", { zone, host, cdn });
    }
    const btn = $("loginBtn");
    btn.disabled = true; btn.textContent = "Đang kiểm tra…";
    $("loginError").textContent = "";
    try {
      $("loginBtn").textContent = "Đang kiểm tra… (có thể mất vài giây)";
      const key = await login($("pw").value.trim());
      store.set("admin-key", key, $("remember").checked ? localStorage : sessionStorage);
      $("pw").value = "";
      await enter();
    } catch (err) {
      $("loginError").textContent = err.message;
    } finally {
      btn.disabled = false; btn.textContent = "Đăng nhập";
    }
  });

  function logout() {
    store.del("admin-key");
    accessKey = null;
    showLogin();
  }
  $("logoutBtn").onclick = logout;

  // ---------- catalog ----------
  let cat = { site: {}, novels: [], music: [] };
  const fileId = (file) => slug(String(file).replace(/^.*\//, "").replace(/\.epub$/i, ""));
  const entryId = (n) => (n.id ? slug(n.id) : fileId(n.file));

  function normalizeCat(c) {
    c = Array.isArray(c) ? { novels: c } : c || {};
    return { site: c.site || {}, novels: (c.novels || []).filter((n) => n && n.file), music: (c.music || []).filter((m) => m && m.file) };
  }
  async function reload() { cat = normalizeCat(await Bunny.getJSON("catalog.json")); }

  // Always edit the latest catalog on Bunny so nothing written elsewhere is lost.
  async function mutate(fn) {
    const fresh = normalizeCat(await Bunny.getJSON("catalog.json"));
    fn(fresh);
    fresh.generated = new Date().toISOString();
    await Bunny.put("catalog.json", JSON.stringify(fresh, null, 2));
    cat = fresh;
    render();
  }

  // ---------- busy overlay ----------
  async function busy(text, fn) {
    $("busy").hidden = false;
    $("busyText").textContent = text;
    $("busyBar").style.width = "0";
    $("busyBar").parentElement.hidden = true;
    const progress = (label, r) => {
      $("busyText").textContent = label;
      $("busyBar").parentElement.hidden = false;
      $("busyBar").style.width = Math.round(r * 100) + "%";
    };
    try { return await fn(progress); }
    catch (err) { toast(err.message); throw err; }
    finally { $("busy").hidden = true; }
  }

  // ---------- views ----------
  let tab = "truyen";
  let query = "";

  function render() {
    tab = (location.hash.slice(1) || "truyen");
    document.querySelectorAll("[data-tab]").forEach((a) => a.classList.toggle("active", a.dataset.tab === tab));
    if (tab === "nhac") return viewMusic();
    if (tab === "caidat") return viewSettings();
    return viewNovels();
  }
  addEventListener("hashchange", () => { if (accessKey) render(); });

  function thumbHTML(n) {
    if (n.cover) return `<img class="thumb" src="${esc(cdnUrl(n.cover))}" alt="" loading="lazy">`;
    return `<div class="thumb" style="background:var(--accent)">☯</div>`;
  }

  function viewNovels() {
    const q = query.trim().toLowerCase();
    const list = cat.novels.map((n, i) => ({ n, i })).filter(({ n }) => !q || `${n.title} ${n.author}`.toLowerCase().includes(q));
    const totalCh = cat.novels.reduce((s, n) => s + (+n.chapters || 0), 0);
    $("view").innerHTML = `
      <div class="head-row">
        <h2>Truyện</h2>
        <div class="stats"><span>${cat.novels.length} truyện</span><span>${totalCh.toLocaleString("vi-VN")} chương</span><span>${cat.novels.filter((n) => n.hidden).length} đang ẩn</span></div>
      </div>
      <label class="drop" id="drop">
        <input type="file" id="epubInput" accept=".epub,application/epub+zip" hidden>
        <b>＋ Thêm truyện: kéo thả file EPUB vào đây</b>
        <span class="hint">hoặc bấm để chọn file. Thông tin, ảnh bìa và số chương được đọc tự động.</span>
      </label>
      ${cat.novels.length > 5 ? `<div class="head-row"><input class="search" id="search" type="search" placeholder="Tìm truyện…" value="${esc(query)}"></div>` : ""}
      <div class="nlist">
        ${list.map(({ n, i }) => `
          <div class="nrow ${n.hidden ? "is-hidden" : ""}" data-i="${i}">
            ${thumbHTML(n)}
            <div class="ninfo">
              <div class="ntitle">${esc(n.title || n.file)}</div>
              <div class="nsub">
                <span>${esc(n.author || "Khuyết danh")}</span>
                ${n.chapters ? `<span>${n.chapters} chương</span>` : ""}
                ${n.status ? `<span class="pill">${esc(n.status)}</span>` : ""}
                ${n.hidden ? `<span class="pill warn">Đang ẩn</span>` : ""}
              </div>
            </div>
            <div class="nact">
              <button class="ibtn" data-act="up" ${i === 0 ? "disabled" : ""} title="Đưa lên">↑</button>
              <button class="ibtn" data-act="down" ${i === cat.novels.length - 1 ? "disabled" : ""} title="Đưa xuống">↓</button>
              <button class="ibtn" data-act="hide">${n.hidden ? "Hiện" : "Ẩn"}</button>
              <button class="ibtn" data-act="edit">Sửa</button>
              <button class="ibtn danger" data-act="del">Xoá</button>
            </div>
          </div>`).join("") || `<div class="empty">${cat.novels.length ? "Không tìm thấy." : "Chưa có truyện nào. Thêm file EPUB đầu tiên ở ô phía trên."}</div>`}
      </div>`;

    const input = $("epubInput"), drop = $("drop");
    input.onchange = () => { if (input.files[0]) addEpub(input.files[0]); input.value = ""; };
    drop.ondragover = (e) => { e.preventDefault(); drop.classList.add("over"); };
    drop.ondragleave = () => drop.classList.remove("over");
    drop.ondrop = (e) => {
      e.preventDefault(); drop.classList.remove("over");
      const f = [...e.dataTransfer.files].find((x) => /\.epub$/i.test(x.name));
      f ? addEpub(f) : toast("Chỉ nhận file .epub");
    };
    const s = $("search");
    if (s) s.oninput = () => { query = s.value; const pos = s.selectionStart; viewNovels(); const t = $("search"); t.focus(); t.setSelectionRange(pos, pos); };

    $("view").querySelector(".nlist").onclick = async (e) => {
      const b = e.target.closest("[data-act]");
      if (!b) return;
      const n = cat.novels[+b.closest("[data-i]").dataset.i];
      const key = n.file;
      const at = (c) => c.novels.findIndex((x) => x.file === key);
      if (b.dataset.act === "edit") return openEditor(n);
      if (b.dataset.act === "del") {
        if (!confirm(`Xoá truyện "${n.title}"?\nFile EPUB và ảnh bìa trên Bunny cũng bị xoá.`)) return;
        await busy("Đang xoá…", async () => {
          await mutate((c) => { const i = at(c); if (i >= 0) c.novels.splice(i, 1); });
          await Bunny.del(n.file);
          if (n.cover) await Bunny.del(n.cover);
        });
        return toast("Đã xoá truyện");
      }
      await busy("Đang lưu…", () => mutate((c) => {
        const i = at(c);
        if (i < 0) return;
        if (b.dataset.act === "hide") c.novels[i].hidden ? delete c.novels[i].hidden : (c.novels[i].hidden = true);
        else {
          const j = b.dataset.act === "up" ? i - 1 : i + 1;
          if (j >= 0 && j < c.novels.length) [c.novels[i], c.novels[j]] = [c.novels[j], c.novels[i]];
        }
      }));
    };
  }

  // ---------- thêm / sửa truyện ----------
  async function toJpeg(blob, maxW = 600) {
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, maxW / bmp.width);
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    return new Promise((res) => c.toBlob(res, "image/jpeg", 0.85));
  }

  async function readEpub(file) {
    const parsed = await busy(`Đang đọc ${file.name}…`, () => window.Epub.parse(file));
    let cover = null;
    if (parsed.cover) { try { cover = await toJpeg(parsed.cover); } catch {} }
    return { parsed, cover };
  }

  async function addEpub(file) {
    let r;
    try { r = await readEpub(file); } catch { return; }
    const p = r.parsed;
    openEditor(null, {
      file, cover: r.cover, chapters: p.chapters,
      fields: { title: p.title || file.name.replace(/\.epub$/i, ""), author: p.author, tags: p.tags.slice(0, 5), status: "", description: p.description.slice(0, 3000) },
    });
  }

  const STATUS = ["", "Đang ra", "Hoàn thành", "Tạm ngưng"];

  // orig: catalog entry being edited (null for a new novel); pending: freshly read EPUB
  function openEditor(orig, pending = null) {
    const dlg = $("editor");
    const f = pending ? pending.fields : orig;
    const state = { epub: pending ? pending.file : null, chapters: pending ? pending.chapters : null, cover: pending ? pending.cover : null };
    const tagsKnown = [...new Set(cat.novels.flatMap((n) => n.tags || []))];

    const draw = () => {
      const coverSrc = state.cover ? URL.createObjectURL(state.cover) : orig && orig.cover ? cdnUrl(orig.cover) : null;
      const chCount = state.chapters ? state.chapters.length : orig ? orig.chapters : 0;
      dlg.innerHTML = `
        <form method="dialog" id="edForm">
          <div class="ed-head"><h3>${orig ? "Sửa truyện" : "Đăng truyện mới"}</h3><button class="ibtn" value="cancel" formnovalidate>✕</button></div>
          <div class="ed-body">
            <div class="ed-cover">
              ${coverSrc ? `<img src="${esc(coverSrc)}" alt="">` : `<div class="ph">Chưa có ảnh bìa</div>`}
              <div style="display:grid;gap:6px">
                <label class="btn ghost small filebtn">Đổi ảnh bìa<input type="file" id="edCover" accept="image/*"></label>
                <label class="btn ghost small filebtn">${orig ? "Thay file EPUB" : "Chọn EPUB khác"}<input type="file" id="edEpub" accept=".epub,application/epub+zip"></label>
              </div>
            </div>
            <div class="form-grid">
              <label class="field">Tên truyện *<input name="title" required value="${esc(f.title)}"></label>
              <div class="row2">
                <label class="field">Tác giả<input name="author" value="${esc(f.author)}"></label>
                <label class="field">Tình trạng<select name="status">${STATUS.map((s) => `<option value="${esc(s)}" ${s === (f.status || "") ? "selected" : ""}>${s || "—"}</option>`).join("")}</select></label>
              </div>
              <label class="field">Thể loại (cách nhau bằng dấu phẩy)
                <input name="tags" list="tagList" value="${esc((f.tags || []).join(", "))}">
                <datalist id="tagList">${tagsKnown.map((t) => `<option value="${esc(t)}">`).join("")}</datalist>
              </label>
              <label class="field">Giới thiệu<textarea name="description" rows="5">${esc(f.description)}</textarea></label>
              <label class="check"><input type="checkbox" name="hidden" ${orig && orig.hidden ? "checked" : ""}> Ẩn khỏi thư viện (lưu nháp)</label>
              <div class="field">
                <span>${chCount ? `${chCount} chương` : ""}${state.epub ? ` · file mới: ${esc(state.epub.name)} (${(state.epub.size / 1048576).toFixed(1)} MB)` : orig ? ` · ${esc(orig.file)}` : ""}</span>
                ${state.chapters ? `<ol class="chap-preview">${state.chapters.slice(0, 50).map((c) => `<li>${esc(c.title)}</li>`).join("")}${state.chapters.length > 50 ? "<li>…</li>" : ""}</ol>` : ""}
              </div>
            </div>
          </div>
          <div class="ed-foot">
            <button class="btn ghost" value="cancel" formnovalidate>Huỷ</button>
            <button class="btn" value="save" id="edSave">${orig ? "Lưu thay đổi" : "Đăng truyện"}</button>
          </div>
        </form>`;
      dlg.querySelector("#edForm").onsubmit = async (e) => {
        if (!e.submitter || e.submitter.value !== "save") return; // Huỷ / ✕: để hộp thoại tự đóng
        e.preventDefault();
        snapshot();
        dlg.close();
        try { await saveNovel(orig, f, state); toast(orig ? "Đã lưu thay đổi" : "Đã đăng truyện"); }
        catch { dlg.showModal(); } // giữ nguyên nội dung để thử lại
      };
      // keep typed values when redrawing after picking files
      dlg.querySelector("#edCover").onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        try { snapshot(); state.cover = await toJpeg(file); draw(); } catch { toast("Không đọc được ảnh"); }
      };
      dlg.querySelector("#edEpub").onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        snapshot();
        try {
          const r = await readEpub(file);
          state.epub = file; state.chapters = r.parsed.chapters;
          if (r.cover && !state.cover) state.cover = r.cover;
          draw();
        } catch {}
      };
    };
    const snapshot = () => {
      const fd = new FormData(dlg.querySelector("#edForm"));
      f.title = fd.get("title"); f.author = fd.get("author"); f.status = fd.get("status"); f.description = fd.get("description");
      f.tags = String(fd.get("tags")).split(",").map((s) => s.trim()).filter(Boolean);
      f.hiddenDraft = fd.get("hidden") === "on";
    };

    draw();
    dlg.showModal();
  }

  async function saveNovel(orig, f, state) {
    const title = String(f.title || "").trim();
    if (!title) { toast("Thiếu tên truyện"); throw new Error("title"); }
    let id = orig ? entryId(orig) : slug(title);
    if (!orig) { const taken = new Set(cat.novels.map(entryId)); for (let k = 2; taken.has(id); k++) id = `${slug(title)}-${k}`; }

    const entry = {
      ...(orig || {}), id, title, author: f.author || "", tags: f.tags || [], status: f.status || "", description: f.description || "",
    };
    if (f.hiddenDraft) entry.hidden = true; else delete entry.hidden;
    const oldFiles = [];

    await busy("Đang tải lên…", async (progress) => {
      // Tên file mới mỗi lần thay để CDN không trả bản cũ.
      if (state.epub) {
        const path = `truyen/${id}-${stamp()}.epub`;
        await Bunny.put(path, state.epub, (r) => progress(`Đang tải EPUB lên… ${Math.round(r * 100)}%`, r));
        if (orig && orig.file) oldFiles.push(orig.file);
        entry.file = path;
        entry.chapters = state.chapters.length;
        entry.updated = String(Date.now());
      }
      if (state.cover) {
        const path = `bia/${id}-${stamp()}.jpg`;
        await Bunny.put(path, state.cover, (r) => progress(`Đang tải ảnh bìa… ${Math.round(r * 100)}%`, r));
        if (orig && orig.cover) oldFiles.push(orig.cover);
        entry.cover = path;
      }
      progress("Đang cập nhật danh sách…", 1);
      for (const k of Object.keys(entry)) if (entry[k] === "" || (Array.isArray(entry[k]) && !entry[k].length)) delete entry[k];
      await mutate((c) => {
        const i = orig ? c.novels.findIndex((x) => x.file === orig.file) : -1;
        if (i >= 0) c.novels[i] = entry; else c.novels.unshift(entry);
      });
      for (const p of oldFiles) await Bunny.del(p).catch(() => {});
    });
  }

  // ---------- nhạc ----------
  function viewMusic() {
    $("view").innerHTML = `
      <div class="head-row"><h2>Nhạc nền</h2><span class="stats">${cat.music.length} bài tải lên</span></div>
      <p class="hint">Trang đọc luôn có sẵn 4 bài dựng sẵn (Thanh Sơn Tĩnh Tọa, Vân Hải Phiêu Diêu, Trúc Lâm Thính Vũ, Linh Tuyền Cổ Động). Bài tải lên ở đây sẽ hiện thêm trong danh sách. Chỉ dùng nhạc bạn có quyền phát.</p>
      <label class="drop" id="mdrop">
        <input type="file" id="audioInput" accept="audio/mpeg,audio/ogg,audio/mp4,audio/x-m4a,.mp3,.ogg,.m4a" multiple hidden>
        <b>＋ Tải nhạc lên (mp3, ogg, m4a)</b><span class="hint">kéo thả hoặc bấm để chọn, chọn được nhiều file</span>
      </label>
      <div class="nlist">
        ${cat.music.map((m, i) => `
          <div class="mitem" data-i="${i}">
            <input value="${esc(m.title || "")}" placeholder="Tên bài" data-title>
            <button class="ibtn danger" data-del>Xoá</button>
            <audio controls preload="none" src="${esc(cdnUrl(m.file))}"></audio>
          </div>`).join("") || `<div class="empty">Chưa có bài nào được tải lên.</div>`}
      </div>`;

    const input = $("audioInput"), drop = $("mdrop");
    input.onchange = () => { uploadMusic([...input.files]); input.value = ""; };
    drop.ondragover = (e) => { e.preventDefault(); drop.classList.add("over"); };
    drop.ondragleave = () => drop.classList.remove("over");
    drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove("over"); uploadMusic([...e.dataTransfer.files]); };

    const list = $("view").querySelector(".nlist");
    list.addEventListener("change", (e) => {
      if (!e.target.matches("[data-title]")) return;
      const m = cat.music[+e.target.closest("[data-i]").dataset.i];
      const title = e.target.value.trim();
      busy("Đang lưu…", () => mutate((c) => { const x = c.music.find((y) => y.file === m.file); if (x) x.title = title; })).then(() => toast("Đã đổi tên"), () => {});
    });
    list.addEventListener("click", (e) => {
      if (!e.target.closest("[data-del]")) return;
      const m = cat.music[+e.target.closest("[data-i]").dataset.i];
      if (!confirm(`Xoá bài "${m.title}"?`)) return;
      busy("Đang xoá…", async () => {
        await mutate((c) => { c.music = c.music.filter((y) => y.file !== m.file); });
        await Bunny.del(m.file);
      }).then(() => toast("Đã xoá bài nhạc"), () => {});
    });
  }

  async function uploadMusic(files) {
    files = files.filter((f) => /\.(mp3|ogg|m4a)$/i.test(f.name));
    if (!files.length) return toast("Chỉ nhận file mp3, ogg, m4a");
    const added = [];
    await busy("Đang tải nhạc lên…", async (progress) => {
      for (const [k, f] of files.entries()) {
        const ext = f.name.split(".").pop().toLowerCase();
        const title = f.name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim();
        const path = `nhac/${slug(title)}-${stamp()}.${ext}`;
        await Bunny.put(path, f, (r) => progress(`Đang tải ${k + 1}/${files.length}: ${title} — ${Math.round(r * 100)}%`, r));
        added.push({ title, file: path });
      }
      await mutate((c) => { c.music.push(...added); });
    }).then(() => toast(`Đã thêm ${added.length} bài nhạc`), () => {});
  }

  // ---------- cài đặt ----------
  async function viewSettings() {
    const site = cat.site || {};
    $("view").innerHTML = `
      <div class="head-row"><h2>Cài đặt</h2></div>
      <section class="box settings-box">
        <h3>Trang đọc</h3>
        <form id="siteForm" class="form-grid">
          <label class="field">Tên trang<input name="name" value="${esc(site.name || "")}" placeholder="Tu Tiên Các"></label>
          <label class="field">Thông báo (hiện ở đầu thư viện, để trống nếu không cần)<textarea name="notice" rows="2">${esc(site.notice || "")}</textarea></label>
          <div><button class="btn">Lưu</button></div>
        </form>
      </section>

      <section class="box settings-box">
        <h3>Mật khẩu quản trị</h3>
        <p class="hint" id="pwStatus">Đang kiểm tra…</p>
        <form id="pwForm" class="form-grid">
          <div class="row2">
            <label class="field">Mật khẩu mới (ít nhất 10 ký tự)<input type="password" name="p1" minlength="10" autocomplete="new-password" required></label>
            <label class="field">Nhập lại<input type="password" name="p2" minlength="10" autocomplete="new-password" required></label>
          </div>
          <div class="actions"><button class="btn">Đặt mật khẩu</button><button class="btn ghost" type="button" id="pwRemove" hidden>Xoá mật khẩu quản trị</button></div>
        </form>
        <p class="hint">Mật khẩu quản trị dùng để mã hoá mật khẩu Storage, bản mã được lưu tại <code>_admin/key.json</code> trên Bunny. Bản mã này ai cũng tải được, nên hãy chọn mật khẩu dài, khó đoán. Mật khẩu Storage gốc lúc nào cũng đăng nhập được.</p>
      </section>

      <section class="box settings-box">
        <h3>Kết nối Bunny</h3>
        <dl class="kv">
          <dt>Storage Zone</dt><dd>${esc(conn.zone)}</dd>
          <dt>Máy chủ Storage</dt><dd>${esc(conn.host)}</dd>
          <dt>Pull Zone (CDN)</dt><dd>${conn.cdn ? `<a class="link" href="${esc(conn.cdn)}/catalog.json" target="_blank" rel="noopener">${esc(conn.cdn)}</a>` : "<b>Chưa cấu hình</b> — trang đọc sẽ chạy chế độ demo"}</dd>
          <dt>Trang đọc</dt><dd id="cdnCheck">Đang kiểm tra…</dd>
        </dl>
        <p class="hint">Muốn đổi: sửa <code>config.js</code> rồi deploy lại, hoặc đổi tạm trên máy này ở mục “Kết nối Bunny” của màn hình đăng nhập.</p>
        <div class="actions"><button class="btn ghost" id="logout2">Đăng xuất</button></div>
      </section>`;

    $("logout2").onclick = logout;
    $("siteForm").onsubmit = (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const s = { name: String(fd.get("name")).trim(), notice: String(fd.get("notice")).trim() };
      busy("Đang lưu…", () => mutate((c) => { c.site = Object.fromEntries(Object.entries(s).filter(([, v]) => v)); }))
        .then(() => toast("Đã lưu. Trang đọc cập nhật sau khoảng 1 phút."), () => {});
    };

    const sealed = await Bunny.getJSON("_admin/key.json").catch(() => null);
    if ($("pwStatus")) {
      $("pwStatus").innerHTML = sealed ? `<span class="ok">✓ Đã đặt mật khẩu quản trị.</span> Đặt lại bên dưới nếu muốn đổi.` : "Chưa đặt. Hiện chỉ đăng nhập được bằng mật khẩu Storage.";
      $("pwRemove").hidden = !sealed;
    }
    $("pwForm").onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      if (fd.get("p1") !== fd.get("p2")) return toast("Hai mật khẩu không khớp");
      if (fd.get("p1") === accessKey) return toast("Hãy chọn mật khẩu khác mật khẩu Storage");
      await busy("Đang mã hoá…", async () => {
        await Bunny.put("_admin/key.json", JSON.stringify(await seal(accessKey, String(fd.get("p1")))));
      }).then(() => { toast("Đã đặt mật khẩu quản trị"); viewSettings(); }, () => {});
    };
    $("pwRemove").onclick = async () => {
      if (!confirm("Xoá mật khẩu quản trị? Sau đó chỉ đăng nhập được bằng mật khẩu Storage.")) return;
      await busy("Đang xoá…", () => Bunny.del("_admin/key.json")).then(() => { toast("Đã xoá"); viewSettings(); }, () => {});
    };

    // Check that the reader can reach catalog.json through the CDN (CORS).
    const out = $("cdnCheck");
    if (!conn.cdn) { out.textContent = "—"; return; }
    try {
      const r = await fetch(cdnUrl("catalog.json") + "?v=" + Date.now(), { cache: "no-store" });
      out.innerHTML = r.ok ? `<span class="ok">✓ Đọc được catalog.json qua CDN</span>` : `CDN trả lỗi ${r.status}${r.status === 404 ? " (chưa có catalog — thêm truyện đầu tiên)" : ""}`;
    } catch {
      out.innerHTML = `<b>Không đọc được qua CDN.</b> Bật “Add CORS headers” cho đuôi json, epub, jpg, mp3… trong Pull Zone.`;
    }
  }

  // ---------- khởi động ----------
  async function enter() {
    $("login").hidden = true;
    $("shell").hidden = false;
    $("view").innerHTML = `<div class="loading">Đang tải danh sách…</div>`;
    try { await reload(); } catch (err) { toast(err.message); }
    render();
    if (regionNotice) { alert(regionNotice); regionNotice = ""; }
  }

  (async () => {
    const saved = store.get("admin-key", sessionStorage) || store.get("admin-key");
    if (saved && conn.zone) {
      try { if (await verify(saved)) return enter(); } catch {}
      store.del("admin-key");
    }
    showLogin();
  })();
})();
