// Giọng AI "Người kể chuyện": VieNeu-TTS v3 Nano chạy ngay trong trình duyệt (Web Worker, onnxruntime-web).
// Nhận từng đoạn văn, tự chia câu + chuyển âm vị (vi-frontend.js), sinh audio từng câu và gửi về ngay
// để trang đọc phát được câu đầu trong khi các câu sau còn đang sinh.
//
// Tin nhắn vào:  {cmd:"init", threads} · {cmd:"para", key, text, fast} · {cmd:"keep", keys:[...]} (bỏ các đoạn chưa sinh không còn cần)
//                fast: người nghe đang chờ đoạn này → cắt câu đầu ngắn lại cho có tiếng sớm
// Tin nhắn ra :  {type:"progress", loaded, total} · {type:"ready", threads} · {type:"chunk", key, idx, total, wav(Float32 24 kHz), ms}
//                {type:"done", key, total} · {type:"error", msg}
import { ViG2P } from "./vi-frontend.js";

const ORT_DIST = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/";
// ghim đúng bản model đã kiểm tra, để bản cập nhật trên Hugging Face không làm đổi giọng
const MODEL_BASE = "https://huggingface.co/pnnbao-ump/VieNeu-TTS-v3-Nano/resolve/aba295eb96a6fa6003ebe417cc1f2802a7adc1dc/";
const MODEL_FILES = ["text_encoder.onnx", "duration_predictor.onnx", "vector_estimator.onnx", "codec_decoder.onnx"];
const CACHE = "ai-voice-models-v1";
// 6 bước flow matching, CFG chỉ ở 4 bước đầu: 10 lần chạy vector_estimator mỗi câu thay vì 16
// (bản gốc 8 bước, mỗi bước 2 lần vì CFG). Đo trên câu mẫu: giọng khác bản gốc ít hơn nhiều so với độ khác tự nhiên
// giữa hai lần sinh cùng một câu (đổi hạt nhiễu), mà nhanh hơn ~1,6 lần.
const STEPS = 6, CFG_STEPS = 4, CFG = 3.0;
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

async function init(threads) {
  const m = await import(`${ORT_DIST}ort.webgpu.min.mjs`);
  ort = m;
  ort.env.wasm.wasmPaths = ORT_DIST;
  // đa luồng chỉ có khi trang được cô lập cross-origin (header COOP/COEP); không có thì 1 luồng.
  // Số luồng do trang chọn (tự dò theo tốc độ đo được): CPU có nhân hiệu năng + nhân tiết kiệm điện
  // thường chạy 2 luồng nhanh hơn 4, vì nhiều luồng phải chờ nhân yếu.
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.max(1, Math.min(threads || 2, (navigator.hardwareConcurrency || 2) - 1)) : 1;

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
    const nx = new Float32Array(x.length), dt = 1 / STEPS;
    if (i < CFG_STEPS) {
      await yieldMsgs();
      if (job.dropped) return null;
      const vu = (await sess.vector_estimator.run({ x: xt, t, ctx: nullCtx, ctx_mask: nullMask, spk: voice.nullSpk, style: voice.nullStyle })).v.data;
      for (let k = 0; k < x.length; k++) nx[k] = x[k] + dt * (vu[k] + CFG * (vc[k] - vu[k]));
    } else {
      for (let k = 0; k < x.length; k++) nx[k] = x[k] + dt * vc[k];
    }
    x = nx;
  }
  await yieldMsgs();
  if (job.dropped) return null;
  const w = (await sess.codec_decoder.run({ x: new ort.Tensor("float32", x, [1, C, T]) })).wav.data;
  const wav = new Float32Array(w.length);
  for (let k = 0; k < w.length; k++) wav[k] = Math.max(-1, Math.min(1, w[k]));
  return trimAndFade(wav, cfg.sample_rate);
}

// Câu đầu dài (tới 140 ký tự ≈ 9 giây) thì phải chờ sinh xong cả câu mới có tiếng: tách ở dấu phẩy
// đầu tiên (sau 25 ký tự) thành một mẩu ngắn để phát sớm, phần còn lại sinh trong lúc mẩu đầu đang phát.
const QUICK_MIN = 25, QUICK_MAX = 70;
function quickStart(chunks) {
  const c = chunks[0];
  if (!c || c.text.length <= QUICK_MAX) return chunks;
  const cut = c.text.indexOf(", ", QUICK_MIN);
  if (cut < 0 || cut > QUICK_MAX || c.text.length - cut < QUICK_MIN) return chunks;
  const part = (t) => { const phones = g2p.phonemize(t); return { text: t, phones, ids: g2p.ids(phones) }; };
  return [part(c.text.slice(0, cut + 1)), part(c.text.slice(cut + 2)), ...chunks.slice(1)];
}

async function pump() {
  if (busy) return;
  busy = true;
  try {
    while (queue.length) {
      const job = current = queue.shift();
      const chunks = job.fast ? quickStart(g2p.paragraph(job.text)) : g2p.paragraph(job.text);
      for (let i = 0; i < chunks.length; i++) {
        if (job.dropped) break;
        const t0 = performance.now();
        const wav = await synth(chunks[i].ids, job);
        if (!wav) break;                                                        // bị hủy giữa câu
        const gapS = i === chunks.length - 1 ? GAP_PARAGRAPH_S : /[.!?]$/.test(chunks[i].text) ? GAP_SENTENCE_S : GAP_COMMA_S;
        const out = new Float32Array(wav.length + Math.round(gapS * cfg.sample_rate));   // phần thêm = im lặng
        out.set(wav);
        post({ type: "chunk", key: job.key, idx: i, total: chunks.length, wav: out, ms: performance.now() - t0 }, [out.buffer]);
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
      ready = ready || init(data.threads);
      await ready;
      post({ type: "ready", sampleRate: cfg.sample_rate, threads: ort.env.wasm.numThreads });
    } else if (data.cmd === "para") {
      await ready;
      if (!queue.some((j) => j.key === data.key)) queue.push({ key: data.key, text: data.text, fast: !!data.fast });
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
