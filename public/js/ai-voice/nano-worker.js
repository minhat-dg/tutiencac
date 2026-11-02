// Giọng AI "Người kể chuyện": VieNeu-TTS v3 Nano chạy ngay trong trình duyệt (Web Worker, onnxruntime-web).
// Nhận từng đoạn văn, tự chia câu + chuyển âm vị (vi-frontend.js), sinh audio từng câu và gửi về ngay
// để trang đọc phát được câu đầu trong khi các câu sau còn đang sinh.
//
// Tin nhắn vào:  {cmd:"init"} · {cmd:"para", key, text} · {cmd:"keep", keys:[...]} (bỏ các đoạn chưa sinh không còn cần)
// Tin nhắn ra :  {type:"progress", loaded, total} · {type:"ready"} · {type:"chunk", key, idx, total, wav(Float32 24 kHz)}
//                {type:"done", key, total} · {type:"error", msg}
import { ViG2P } from "./vi-frontend.js";

const ORT_DIST = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/";
// ghim đúng bản model đã kiểm tra, để bản cập nhật trên Hugging Face không làm đổi giọng
const MODEL_BASE = "https://huggingface.co/pnnbao-ump/VieNeu-TTS-v3-Nano/resolve/aba295eb96a6fa6003ebe417cc1f2802a7adc1dc/";
const MODEL_FILES = ["text_encoder.onnx", "duration_predictor.onnx", "vector_estimator.onnx", "codec_decoder.onnx"];
const CACHE = "ai-voice-models-v1";
const STEPS = 8, CFG = 3.0;
// khoảng nghỉ sau mỗi câu (giây): theo dấu câu cuối, và dài hơn khi hết đoạn văn
const GAP_COMMA_S = 0.2, GAP_SENTENCE_S = 0.4, GAP_PARAGRAPH_S = 0.7;

let ort, g2p, cfg, voice, sess, nullCtx, ready;
let downloading = false;   // true nếu có model phải tải qua mạng (chưa có trong cache)
const queue = [];
let busy = false, current = null;   // current: đoạn đang sinh dở (đã rời hàng đợi)
const post = (msg, transfer) => self.postMessage(msg, transfer || []);

// Tải có lưu Cache Storage (lần sau mở ngay, đọc được khi mất mạng) + báo tiến độ tải
async function cachedBytes(url, onBytes) {
  const cache = await caches.open(CACHE);
  let res = await cache.match(url);
  if (!res) {
    downloading = true;
    const net = await fetch(url);
    if (!net.ok) throw new Error(`Không tải được ${url.split("/").pop()} (HTTP ${net.status})`);
    await cache.put(url, net.clone());
    res = net;
  }
  const total = +res.headers.get("content-length") || 0, reader = res.body.getReader(), parts = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value); got += value.length; onBytes(value.length, total);
  }
  const out = new Uint8Array(got);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

async function init() {
  const m = await import(`${ORT_DIST}ort.webgpu.min.mjs`);
  ort = m;
  ort.env.wasm.wasmPaths = ORT_DIST;
  // đa luồng chỉ có khi trang được cô lập cross-origin (header COOP/COEP); không có thì 1 luồng
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1)) : 1;

  const [nanoCfg, table, extra, vc] = await Promise.all([
    fetch(MODEL_BASE + "config.json").then((r) => r.json()),
    fetch("/ai-voice/g2p_vi.json").then((r) => r.json()),
    fetch("/ai-voice/nano.json").then((r) => r.json()),
    fetch("/ai-voice/narrator.json").then((r) => r.json()),
  ]);
  g2p = new ViG2P(table, nanoCfg);
  cfg = { ...extra, pad: nanoCfg.pad_id };
  const f32 = (a, d) => new ort.Tensor("float32", Float32Array.from(a), d);
  voice = { spk: f32(vc.spk, [1, 192]), style: f32(vc.style.flat(), [1, 50, 256]),
    nullSpk: f32(extra.null_spk, [1, 192]), nullStyle: f32(extra.null_style.flat(), [1, 50, 256]) };

  // tải 4 model (~275 MB lần đầu), báo tiến độ chung
  const sizes = {}, seen = {};
  const progress = () => post({ type: "progress", loaded: Object.values(seen).reduce((a, b) => a + b, 0),
    total: Object.values(sizes).reduce((a, b) => a + b, 0), downloading });
  const bytes = await Promise.all(MODEL_FILES.map((f) => cachedBytes(MODEL_BASE + f, (n, total) => {
    sizes[f] = total; seen[f] = (seen[f] || 0) + n; progress();
  })));
  post({ type: "starting" });
  const opt = { executionProviders: ["wasm"], graphOptimizationLevel: "all" };
  sess = {};
  for (let i = 0; i < MODEL_FILES.length; i++) sess[MODEL_FILES[i].replace(".onnx", "")] = await ort.InferenceSession.create(bytes[i], opt);
  // ngữ cảnh "rỗng" cho CFG không phụ thuộc giọng → tính một lần
  nullCtx = (await sess.text_encoder.run({ ids: i64([nanoCfg.bos_id, nanoCfg.eos_id], [1, 2]), style: voice.nullStyle })).ctx;
}

const i64 = (a, d) => new ort.Tensor("int64", BigInt64Array.from(a.map(BigInt)), d);
const bool = (a, d) => new ort.Tensor("bool", Uint8Array.from(a), d);

function randn(n) {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 2) {
    const r = Math.sqrt(-2 * Math.log(1 - Math.random())), th = 2 * Math.PI * Math.random();
    out[i] = r * Math.cos(th);
    if (i + 1 < n) out[i + 1] = r * Math.sin(th);
  }
  return out;
}

// cắt im lặng hai đầu (giữ 40 ms) + fade 15 ms, như vieneu_utils.core_utils.trim_and_fade
function trimAndFade(w, sr) {
  const win = Math.round(0.01 * sr), th = 10 ** (-45 / 20);
  let first = -1, last = -1;
  for (let k = 0; k + win <= w.length; k += win) {
    let s = 0;
    for (let j = k; j < k + win; j++) s += Math.abs(w[j]);
    if (s / win > th) { if (first < 0) first = k; last = k + win; }
  }
  if (first < 0) return w;
  const keep = Math.round(0.04 * sr), out = w.slice(Math.max(0, first - keep), Math.min(w.length, last + keep));
  const n = Math.min(Math.round(0.015 * sr), out.length >> 1);
  for (let i = 0; i < n; i++) { const g = 0.5 - 0.5 * Math.cos((Math.PI * i) / n); out[i] *= g; out[out.length - 1 - i] *= g; }
  return out;
}

// một câu (ids) → audio 24 kHz. Port của vieneu/v3nano.py OnnxV3NanoEngine.infer
// job.dropped được kiểm tra sau MỖI lần chạy model: đoạn bị bỏ (người nghe nhảy đoạn / đổi chương) thì
// dừng ngay giữa câu và trả null, không phải chờ sinh nốt cả câu.
// session.run() của ORT xong qua microtask, không nhường cho hàng đợi tin nhắn → phải tự nhường (yieldMsgs)
// thì tin "keep" mới được xử lý giữa chừng.
const chan = new MessageChannel(), waiters = [];
chan.port1.onmessage = () => waiters.shift()();
const yieldMsgs = () => new Promise((r) => { waiters.push(r); chan.port2.postMessage(0); });
async function synth(ids, job) {
  const C = cfg.latent_channels, L = ids.length;
  const idsT = i64(ids, [1, L]), mask = bool(ids.map((x) => (x !== cfg.pad ? 1 : 0)), [1, L]);
  const nullMask = bool([1, 1], [1, 2]);
  await yieldMsgs();
  if (job.dropped) return null;
  const ctx = (await sess.text_encoder.run({ ids: idsT, style: voice.style })).ctx;
  const logS = (await sess.duration_predictor.run({ ctx, ctx_mask: mask, spk: voice.spk })).log_seconds.data[0];
  const T = Math.max(cfg.min_frames, Math.round(Math.min(Math.exp(logS), cfg.max_chunk_seconds) * cfg.fps));
  let x = randn(C * T);
  for (let i = 0; i < STEPS; i++) {
    await yieldMsgs();
    if (job.dropped) return null;
    const t = new ort.Tensor("float32", Float32Array.of(i / STEPS), [1]), xt = new ort.Tensor("float32", x, [1, C, T]);
    const vc = (await sess.vector_estimator.run({ x: xt, t, ctx, ctx_mask: mask, spk: voice.spk, style: voice.style })).v.data;
    await yieldMsgs();
    if (job.dropped) return null;
    const vu = (await sess.vector_estimator.run({ x: xt, t, ctx: nullCtx, ctx_mask: nullMask, spk: voice.nullSpk, style: voice.nullStyle })).v.data;
    const nx = new Float32Array(x.length), dt = 1 / STEPS;
    for (let k = 0; k < x.length; k++) nx[k] = x[k] + dt * (vu[k] + CFG * (vc[k] - vu[k]));
    x = nx;
  }
  await yieldMsgs();
  if (job.dropped) return null;
  const w = (await sess.codec_decoder.run({ x: new ort.Tensor("float32", x, [1, C, T]) })).wav.data;
  const wav = new Float32Array(w.length);
  for (let k = 0; k < w.length; k++) wav[k] = Math.max(-1, Math.min(1, w[k]));
  return trimAndFade(wav, cfg.sample_rate);
}

async function pump() {
  if (busy) return;
  busy = true;
  try {
    while (queue.length) {
      const job = current = queue.shift();
      const chunks = g2p.paragraph(job.text);
      for (let i = 0; i < chunks.length; i++) {
        if (job.dropped) break;
        const wav = await synth(chunks[i].ids, job);
        if (!wav) break;                                                        // bị hủy giữa câu
        const gapS = i === chunks.length - 1 ? GAP_PARAGRAPH_S : /[.!?]$/.test(chunks[i].text) ? GAP_SENTENCE_S : GAP_COMMA_S;
        const out = new Float32Array(wav.length + Math.round(gapS * cfg.sample_rate));   // phần thêm = im lặng
        out.set(wav);
        post({ type: "chunk", key: job.key, idx: i, total: chunks.length, wav: out }, [out.buffer]);
      }
      if (!job.dropped) post({ type: "done", key: job.key, total: chunks.length });
    }
  } catch (e) {
    post({ type: "error", msg: String((e && e.message) || e) });
  } finally {
    busy = false; current = null;
  }
}

self.onmessage = async ({ data }) => {
  try {
    if (data.cmd === "init") {
      ready = ready || init();
      await ready;
      post({ type: "ready", sampleRate: cfg.sample_rate });
    } else if (data.cmd === "para") {
      await ready;
      if (!queue.some((j) => j.key === data.key)) queue.push({ key: data.key, text: data.text });
      pump();
    } else if (data.cmd === "keep") {
      const keep = new Set(data.keys);
      for (let i = queue.length - 1; i >= 0; i--) if (!keep.has(queue[i].key)) { queue[i].dropped = true; queue.splice(i, 1); }
      if (current && !keep.has(current.key)) current.dropped = true;   // dừng đoạn đang sinh dở ngay sau lần chạy model hiện tại
      // xếp lại hàng đợi theo thứ tự cần (đoạn sắp đọc trước)
      const order = new Map(data.keys.map((k, i) => [k, i]));
      queue.sort((a, b) => order.get(a.key) - order.get(b.key));
    }
  } catch (e) {
    post({ type: "error", msg: String((e && e.message) || e) });
  }
};
