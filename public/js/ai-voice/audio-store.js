// Kho audio giọng AI đã sinh, lưu trong IndexedDB để nghe lại không phải sinh lại (đỡ CPU, pin).
// Khoá theo NỘI DUNG đoạn văn (mã băm của giọng + chữ), nên đổi chương, sửa truyện hay đăng lại đều không lẫn.
// Nén Opus bằng WebCodecs (~4 KB/giây audio); trình duyệt chưa có thì lưu PCM 16-bit.
// Tổng dung lượng giới hạn LIMIT_BYTES, đầy thì xoá các đoạn lâu không nghe nhất.
window.AiAudioStore = (() => {
  "use strict";

  const DB = "tt-ai-audio", LIMIT_BYTES = 200 * 1048576, BITRATE = 32000;
  let dbp = null;
  const open = () => (dbp ||= new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      db.createObjectStore("paras", { keyPath: "key" }).createIndex("used", "used");   // {key, total, bytes, used}
      db.createObjectStore("chunks", { keyPath: "id" });                                // {id: key#j, codec, sr, len, data}
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  }).catch(() => null));

  const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const done = (tx) => new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = tx.onabort = () => rej(tx.error); });

  // ---------- nén / giải nén ----------
  const opusCfg = (sr) => ({ codec: "opus", sampleRate: sr, numberOfChannels: 1, bitrate: BITRATE });
  let opusOk = null;
  async function canOpus(sr) {
    if (opusOk !== null) return opusOk;
    try {
      opusOk = typeof AudioEncoder === "function" && typeof AudioDecoder === "function" &&
        (await AudioEncoder.isConfigSupported(opusCfg(sr))).supported &&
        (await AudioDecoder.isConfigSupported({ codec: "opus", sampleRate: sr, numberOfChannels: 1 })).supported;
    } catch { opusOk = false; }
    return opusOk;
  }

  async function encode(f32, sr) {
    if (await canOpus(sr)) {
      try {
        const packets = [];
        const enc = new AudioEncoder({ output: (c) => { const b = new Uint8Array(c.byteLength); c.copyTo(b); packets.push(b); }, error: () => {} });
        enc.configure(opusCfg(sr));
        enc.encode(new AudioData({ format: "f32", sampleRate: sr, numberOfFrames: f32.length, numberOfChannels: 1, timestamp: 0, data: f32 }));
        await enc.flush(); enc.close();
        // ghép các gói: [độ dài u16][gói]…
        const size = packets.reduce((s, p) => s + 2 + p.length, 0), out = new Uint8Array(size);
        let o = 0;
        for (const p of packets) { out[o] = p.length >> 8; out[o + 1] = p.length & 255; out.set(p, o + 2); o += 2 + p.length; }
        return { codec: "opus", data: out.buffer };
      } catch { /* rơi xuống PCM */ }
    }
    const pcm = new Int16Array(f32.length);
    for (let i = 0; i < f32.length; i++) pcm[i] = Math.max(-1, Math.min(1, f32[i])) * 0x7fff;
    return { codec: "pcm16", data: pcm.buffer };
  }

  async function decode(rec) {
    const out = new Float32Array(rec.len);
    if (rec.codec === "pcm16") {
      const pcm = new Int16Array(rec.data);
      for (let i = 0; i < out.length && i < pcm.length; i++) out[i] = pcm[i] / 0x7fff;
      return out;
    }
    const bytes = new Uint8Array(rec.data);
    let o = 0, ts = 0, rate = rec.sr;
    const parts = [];
    const dec = new AudioDecoder({
      output: (a) => {
        rate = a.sampleRate;
        const f = new Float32Array(a.numberOfFrames); a.copyTo(f, { planeIndex: 0, format: "f32-planar" }); parts.push(f); a.close();
      },
      error: () => {},
    });
    dec.configure({ codec: "opus", sampleRate: rec.sr, numberOfChannels: 1 });
    while (o + 2 <= bytes.length) {
      const n = (bytes[o] << 8) | bytes[o + 1];
      dec.decode(new EncodedAudioChunk({ type: "key", timestamp: ts, data: bytes.subarray(o + 2, o + 2 + n) }));
      o += 2 + n; ts += 20000;
    }
    await dec.flush(); dec.close();
    const all = new Float32Array(parts.reduce((s, p) => s + p.length, 0));
    let w = 0;
    for (const p of parts) { all.set(p, w); w += p.length; }
    const pcm = resample(all, rate, rec.sr);
    out.set(pcm.subarray(0, out.length));
    return out;
  }

  // Bộ giải Opus của trình duyệt luôn trả 48 kHz dù cấu hình 24 kHz → phải đổi về đúng tần số đã lưu,
  // nếu không audio phát chậm gấp đôi, trầm và méo, lại mất nửa sau.
  function resample(x, from, to) {
    if (from === to) return x;
    const r = from / to, out = new Float32Array(Math.floor(x.length / r));
    if (Number.isInteger(r)) {                       // 48 → 24 kHz: lấy trung bình từng cặp mẫu
      for (let i = 0; i < out.length; i++) { let s = 0; for (let k = 0; k < r; k++) s += x[i * r + k]; out[i] = s / r; }
    } else {
      for (let i = 0; i < out.length; i++) { const p = i * r, j = Math.floor(p), f = p - j; out[i] = x[j] * (1 - f) + (x[j + 1] ?? x[j]) * f; }
    }
    return out;
  }

  // ---------- API ----------
  // Một câu (chunk j của đoạn key) vừa sinh xong
  async function putChunk(key, j, f32, sr) {
    const db = await open();
    if (!db) return;
    const { codec, data } = await encode(f32, sr);
    const tx = db.transaction(["chunks", "paras"], "readwrite");
    tx.objectStore("chunks").put({ id: `${key}#${j}`, codec, sr, len: f32.length, data });
    const ps = tx.objectStore("paras");
    const p = (await req(ps.get(key))) || { key, total: null, bytes: 0 };
    p.bytes += data.byteLength; p.used = Date.now();
    ps.put(p);
    await done(tx).catch(() => {});
  }

  // Đoạn đã sinh đủ (total câu): từ đây mới được coi là có sẵn để phát lại
  async function finish(key, total) {
    const db = await open();
    if (!db) return;
    const tx = db.transaction("paras", "readwrite"), ps = tx.objectStore("paras");
    const p = (await req(ps.get(key))) || { key, bytes: 0 };
    p.total = total; p.used = Date.now();
    ps.put(p);
    await done(tx).catch(() => {});
    prune();
  }

  // Đoạn đã có đủ trong kho → mảng Float32 từng câu; chưa có / thiếu → null
  async function getPara(key) {
    const db = await open();
    if (!db) return null;
    const p = await req(db.transaction("paras").objectStore("paras").get(key)).catch(() => null);
    if (!p || p.total === null || p.total === undefined) return null;
    const cs = db.transaction("chunks").objectStore("chunks");
    const recs = await Promise.all(Array.from({ length: p.total }, (_, j) => req(cs.get(`${key}#${j}`)).catch(() => null)));
    if (recs.some((r) => !r)) return null;
    touch(key);
    try { return await Promise.all(recs.map(decode)); } catch { return null; }
  }

  async function touch(key) {
    const db = await open();
    if (!db) return;
    const tx = db.transaction("paras", "readwrite"), ps = tx.objectStore("paras");
    const p = await req(ps.get(key));
    if (p) { p.used = Date.now(); ps.put(p); }
  }

  let pruning = false;
  async function prune() {
    if (pruning) return;
    pruning = true;
    try {
      const db = await open();
      if (!db) return;
      const all = await req(db.transaction("paras").objectStore("paras").index("used").getAll());
      let total = all.reduce((s, p) => s + (p.bytes || 0), 0);
      for (const p of all) {                        // index "used" tăng dần: cũ nhất trước
        if (total <= LIMIT_BYTES) break;
        const tx = db.transaction(["paras", "chunks"], "readwrite");
        tx.objectStore("paras").delete(p.key);
        tx.objectStore("chunks").delete(IDBKeyRange.bound(`${p.key}#`, `${p.key}#￿`));
        await done(tx).catch(() => {});
        total -= p.bytes || 0;
      }
    } finally { pruning = false; }
  }

  async function stats() {
    const db = await open();
    if (!db) return null;
    const all = await req(db.transaction("paras").objectStore("paras").getAll());
    return { paras: all.length, complete: all.filter((p) => p.total != null).length, bytes: all.reduce((s, p) => s + (p.bytes || 0), 0), opus: opusOk };
  }

  return { putChunk, finish, getPara, stats };
})();
