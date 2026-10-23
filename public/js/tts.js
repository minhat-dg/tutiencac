// Nghe truyện: đọc to bằng giọng có sẵn trên máy (Web Speech API), không cần máy chủ.
window.TTS = (() => {
  "use strict";

  let synth = window.speechSynthesis;
  const supported = !!synth && "SpeechSynthesisUtterance" in window;

  const saved = (() => { try { return JSON.parse(localStorage.getItem("tts")) || {}; } catch { return {}; } })();
  const state = { playing: false, index: 0, total: 0, rate: saved.rate || 1, voice: saved.voice || "" };
  const save = () => { try { localStorage.setItem("tts", JSON.stringify({ rate: state.rate, voice: state.voice })); } catch {} };
  const listeners = new Set();
  const emit = () => listeners.forEach((fn) => fn(state));

  let blocks = [];       // các đoạn đang đọc: tiêu đề chương + từng <p>
  let onFinish = null;   // gọi khi đọc hết chương
  let session = 0;       // tăng mỗi lần dừng, để bỏ qua sự kiện cũ còn sót

  // ---------- giọng đọc ----------
  function voices() { return supported ? synth.getVoices() : []; }
  function viVoices() { return voices().filter((v) => /^vi\b|^vi-/i.test(v.lang)); }
  function pickVoice() {
    const all = voices();
    return all.find((v) => v.voiceURI === state.voice) || viVoices()[0] || null;
  }
  if (supported && "onvoiceschanged" in synth) synth.addEventListener("voiceschanged", emit);

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
    synth.cancel();
    if (i >= blocks.length) return finish();
    state.index = i;
    state.playing = true;
    mark(i);
    emit();
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

  // ---------- API ----------
  return {
    supported,
    state,
    on(fn) { listeners.add(fn); },
    voices: () => (viVoices().length ? viVoices() : voices()),
    hasVietnamese: () => viVoices().length > 0,

    // Gắn vào chương đang hiển thị.
    attach(elements, finished) {
      blocks = [...elements];
      onFinish = finished;
      state.total = blocks.length;
      state.index = 0;
    },
    detach() {
      session++;
      if (supported) synth.cancel();
      state.playing = false;
      blocks = [];
      onFinish = null;
    },
    play(i = state.index) { if (supported && blocks.length) speakFrom(Math.max(0, Math.min(i, blocks.length - 1))); },
    pause() {
      session++;
      if (supported) synth.cancel();
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
    setRate(r) { state.rate = r; save(); if (state.playing) this.play(state.index); else emit(); },
    setVoice(uri) { state.voice = uri; save(); if (state.playing) this.play(state.index); else emit(); },
    // chỉ dùng khi chạy thử: thay bộ đọc thật bằng bộ giả
    _useEngine(fake) { synth = fake; },
  };
})();
