// Tài khoản và đồng bộ qua Supabase (tuỳ chọn).
// Chưa điền supabaseUrl / supabaseAnonKey trong config.js thì web chạy như cũ, dữ liệu chỉ lưu trên máy.
window.Cloud = (() => {
  "use strict";

  const CFG = window.TT_CONFIG || {};
  const URL_ = String(CFG.supabaseUrl || "").replace(/\/+$/, "");
  const KEY = CFG.supabaseAnonKey || "";
  const enabled = !!(URL_ && KEY);
  const SDK = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js";

  // Cột của bảng novels (giống các trường truyện trước đây trong catalog.json).
  const NOVEL_COLS = ["id", "title", "author", "tags", "status", "description", "cover", "dir", "file", "chunk", "chapters", "words", "hidden", "updated"];
  const DEFAULTS = { tags: [], chunk: 50, chapters: 0, words: 0, hidden: false };
  // Bỏ trường rỗng và cột nội bộ để dữ liệu giống hệt dạng cũ.
  const tidy = (o) => Object.fromEntries(Object.entries(o).filter(([k, v]) =>
    v !== null && v !== "" && k !== "position" && k !== "updated_at" && !(Array.isArray(v) && !v.length)));

  let client = null;
  let session = null;
  const listeners = new Set();
  const emit = (evt) => listeners.forEach((fn) => fn(evt));

  function loadSdk() {
    if (window.supabase) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = SDK;
      s.onload = resolve;
      s.onerror = () => reject(new Error("Không tải được thư viện Supabase"));
      document.head.appendChild(s);
    });
  }

  const ready = !enabled ? Promise.resolve() : (async () => {
    try {
      await loadSdk();
      // PKCE: liên kết trong email trả về ?code=… nên không đụng tới #/… của trang
      client = window.supabase.createClient(URL_, KEY, { auth: { flowType: "pkce", persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
      session = (await client.auth.getSession()).data.session;
      client.auth.onAuthStateChange((evt, s) => { session = s; emit(evt); });
    } catch (e) {
      console.warn(e);
      client = null;
    }
  })();

  const MESSAGES = [
    [/invalid login credentials/i, "Sai email hoặc mật khẩu"],
    [/email not confirmed/i, "Email chưa được xác nhận. Hãy mở thư xác nhận trong hộp thư."],
    [/already registered|already been registered/i, "Email này đã có tài khoản, hãy đăng nhập"],
    [/password should be at least/i, "Mật khẩu tối thiểu 6 ký tự"],
    [/rate limit|too many requests|security purposes/i, "Thao tác quá nhanh, hãy thử lại sau ít phút"],
    [/unable to validate email|invalid email/i, "Email không hợp lệ"],
    [/failed to fetch|network/i, "Không kết nối được máy chủ tài khoản"],
  ];
  const fail = (error) => {
    const m = MESSAGES.find(([re]) => re.test(error.message || ""));
    throw new Error(m ? m[1] : error.message || "Có lỗi xảy ra");
  };
  const need = () => { if (!client) throw new Error("Không kết nối được máy chủ tài khoản"); };
  const back = () => location.origin + location.pathname; // quay về đúng trang đang mở (trang đọc hoặc /admin)

  return {
    enabled,
    ready,
    url: URL_,
    anonKey: KEY,
    get user() { return session ? session.user : null; },
    get token() { return session ? session.access_token : null; },
    async freshToken() { need(); return (await client.auth.getSession()).data.session?.access_token || null; },
    on(fn) { listeners.add(fn); },

    async signIn(email, password) {
      need();
      const { error } = await client.auth.signInWithPassword({ email, password });
      if (error) fail(error);
    },
    // trả về true khi cần mở email để xác nhận
    async signUp(email, password) {
      need();
      const { data, error } = await client.auth.signUp({ email, password, options: { emailRedirectTo: back() } });
      if (error) fail(error);
      return !data.session;
    },
    async signInWithGoogle() {
      need();
      const { error } = await client.auth.signInWithOAuth({ provider: "google", options: { redirectTo: back() } });
      if (error) fail(error);
    },
    async resetPassword(email) {
      need();
      const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo: back() });
      if (error) fail(error);
    },
    async updatePassword(password) {
      need();
      const { error } = await client.auth.updateUser({ password });
      if (error) fail(error);
    },
    async signOut() { if (client) await client.auth.signOut(); },

    // ---------- thư viện (thay cho catalog.json) ----------
    // Trang đọc: gọi thẳng REST bằng khoá công khai, không cần tải thư viện Supabase.
    // Quy tắc RLS tự bỏ các truyện đang ẩn.
    async library() {
      const h = { apikey: KEY, Authorization: `Bearer ${KEY}` };
      const get = async (q) => {
        const r = await fetch(`${URL_}/rest/v1/${q}`, { headers: h, cache: "no-store" });
        if (!r.ok) throw new Error(`Không tải được danh sách truyện (${r.status})`);
        return r.json();
      };
      const [novels, site] = await Promise.all([
        get("novels?select=*&order=position.asc"),
        get("site_settings?select=name,notice&id=eq.1"),
      ]);
      return { site: tidy(site[0] || {}), novels: novels.map(tidy) };
    },

    // Trang quản trị: đọc tất cả (kể cả truyện ẩn) bằng phiên đăng nhập admin.
    async adminLibrary() {
      need();
      const [n, s] = await Promise.all([
        client.from("novels").select("*").order("position"),
        client.from("site_settings").select("name,notice").eq("id", 1).maybeSingle(),
      ]);
      for (const r of [n, s]) if (r.error) fail(r.error);
      return { site: tidy(s.data || {}), novels: n.data.map(tidy) };
    },

    // Ghi những gì khác nhau giữa trước và sau khi sửa: dòng mới/đổi thì upsert, dòng mất thì xoá.
    async saveLibrary(before, after) {
      need();
      const novelRow = (x, i) => ({ ...Object.fromEntries(NOVEL_COLS.map((k) => [k, x[k] ?? DEFAULTS[k] ?? null])), position: i });
      const plan = (rowOf, key, oldList, newList) => {
        const old = new Map(oldList.map((x, i) => [x[key], JSON.stringify(rowOf(x, i))]));
        const rows = newList.map(rowOf).filter((r) => old.get(r[key]) !== JSON.stringify(r));
        const keep = new Set(newList.map((x) => x[key]));
        return { rows, gone: oldList.map((x) => x[key]).filter((k) => !keep.has(k)) };
      };
      const ops = [];
      const n = plan(novelRow, "id", before.novels, after.novels);
      if (n.gone.length) ops.push(client.from("novels").delete().in("id", n.gone));
      if (n.rows.length) ops.push(client.from("novels").upsert(n.rows));
      const site = { id: 1, name: after.site.name || null, notice: after.site.notice || null };
      if (JSON.stringify(tidy(before.site)) !== JSON.stringify(tidy(after.site))) ops.push(client.from("site_settings").upsert(site));
      for (const r of await Promise.all(ops)) if (r.error) fail(r.error);
    },

    // ---------- đồng bộ dữ liệu đọc ----------
    async load() {
      need();
      const { data, error } = await client.from("reader_state").select("data").eq("user_id", this.user.id).maybeSingle();
      if (error) fail(error);
      return data ? data.data : null;
    },
    async save(payload) {
      need();
      const { error } = await client.from("reader_state")
        .upsert({ user_id: this.user.id, data: payload, updated_at: new Date().toISOString() });
      if (error) fail(error);
    },
    // Lúc đóng trang: gửi bằng keepalive để không bị huỷ giữa chừng.
    saveOnExit(payload) {
      if (!session) return;
      fetch(`${URL_}/rest/v1/reader_state?on_conflict=user_id`, {
        method: "POST",
        keepalive: true,
        headers: {
          apikey: KEY,
          Authorization: `Bearer ${session.access_token}`,
          "Content-Type": "application/json",
          Prefer: "resolution=merge-duplicates,return=minimal",
        },
        body: JSON.stringify({ user_id: session.user.id, data: payload, updated_at: new Date().toISOString() }),
      }).catch(() => {});
    },
  };
})();
