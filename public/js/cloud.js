// Tài khoản và đồng bộ qua Supabase (tuỳ chọn).
// Chưa điền supabaseUrl / supabaseAnonKey trong config.js thì web chạy như cũ, dữ liệu chỉ lưu trên máy.
window.Cloud = (() => {
  "use strict";

  const CFG = window.TT_CONFIG || {};
  const URL_ = String(CFG.supabaseUrl || "").replace(/\/+$/, "");
  const KEY = CFG.supabaseAnonKey || "";
  const enabled = !!(URL_ && KEY);
  const SDK = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js";

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
