// Nghe truyện: đọc to bằng giọng có sẵn trên máy (Web Speech API), hoặc giọng AI "Người kể chuyện"
// (VieNeu-TTS Nano chạy ngay trong trình duyệt, xem js/ai-voice/nano-worker.js). Không cần máy chủ.
window.TTS = (() => {
  "use strict";

  let synth = window.speechSynthesis;
  const webSpeech = !!synth && "SpeechSynthesisUtterance" in window;
  const AI_URI = "ai:narrator";
  const aiSupported = typeof Worker === "function" && typeof WebAssembly === "object" && "caches" in window;
  const supported = webSpeech || aiSupported;

  const saved = (() => { try { return JSON.parse(localStorage.getItem("tts")) || {}; } catch { return {}; } })();
  const state = { playing: false, index: 0, total: 0, rate: saved.rate || 1, voice: saved.voice || "", status: "" };
  const save = () => { try { localStorage.setItem("tts", JSON.stringify({ rate: state.rate, voice: state.voice })); } catch {} };
  const listeners = new Set();
  const emit = () => listeners.forEach((fn) => fn(state));

  let blocks = [];       // các đoạn đang đọc: tiêu đề chương + từng <p>
  let onFinish = null;   // gọi khi đọc hết chương
  let session = 0;       // tăng mỗi lần dừng, để bỏ qua sự kiện cũ còn sót

  // ---------- giọng đọc ----------
  const AI_VOICE = { voiceURI: AI_URI, name: "Giọng AI · Người kể chuyện", lang: "vi-VN" };
  function voices() { return webSpeech ? synth.getVoices() : []; }
  function viVoices() { return voices().filter((v) => /^vi\b|^vi-/i.test(v.lang)); }
  function pickVoice() {
    const all = voices();
    return all.find((v) => v.voiceURI === state.voice) || viVoices()[0] || null;
  }
  const usingAi = () => aiSupported && (state.voice === AI_URI || (!webSpeech && !state.voice));
  if (webSpeech && "onvoiceschanged" in synth) synth.addEventListener("voiceschanged", emit);

  // Câu ngắn để tránh lỗi trình duyệt tự ngắt khi đọc đoạn dài.
  function pieces(text) {
    const out = [];
    for (const sentence of text.split(/(?<=[.!?…;:])\s+/)) {
      let s = sentence.trim();
      while (s.length > 220) {
        let cut = s.lastIndexOf(", ", 220);
        if (cut < 80) cut = s.lastIndexOf(" ", 220);
        if (cut < 1) cut = 220;
        out.push(s.slice(0, cut + 1).trim());
        s = s.slice(cut + 1).trim();
      }
      if (s) out.push(s);
    }
    return out;
  }

  function mark(i) {
    blocks.forEach((b, k) => b.classList.toggle("tts-on", k === i));
    const el = blocks[i];
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.top < 70 || r.bottom > innerHeight - 90) el.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  function speakFrom(i) {
    const my = ++session;
    if (webSpeech) synth.cancel();
    ai.stopAudio();
    if (i >= blocks.length) return finish();
    state.index = i;
    state.playing = true;
    mark(i);
    emit();
    if (usingAi()) return ai.playBlock(i, my);
    const parts = pieces(blocks[i].textContent);
    let j = 0;
    const next = () => {
      if (my !== session) return;
      if (j >= parts.length) return speakFrom(i + 1);
      const u = new SpeechSynthesisUtterance(parts[j++]);
      u.lang = "vi-VN";
      const v = pickVoice();
      if (v) u.voice = v;
      u.rate = state.rate;
      u.onend = next;
      u.onerror = (e) => { if (e.error !== "interrupted" && e.error !== "canceled") next(); };
      synth.speak(u);
    };
    next();
  }

  function finish() {
    state.playing = false;
    blocks.forEach((b) => b.classList.remove("tts-on"));
    emit();
    if (onFinish) onFinish();
  }

  // ---------- giọng AI ----------
  // Worker sinh audio từng câu của từng đoạn; ở đây giữ các câu đã sinh (blob WAV) và phát lần lượt.
  //  - Mỗi đoạn được nhận diện bằng mã băm NỘI DUNG (giọng + chữ), không phải số thứ tự đoạn: kết quả
  //    sinh dở của chương cũ không bao giờ bị gán nhầm sang chương mới.
  //  - Luôn giữ ~BUFFER_S giây audio sinh sẵn phía trước (đoạn đã sinh tính theo thời lượng thật,
  //    chưa sinh thì ước theo số ký tự); gần hết chương thì sinh luôn sang các đoạn đầu chương sau.
  //  - Đoạn đã sinh được lưu trong IndexedDB (AiAudioStore): nghe lại không phải sinh lại.
  const ai = (() => {
    const VOICE = "nano-v1|narrator";
    const BUFFER_S = 60, NEXT_AT_S = 90, CHARS_PER_S = 15.7, PARA_GAP_S = 0.7;
    let worker = null, ready = null, sampleRate = 24000;
    let mem = new Map();              // mã đoạn → { urls: [], total: số câu | null, dur: giây, wait: fn | null, src: "worker" | "store" }
    let nextFn = null, nextTexts = null, nextLoading = false;   // chữ các đoạn của chương sau (để sinh trước)
    const audio = new Audio();
    audio.preservesPitch = true;
    const store = window.AiAudioStore || null;

    // mã băm 53 bit (cyrb53) của giọng + chữ đoạn
    function keyOf(text) {
      const s = `${VOICE}\n${text.trim()}`;
      let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
      for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677); }
      h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
      h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
      return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
    }
    const textOf = (i) => blocks[i].textContent;
    const estimate = (text) => text.trim().length / CHARS_PER_S + PARA_GAP_S;
    const secondsOf = (text) => { const e = mem.get(keyOf(text)); return e && e.total !== null && e.dur ? e.dur : estimate(text); };

    const setStatus = (s) => { if (state.status !== s) { state.status = s; emit(); } };

    function wavBlob(f32) {           // Float32 → WAV 16-bit mono
      const buf = new ArrayBuffer(44 + f32.length * 2), v = new DataView(buf);
      const w = (o, s) => [...s].forEach((c, k) => v.setUint8(o + k, c.charCodeAt(0)));
      w(0, "RIFF"); v.setUint32(4, 36 + f32.length * 2, true); w(8, "WAVEfmt ");
      v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
      v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
      w(36, "data"); v.setUint32(40, f32.length * 2, true);
      for (let k = 0; k < f32.length; k++) v.setInt16(44 + k * 2, Math.max(-1, Math.min(1, f32[k])) * 0x7fff, true);
      return URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
    }

    const wake = (e) => { if (e.wait) { const f = e.wait; e.wait = null; f(); } };
    const drop = (key) => { const e = mem.get(key); if (!e) return; e.urls.forEach((u) => u && URL.revokeObjectURL(u)); mem.delete(key); wake(e); };

    function start() {
      if (ready) return ready;
      // xin lưu trữ bền vững để trình duyệt không tự xoá model (~280 MB) khi thiếu dung lượng
      try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch {}
      worker = new Worker("/js/ai-voice/nano-worker.js", { type: "module" });
      ready = new Promise((resolve, reject) => {
        worker.onmessage = ({ data }) => {
          if (data.type === "progress") {
            const pct = data.total ? Math.floor((data.loaded / data.total) * 100) : 0;
            if (data.downloading) setStatus(`Đang tải giọng AI lần đầu (khoảng 280 MB, chỉ tải một lần): ${pct}%`);
            else if (audio.paused) setStatus("Đang khởi động giọng AI…");   // đang phát đoạn đã lưu thì không báo
          } else if (data.type === "starting") { if (audio.paused) setStatus("Đang khởi động giọng AI…"); }
          else if (data.type === "ready") { sampleRate = data.sampleRate; setStatus(""); resolve(); }
          else if (data.type === "chunk") {
            const e = mem.get(data.key);
            if (!e) return;                                       // đoạn đã bỏ (đổi chương / nhảy xa): bỏ qua
            e.urls[data.idx] = wavBlob(data.wav);
            e.dur += data.wav.length / sampleRate;
            if (store) store.putChunk(data.key, data.idx, data.wav, sampleRate).catch(() => {});
            wake(e);
          } else if (data.type === "done") {
            const e = mem.get(data.key);
            if (!e) return;
            e.total = data.total; wake(e);
            if (store) store.finish(data.key, data.total).catch(() => {});
            if (state.playing) request(state.index);              // đã biết thời lượng thật → đệm tiếp cho đủ
          } else if (data.type === "error") {
            setStatus(`Giọng AI gặp lỗi: ${data.msg}`);
            reject(new Error(data.msg));
            mem.forEach(wake);
          }
        };
        worker.onerror = (e) => { setStatus("Trình duyệt này chưa chạy được giọng AI."); reject(e); };
      });
      worker.postMessage({ cmd: "init" });
      return ready;
    }

    // Các đoạn cần có sẵn: đoạn i rồi các đoạn sau cho tới khi đủ BUFFER_S giây; hết chương thì sang chương sau.
    function plan(i) {
      const out = [];
      let ahead = 0;
      for (let k = i; k < blocks.length && (k === i || ahead < BUFFER_S); k++) { out.push(textOf(k)); ahead += secondsOf(textOf(k)); }
      let left = 0;                                                   // còn bao nhiêu giây là hết chương
      for (let k = i; k < blocks.length; k++) left += secondsOf(textOf(k));
      if (left < NEXT_AT_S && nextFn && !nextTexts && !nextLoading) {
        nextLoading = true;
        Promise.resolve(nextFn()).then((t) => { nextTexts = t || []; }).catch(() => { nextTexts = []; })
          .finally(() => { nextLoading = false; if (state.playing) request(state.index); });
      }
      if (nextTexts) for (const t of nextTexts) { if (ahead >= BUFFER_S) break; out.push(t); ahead += secondsOf(t); }
      return out;
    }

    // Đảm bảo các đoạn trong plan(i) đã có / đang sinh; lấy từ kho trước, thiếu mới nhờ worker sinh.
    // Đoạn đang sinh dở mà không còn cần (nhảy xa, đổi chương) thì bỏ, để lần sau sinh lại từ đầu.
    async function request(i) {
      const items = plan(i).map((text) => ({ text, key: keyOf(text) }));
      const keys = new Set(items.map((x) => x.key));
      for (const [key, e] of mem) if (e.total === null && e.src === "worker" && !keys.has(key)) drop(key);
      const fresh = items.filter((x) => !mem.has(x.key));
      for (const x of fresh) mem.set(x.key, { urls: [], total: null, dur: 0, wait: null, src: "lookup" });
      await Promise.all(fresh.map(async (x) => {
        const e = mem.get(x.key);
        const saved = store ? await store.getPara(x.key).catch(() => null) : null;
        if (mem.get(x.key) !== e) return;
        if (saved) {
          e.urls = saved.map((f) => wavBlob(f)); e.total = saved.length; e.src = "store";
          e.dur = saved.reduce((s, f) => s + f.length / sampleRate, 0); wake(e);
        } else e.src = "worker";
      }));
      await flush();
    }

    // Gửi cho worker mọi đoạn trong kế hoạch HIỆN TẠI cần sinh mà chưa gửi, theo thứ tự cần.
    // Gọi sau mỗi lần tra kho xong (nhiều request chồng nhau thì lần nào xong cũng gửi được); gọi lặp lại vô hại.
    async function flush() {
      const want = () => plan(state.index).map((text) => ({ text, key: keyOf(text) }));
      const unsent = (items) => items.filter((x) => mem.get(x.key)?.src === "worker" && !mem.get(x.key).sent);
      let items = want();
      if (unsent(items).length) {
        try { await start(); } catch { return; }   // worker khởi động song song, chỉ chờ ở đây
        items = want();                                   // trong lúc chờ có thể người nghe đã nhảy đi chỗ khác
      }
      if (!worker) return;
      for (const x of unsent(items)) { mem.get(x.key).sent = true; worker.postMessage({ cmd: "para", key: x.key, text: x.text }); }
      // báo worker bỏ các việc cũ không còn cần (kể cả câu đang sinh dở) và xếp lại thứ tự
      worker.postMessage({ cmd: "keep", keys: items.map((x) => x.key) });
    }

    async function playBlock(i, my) {
      // không chờ worker: đoạn đã lưu trong kho phát ngay, worker khởi động ở nền
      start().catch(() => { if (my === session) { state.playing = false; emit(); } });
      const key = keyOf(textOf(i));
      request(i);
      const e = mem.get(key);
      for (let j = 0; ; j++) {
        while (e.urls[j] === undefined && (e.total === null || j < e.total)) {
          setStatus("Đang tạo giọng đọc…");
          await new Promise((r) => { e.wait = r; });
          if (my !== session) return;
        }
        if (e.total !== null && j >= e.total) break;
        setStatus("");
        audio.src = e.urls[j];
        audio.playbackRate = state.rate;
        try { await audio.play(); } catch { if (my === session) { state.playing = false; emit(); } return; }
        await new Promise((r) => { audio.onended = r; audio.onpause = () => { if (audio.ended || my !== session) r(); }; });
        if (my !== session) return;
      }
      speakFrom(i + 1);
    }

    function stopAudio() { audio.onended = audio.onpause = null; if (!audio.paused) audio.pause(); }

    // Sang chương mới: giữ các đoạn của chương này đã sinh sẵn (từ lúc sinh trước), bỏ phần còn lại.
    function reset(newBlocks = [], next = null) {
      stopAudio();
      const keep = new Set(newBlocks.map((b) => keyOf(b.textContent)));
      for (const key of [...mem.keys()]) if (!keep.has(key)) drop(key);
      nextFn = next; nextTexts = null; nextLoading = false;
      if (worker) worker.postMessage({ cmd: "keep", keys: [...mem.keys()] });
      setStatus("");
    }

    const debug = () => ({ mem: [...mem].map(([key, e]) => ({ key, total: e.total, have: e.urls.filter(Boolean).length, dur: +e.dur.toFixed(1), src: e.src, sent: !!e.sent })),
      nextTexts: nextTexts ? nextTexts.length : null, keyOf });

    return { playBlock, stopAudio, reset, debug, setRate: (r) => { audio.playbackRate = r; } };
  })();

  // ---------- API ----------
  return {
    supported,
    state,
    on(fn) { listeners.add(fn); },
    voices: () => [...(aiSupported ? [AI_VOICE] : []), ...(viVoices().length ? viVoices() : voices())],
    hasVietnamese: () => viVoices().length > 0 || usingAi(),
    status: () => state.status,

    // Gắn vào chương đang hiển thị. next(): trả (hoặc Promise) chữ các đoạn chương sau, để giọng AI sinh trước.
    attach(elements, finished, next = null) {
      ai.reset([...elements], next);
      blocks = [...elements];
      onFinish = finished;
      state.total = blocks.length;
      state.index = 0;
    },
    detach() {
      session++;
      if (webSpeech) synth.cancel();
      // chỉ dừng phát, KHÔNG xoá audio giọng AI: chuyển sang chương sau thì attach() giữ lại phần đã sinh trước
      ai.stopAudio();
      state.playing = false;
      blocks = [];
      onFinish = null;
    },
    play(i = state.index) { if (supported && blocks.length) speakFrom(Math.max(0, Math.min(i, blocks.length - 1))); },
    pause() {
      session++;
      if (webSpeech) synth.cancel();
      ai.stopAudio();
      state.playing = false;
      emit();
    },
    toggle() { state.playing ? this.pause() : this.play(); },
    stop() {
      this.pause();
      blocks.forEach((b) => b.classList.remove("tts-on"));
    },
    next() { this.play(state.index + 1); },
    prev() { this.play(state.index - 1); },
    setRate(r) {
      state.rate = r; save();
      if (usingAi()) { ai.setRate(r); emit(); return; }   // audio đổi tốc độ ngay, không cần đọc lại
      if (state.playing) this.play(state.index); else emit();
    },
    setVoice(uri) { state.voice = uri; save(); if (state.playing) this.play(state.index); else emit(); },
    // chỉ dùng khi chạy thử: thay bộ đọc thật bằng bộ giả
    _useEngine(fake) { synth = fake; },
    _ai: () => ai.debug(),   // chỉ dùng khi chạy thử: xem bộ đệm giọng AI
  };
})();
