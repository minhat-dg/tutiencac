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
  // Luôn sinh trước AHEAD đoạn phía sau đoạn đang đọc để khi đang nghe không phải chờ.
  const ai = (() => {
    const AHEAD = 3;
    let worker = null, ready = null, sampleRate = 24000;
    let paras = new Map();            // index đoạn → { urls: [], total: số câu hoặc null, wait: fn | null }
    const audio = new Audio();
    audio.preservesPitch = true;

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

    function entry(i) {
      if (!paras.has(i)) paras.set(i, { urls: [], total: null, wait: null });
      return paras.get(i);
    }
    const wake = (e) => { if (e.wait) { const f = e.wait; e.wait = null; f(); } };

    function start() {
      if (ready) return ready;
      // xin lưu trữ bền vững để trình duyệt không tự xoá model (~280 MB) khi thiếu dung lượng
      try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch {}
      worker = new Worker("/js/ai-voice/nano-worker.js", { type: "module" });
      ready = new Promise((resolve, reject) => {
        worker.onmessage = ({ data }) => {
          if (data.type === "progress") {
            const pct = data.total ? Math.floor((data.loaded / data.total) * 100) : 0;
            setStatus(data.downloading ? `Đang tải giọng AI lần đầu (khoảng 280 MB, chỉ tải một lần): ${pct}%` : "Đang khởi động giọng AI…");
          } else if (data.type === "starting") setStatus("Đang khởi động giọng AI…");
          else if (data.type === "ready") { sampleRate = data.sampleRate; setStatus(""); resolve(); }
          else if (data.type === "chunk") {
            const e = entry(data.key);
            e.urls[data.idx] = wavBlob(data.wav); e.total = data.total; wake(e);
          } else if (data.type === "done") { const e = entry(data.key); e.total = data.total; wake(e); }
          else if (data.type === "error") {
            setStatus(`Giọng AI gặp lỗi: ${data.msg}`);
            reject(new Error(data.msg));
            paras.forEach(wake);
          }
        };
        worker.onerror = (e) => { setStatus("Trình duyệt này chưa chạy được giọng AI."); reject(e); };
      });
      worker.postMessage({ cmd: "init" });
      return ready;
    }

    // yêu cầu sinh các đoạn i..i+AHEAD, bỏ các việc đang xếp hàng không còn cần
    function request(i) {
      const keys = [];
      for (let k = i; k < Math.min(blocks.length, i + 1 + AHEAD); k++) {
        keys.push(k);
        if (!paras.has(k)) { entry(k); worker.postMessage({ cmd: "para", key: k, text: blocks[k].textContent }); }
      }
      worker.postMessage({ cmd: "keep", keys });
    }

    async function playBlock(i, my) {
      try { await start(); } catch { if (my === session) { state.playing = false; emit(); } return; }
      if (my !== session) return;
      request(i);
      const e = entry(i);
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

    function reset() {
      stopAudio();
      paras.forEach((e) => { e.urls.forEach((u) => u && URL.revokeObjectURL(u)); });
      paras = new Map();
      if (worker) worker.postMessage({ cmd: "keep", keys: [] });
      setStatus("");
    }

    return { playBlock, stopAudio, reset, setRate: (r) => { audio.playbackRate = r; } };
  })();

  // ---------- API ----------
  return {
    supported,
    state,
    on(fn) { listeners.add(fn); },
    voices: () => [...(aiSupported ? [AI_VOICE] : []), ...(viVoices().length ? viVoices() : voices())],
    hasVietnamese: () => viVoices().length > 0 || usingAi(),
    status: () => state.status,

    // Gắn vào chương đang hiển thị.
    attach(elements, finished) {
      ai.reset();
      blocks = [...elements];
      onFinish = finished;
      state.total = blocks.length;
      state.index = 0;
    },
    detach() {
      session++;
      if (webSpeech) synth.cancel();
      ai.reset();
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
  };
})();
