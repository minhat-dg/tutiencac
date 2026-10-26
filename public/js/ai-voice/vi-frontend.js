// Frontend tiếng Việt cho VieNeu Nano trong trình duyệt: văn bản → các chunk → ids.
// Thay cho sea-g2p (Rust + từ điển 63 MB): chuẩn hoá theo đúng các quy tắc đo được của
// sea_g2p.Normalizer (punc_norm bật) + tra bảng âm tiết → âm vị (g2p_vi.json, ~100 KB gzip,
// tạo bởi web_tts/g2p_table.py).

const DIGITS = ["không", "một", "hai", "ba", "bốn", "năm", "sáu", "bảy", "tám", "chín"];

function readHundreds(n, full) {
  const h = Math.floor(n / 100), t = Math.floor(n / 10) % 10, u = n % 10, w = [];
  if (h || full) w.push(DIGITS[h], "trăm");
  if (t === 0) { if (u && (h || full)) w.push("lẻ"); }                   // sea-g2p đọc "lẻ", không "linh"
  else if (t === 1) w.push("mười");
  else w.push(DIGITS[t], "mươi");
  if (u) {
    if (u === 1 && t > 1) w.push("mốt");
    else if (u === 5 && t > 0) w.push("lăm");
    else w.push(DIGITS[u]);                                              // 24 → "hai mươi bốn" (không "tư")
  }
  return w.join(" ");
}

export function numberToWords(n) {
  if (n === 0) return "không";
  const units = ["", "nghìn", "triệu"], groups = [], w = [];
  while (n > 0) { groups.push(n % 1000); n = Math.floor(n / 1000); }
  for (let i = groups.length - 1; i >= 0; i--) {
    if (!groups[i]) continue;
    w.push(readHundreds(groups[i], i !== groups.length - 1));
    if (units[i % 3]) w.push(units[i % 3]);
    for (let k = 0; k < Math.floor(i / 3); k++) w.push("tỷ");
  }
  return w.join(" ");
}

const LETTERS = { b: "bê", c: "xê", d: "đê", f: "ép", g: "giê", h: "hát", j: "giây", k: "ca", l: "e lờ", m: "em mờ",
  n: "en nờ", p: "pê", q: "quy", r: "e rờ", s: "ét", t: "tê", v: "vê", w: "vê kép", x: "ích", z: "dét" };

// Một CÂU → văn bản đã chuẩn hoá (chưa chốt dấu cuối) — như sea_g2p.Normalizer(punc_norm=False)
export function normalize(text) {
  let s = text.normalize("NFC").toLowerCase();
  s = s.replace(/^[\s\-–—]+/, "");                                     // gạch đầu dòng thoại
  s = s.replace(/["“”«»„‘’]|(^|\s)'|'(\s|$)/g, "$1$2");                 // nháy kép, nháy đơn bao từ
  s = s.trim().replace(/^[(\[{]+|[)\]}]+$/g, "").trim();               // ngoặc bao cả câu: bỏ
  s = s.replace(/(\.{2,}|…)$/, ".").replace(/[:;]+$/, "");             // cuối câu: "..." → ".", ":" bỏ
  s = s.replace(/([!?])[!?.]+$/, "$1");                                // "!!!" → "!", "?!" → "?"
  s = s.replace(/(\d+)\s*%/g, "$1 phần trăm");
  s = s.replace(/\b(\d{1,2})\/(\d{1,2})\b/g, "$1 tháng $2");           // ngày/tháng
  s = s.replace(/(\d+)[.,](\d+)/g, (m, a, b) => (b.length === 3 ? a + b : `${a} phẩy ${b}`));
  s = s.replace(/\d+/g, (m) => (m.length <= 15 ? ` ${numberToWords(+m)} ` : m));
  s = s.replace(/\*/g, " sao ");
  s = s.replace(/(\p{L})-(\p{L})/gu, "$1 $2");                          // Hoa-Tiên → hoa tiên
  s = s.replace(/\.{2,}|…|[:;()\[\]{}]|\s[-–—]+\s|[–—]/g, ",");         // ngắt nhẹ → phẩy
  s = s.replace(/([!?.,])[!?.,]+/g, (m, a) => (/[,]/.test(m) && !/[.!?]/.test(m) ? "," : m.includes(".") ? "." : a));
  s = s.replace(/[^\p{L}\s.,!?]/gu, " ");                              // ký tự lạ: bỏ
  s = s.replace(/\s*,\s*(?=[.!?,]|$)/g, "").replace(/^\s*[,.!?]+/, "");
  s = s.replace(/\s+([.,!?])/g, "$1").replace(/([.,!?])(?=\p{L})/gu, "$1 ").replace(/\s+/g, " ").trim();
  // chữ cái đứng riêng (tên viết tắt): đánh vần như sea-g2p
  s = s.replace(/(^|\s)([bcdfghjklmnpqrstvwxz])(?=[\s.,!?]|$)/g, (m, a, c) => a + LETTERS[c]);
  return s;
}

// chốt dấu cuối (punc_norm): < 5 từ → luôn "."; dài hơn → thêm "." nếu chưa kết thúc bằng , . ! ?
export function puncNorm(s) {
  s = s.trim();
  if (!s) return s;
  const words = s.replace(/[.,!?]+$/, "").split(/\s+/).filter(Boolean).length;
  if (words < 5) return s.replace(/[.,!?]+$/, "") + ".";
  return /[.,!?]$/.test(s) ? s : s + ".";
}

// ---- tách câu trên văn bản THÔ, bỏ qua dấu kết câu nằm trong ngoặc/trích dẫn (core_utils._scan_sentences)
const OPEN_TO_CLOSE = { "(": ")", "[": "]", "{": "}", "“": "”", "‘": "’", "«": "»", "‹": "›", "「": "」", "『": "』" };
const CLOSERS = new Set(Object.values(OPEN_TO_CLOSE));
const TRAILING_CLOSE = new Set([...CLOSERS, '"', "'", "’", "”"]);
const SENT_END = new Set([".", "!", "?", "…"]);

function scanSentences(text, quoteAware) {
  const out = [];
  let start = 0, i = 0, depth = 0, inQuote = false;
  while (i < text.length) {
    const ch = text[i];
    if (quoteAware && ch === '"') inQuote = !inQuote;
    else if (quoteAware && ch in OPEN_TO_CLOSE) depth++;
    else if (quoteAware && CLOSERS.has(ch)) { if (depth) depth--; }
    else if (SENT_END.has(ch) && depth === 0 && !inQuote) {
      let j = i + 1;
      while (j < text.length && SENT_END.has(text[j])) j++;
      while (j < text.length && TRAILING_CLOSE.has(text[j])) j++;
      if (j >= text.length || /\s/.test(text[j])) { out.push(text.slice(start, j)); start = i = j; continue; }
      i = j; continue;
    }
    i++;
  }
  if (start < text.length) out.push(text.slice(start));
  return [out.map((s) => s.trim()).filter(Boolean), depth === 0 && !inQuote];
}

export function splitSentences(text) {
  const [s, balanced] = scanSentences(text, true);
  return balanced ? s : scanSentences(text, false)[0];
}

// ---- đóng gói câu thành chunk (core_utils.pack_sentences_into_chunks): trần tương đối, slack 15 ký tự
const fits = (cur, add, max) => {
  const total = cur ? cur + 1 + add : add, slack = Math.min(15, Math.floor(max / 8));
  return total <= max || (add <= slack && total <= max + slack);
};

function splitLongPart(part, max) {                 // cắt đều theo từ khi không còn dấu ngắt
  const words = part.split(" "), k = Math.ceil(part.length / max), target = part.length / k, out = [];
  let cur = "";
  for (const w of words) {
    if (cur && cur.length + 1 + w.length > target && out.length < k - 1) { out.push(cur); cur = w; }
    else cur = cur ? `${cur} ${w}` : w;
  }
  if (cur) out.push(cur);
  return out;
}

function packSentences(sentences, max) {
  const chunks = [];
  let buf = "";
  for (let sen of sentences) {
    sen = sen.trim();
    if (!sen) continue;
    if (sen.length > max) {
      if (buf) { chunks.push(buf); buf = ""; }
      for (let part of sen.split(/(?<=[,;:\-–—])\s+/)) {
        part = part.trim();
        if (!part) continue;
        if (fits(buf.length, part.length, max)) buf = buf ? `${buf} ${part}` : part;
        else {
          if (buf) chunks.push(buf);
          buf = part;
          if (buf.length > max) { const p = splitLongPart(buf, max); chunks.push(...p.slice(0, -1)); buf = p[p.length - 1] || ""; }
        }
      }
    } else if (buf && !fits(buf.length, sen.length, max)) { chunks.push(buf); buf = sen; }
    else buf = buf ? `${buf} ${sen}` : sen;
  }
  if (buf) chunks.push(buf);
  return chunks.map((c) => c.trim()).filter(Boolean);
}

// gộp chunk ngắn (< minChars) vào hàng xóm ngắn hơn, hoà thì bên phải (phonemize_text._merge_short_chunks)
function mergeShort(chunks, minChars) {
  while (chunks.length > 1) {
    let i = -1;
    chunks.forEach((c, k) => { if (c.length < minChars && (i < 0 || c.length < chunks[i].length)) i = k; });
    if (i < 0) break;
    const right = i < chunks.length - 1 ? -chunks[i + 1].length : -Infinity;
    const left = i > 0 ? -chunks[i - 1].length : -Infinity;
    if (right >= left) chunks.splice(i, 2, `${chunks[i]} ${chunks[i + 1]}`);
    else chunks.splice(i - 1, 2, `${chunks[i - 1]} ${chunks[i]}`);
  }
  return chunks;
}

// Một đoạn văn → các chunk đã chuẩn hoá (Nano học trên câu ≤ 15 s → ≤ 140 ký tự)
// = phonemize_text.normalize_to_chunks_v3_with_gaps(text, max_chars=140) cho một đoạn
export function chunkParagraph(text, maxChars = 140, minChars = 20) {
  const sentences = splitSentences(text).map(normalize).filter(Boolean);
  return mergeShort(packSentences(sentences, maxChars).map(puncNorm), minChars);
}

export class ViG2P {
  constructor(table, nanoCfg) {
    this.syl = table.syl;
    this.vocab = nanoCfg.vocab;
    this.bos = nanoCfg.bos_id; this.eos = nanoCfg.eos_id;
  }

  phonemize(chunk) {
    // pipeline gốc chuẩn hoá LẠI từng chunk với punc_norm trước G2P: phẩy cuối chunk bị bỏ rồi chốt "."
    chunk = puncNorm(chunk.replace(/[,\s]+$/, ""));
    const out = [];
    for (const tok of chunk.match(/[^\s.,!?]+|[.,!?]+/g) || []) {
      if (/^[.,!?]/.test(tok)) { if (out.length) out[out.length - 1] += tok; continue; }
      let ph = this.syl[tok];
      if (ph === undefined) ph = [...tok].map((c) => this.syl[c]).filter(Boolean).join(" ");   // âm tiết lạ: đánh vần
      if (ph) out.push(ph);
    }
    return out.join(" ");
  }

  ids(phones) {
    const ids = [this.bos];
    for (const ch of phones) { const i = this.vocab[ch]; if (i !== undefined) ids.push(i); }
    ids.push(this.eos);
    return ids;
  }

  // một đoạn văn → [{text, phones, ids}]
  paragraph(text) {
    return chunkParagraph(text).map((c) => { const phones = this.phonemize(c); return { text: c, phones, ids: this.ids(phones) }; });
  }
}
