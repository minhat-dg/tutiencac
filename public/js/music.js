// Nhạc nền: các bài dựng sẵn được tổng hợp trực tiếp bằng Web Audio (không cần file),
// cộng thêm các bài admin tải lên Bunny (music/catalog.json).
window.Music = (() => {
  "use strict";

  const BUILTIN = [
    { id: "thanh-son", title: "Thanh Sơn Tĩnh Tọa", desc: "Cổ cầm, âm trầm" },
    { id: "van-hai", title: "Vân Hải Phiêu Diêu", desc: "Tiếng tiêu, gió, biển mây" },
    { id: "truc-lam", title: "Trúc Lâm Thính Vũ", desc: "Mưa rừng trúc, cổ cầm" },
    { id: "linh-tuyen", title: "Linh Tuyền Cổ Động", desc: "Giọt nước, chuông đồng" },
  ];
  let uploaded = []; // [{id: "up:<id>", title, url}]

  const saved = (() => { try { return JSON.parse(localStorage.getItem("music")) || {}; } catch { return {}; } })();
  const state = { id: saved.id || BUILTIN[0].id, volume: saved.volume ?? 0.5, playing: false };
  const save = () => { try { localStorage.setItem("music", JSON.stringify({ id: state.id, volume: state.volume, playing: state.playing })); } catch {} };
  const listeners = new Set();
  const emit = () => listeners.forEach((fn) => fn(state));

  let ctx, master, reverb, noiseBuf, session, audioEl;

  // ---------- audio graph ----------
  function ensureCtx() {
    if (ctx) return;
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain();
    master.gain.value = state.volume;
    master.connect(ctx.destination);
    reverb = ctx.createConvolver();
    reverb.buffer = impulse(5, 3);
    const wet = ctx.createGain();
    wet.gain.value = 0.55;
    reverb.connect(wet).connect(master);
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  function impulse(sec, decay) {
    const len = ctx.sampleRate * sec, buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    return buf;
  }

  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const osc = (type, f) => { const o = ctx.createOscillator(); o.type = type; o.frequency.value = f; return o; };
  const gain = (v) => { const g = ctx.createGain(); g.gain.value = v; return g; };
  const filter = (type, f, q = 0.7) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; return b; };
  function noise() { const s = ctx.createBufferSource(); s.buffer = noiseBuf; s.loop = true; return s; }
  function env(g, t, peak, a, d) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
  }
  function lfo(S, rate, depth, target) {
    const o = osc("sine", rate), g = gain(depth);
    o.connect(g).connect(target);
    o.start();
    S.sources.push(o);
  }

  // pentatonic helpers
  const GONG = [0, 2, 4, 7, 9];   // cung (trưởng ngũ cung)
  const YU = [0, 3, 5, 7, 10];    // vũ (thứ ngũ cung)
  function note(root, scale, deg) {
    const o = Math.floor(deg / scale.length), i = ((deg % scale.length) + scale.length) % scale.length;
    return root * Math.pow(2, (scale[i] + 12 * o) / 12);
  }
  function walker(root, scale, lo, hi) {
    let d = Math.round((lo + hi) / 2);
    return () => {
      d = Math.max(lo, Math.min(hi, d + pick([-2, -1, -1, 0, 1, 1, 2])));
      return note(root, scale, d);
    };
  }
  // phrases of a few notes separated by rests; play(t) may return its own duration
  function melody(play, { notes, gaps, rest }) {
    let left = 0;
    return (t) => {
      if (left <= 0) { left = Math.round(rand(notes[0], notes[1])); return rand(rest[0], rest[1]); }
      left--;
      return play(t) ?? pick(gaps);
    };
  }

  // ---------- instruments ----------
  function pluck(S, t, f, v = 0.22, dur = 4) { // cổ cầm
    const g = gain(0); env(g, t, v, 0.005, dur);
    const lp = filter("lowpass", f * 8);
    lp.frequency.setValueAtTime(f * 8, t);
    lp.frequency.exponentialRampToValueAtTime(f * 1.5, t + dur * 0.7);
    lp.connect(g).connect(S.out);
    for (const [m, type, a] of [[1, "triangle", 1], [2, "sine", 0.35], [3, "sine", 0.12]]) {
      const o = osc(type, f * m);
      o.frequency.setValueAtTime(f * m * 1.012, t);
      o.frequency.exponentialRampToValueAtTime(f * m, t + 0.07);
      o.connect(gain(a)).connect(lp);
      o.start(t); o.stop(t + dur + 0.1);
    }
  }
  function bell(S, t, f, v = 0.08, dur = 6) { // chuông đồng
    for (const [m, a, d] of [[1, 1, dur], [2.76, 0.45, dur * 0.5], [5.4, 0.18, dur * 0.25]]) {
      const o = osc("sine", f * m), g = gain(0);
      env(g, t, v * a, 0.004, d);
      o.connect(g).connect(S.out);
      o.start(t); o.stop(t + d + 0.1);
    }
  }
  function xiao(S, t, f, dur, v = 0.09) { // tiêu
    const g = gain(0);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(v, t + 0.35);
    g.gain.setValueAtTime(v, t + Math.max(0.4, dur - 0.3));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.7);
    const lp = filter("lowpass", f * 3);
    lp.connect(g).connect(S.out);
    const o = osc("sine", f), o2 = osc("triangle", f);
    o.connect(lp); o2.connect(gain(0.2)).connect(lp);
    const vib = osc("sine", 5), vg = gain(0);
    vg.gain.setValueAtTime(0, t);
    vg.gain.linearRampToValueAtTime(f * 0.008, t + 0.8);
    vib.connect(vg); vg.connect(o.frequency); vg.connect(o2.frequency);
    const br = noise(), bp = filter("bandpass", f * 2, 2), bg = gain(0);
    env(bg, t, v * 0.12, 0.2, dur);
    br.connect(bp).connect(bg).connect(S.out);
    const end = t + dur + 0.8;
    for (const s of [o, o2, vib, br]) { s.start(t); s.stop(end); }
  }
  function pad(S, t, freqs, dur, v = 0.03) {
    const g = gain(0);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(v, t + dur * 0.4);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const lp = filter("lowpass", 700);
    lp.connect(g).connect(S.out);
    for (const f of freqs) for (const det of [-6, 6]) {
      const o = osc("sawtooth", f); o.detune.value = det;
      o.connect(lp); o.start(t); o.stop(t + dur + 0.1);
    }
  }
  function drone(S, f, v = 0.05) {
    const g = gain(v), lp = filter("lowpass", f * 4);
    lp.connect(g).connect(S.out);
    [[f, "sine", 1], [f * 1.002, "sine", 0.7], [f * 1.5, "triangle", 0.35], [f * 2, "sine", 0.2]].forEach(([ff, type, a]) => {
      const o = osc(type, ff);
      o.connect(gain(a)).connect(lp);
      o.start(); S.sources.push(o);
    });
    lfo(S, 0.05, v * 0.4, g.gain);
  }
  function rain(S, v = 0.05) {
    const n = noise(), hp = filter("highpass", 900), lp = filter("lowpass", 7000), g = gain(v);
    n.connect(hp).connect(lp).connect(g).connect(S.out);
    const n2 = noise(), lp2 = filter("lowpass", 350), g2 = gain(v * 0.6);
    n2.connect(lp2).connect(g2).connect(S.out);
    n.start(); n2.start(); S.sources.push(n, n2);
    lfo(S, 0.07, v * 0.3, g.gain);
  }
  function wind(S, v = 0.035) {
    const n = noise(), bp = filter("bandpass", 500, 0.8), g = gain(v);
    n.connect(bp).connect(g).connect(S.out);
    n.start(); S.sources.push(n);
    lfo(S, 0.06, 300, bp.frequency);
    lfo(S, 0.045, v * 0.6, g.gain);
  }
  function drop(S, t, v = 0.05) {
    const f = rand(900, 2100), o = osc("sine", f), g = gain(0);
    o.frequency.setValueAtTime(f, t);
    o.frequency.exponentialRampToValueAtTime(f * 0.55, t + 0.12);
    env(g, t, v, 0.003, 0.2);
    o.connect(g).connect(S.out);
    o.start(t); o.stop(t + 0.3);
  }

  // ---------- presets: each sets up beds and returns scheduled voices ----------
  const PRESETS = {
    "thanh-son"(S, now) {
      const root = 146.83; // D
      drone(S, root / 2, 0.05);
      const w = walker(root * 2, GONG, -2, 8);
      return [{
        next: now + 1,
        fn: melody((t) => { const f = w(); pluck(S, t, f); if (Math.random() < 0.2) pluck(S, t + 0.03, f / 2, 0.12); },
          { notes: [3, 6], gaps: [0.7, 1, 1, 1.5, 2], rest: [3, 6] }),
      }];
    },
    "van-hai"(S, now) {
      const root = 174.61; // F
      wind(S);
      const chords = [[0, 2, 4], [-1, 1, 3], [1, 3, 5], [0, 3, 5]];
      let ci = 0;
      const w = walker(root * 2, GONG, 0, 7);
      return [
        { next: now + 0.2, fn: (t) => { pad(S, t, chords[ci++ % chords.length].map((d) => note(root / 2, GONG, d)), 12); return 9; } },
        { next: now + 4, fn: melody((t) => { const dur = pick([1.5, 2, 3]); xiao(S, t, w(), dur); return dur + 0.2; },
          { notes: [2, 5], gaps: [2], rest: [4, 8] }) },
      ];
    },
    "truc-lam"(S, now) {
      const root = 220; // A
      rain(S);
      drone(S, root / 4, 0.03);
      const w = walker(root, YU, 0, 9);
      return [{
        next: now + 2,
        fn: melody((t) => { pluck(S, t, w(), 0.16, 4.5); }, { notes: [2, 5], gaps: [0.9, 1.3, 1.8], rest: [4, 9] }),
      }];
    },
    "linh-tuyen"(S, now) {
      const root = 130.81; // C
      drone(S, root / 2, 0.06);
      const w = walker(root * 4, GONG, 0, 6);
      return [
        { next: now + 0.5, fn: (t) => { drop(S, t); return rand(0.3, 2.5); } },
        { next: now + 3, fn: (t) => { bell(S, t, w()); return rand(2.5, 6); } },
      ];
    },
  };

  function startSynth(id) {
    ensureCtx();
    const out = gain(0);
    out.connect(master); out.connect(reverb);
    const now = ctx.currentTime;
    out.gain.setValueAtTime(0, now);
    out.gain.linearRampToValueAtTime(1, now + 3);
    const S = { out, sources: [], timer: 0 };
    const voices = PRESETS[id](S, now + 0.1);
    const tick = () => {
      const horizon = ctx.currentTime + 1.2;
      for (const v of voices) while (v.next < horizon) v.next += v.fn(v.next);
    };
    tick();
    S.timer = setInterval(tick, 250);
    return S;
  }
  function stopSynth(S) {
    clearInterval(S.timer);
    const t = ctx.currentTime;
    S.out.gain.cancelScheduledValues(t);
    S.out.gain.setValueAtTime(S.out.gain.value, t);
    S.out.gain.linearRampToValueAtTime(0, t + 1.5);
    setTimeout(() => { S.sources.forEach((s) => { try { s.stop(); } catch {} }); S.out.disconnect(); }, 1700);
  }

  function stopAll() {
    if (session) { stopSynth(session); session = null; }
    if (audioEl) { audioEl.pause(); audioEl = null; }
  }

  // ---------- public API ----------
  function list() { return [...BUILTIN, ...uploaded]; }

  async function play(id = state.id) {
    if (!list().some((t) => t.id === id)) id = BUILTIN[0].id;
    stopAll();
    state.id = id;
    state.playing = true;
    const up = uploaded.find((t) => t.id === id);
    if (up) {
      audioEl = new Audio(up.url);
      audioEl.loop = true;
      audioEl.volume = state.volume;
      audioEl.play().catch(() => { state.playing = false; save(); emit(); });
    } else {
      ensureCtx();
      await ctx.resume();
      session = startSynth(id);
    }
    save(); emit();
  }
  function pause() { stopAll(); state.playing = false; save(); emit(); }
  function toggle() { state.playing ? pause() : play(); }
  function setVolume(v) {
    state.volume = v;
    if (master) master.gain.setTargetAtTime(v, ctx.currentTime, 0.1);
    if (audioEl) audioEl.volume = v;
    save(); emit();
  }
  function setUploaded(tracks) { uploaded = tracks; emit(); }

  // Browsers block audio until the user interacts, so resume on the first gesture.
  if (saved.playing) {
    const resume = () => { removeEventListener("pointerdown", resume); removeEventListener("keydown", resume); play(state.id); };
    addEventListener("pointerdown", resume);
    addEventListener("keydown", resume);
  }

  return { state, list, play, pause, toggle, setVolume, setUploaded, on: (fn) => listeners.add(fn) };
})();
