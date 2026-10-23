// Đọc file PRC / MOBI / AZW3 (định dạng Kindle cũ) ngay trên trình duyệt.
// Trả về cùng dạng với Epub.parse: { title, author, description, tags, cover, chapters: [{title, content}] }.
window.Mobi = (() => {
  "use strict";

  // Hàm lấy chữ từ HTML (tự chứa, để không lệ thuộc phiên bản epub.js đang được lưu đệm)
  const clean = (s) => (s || "").normalize("NFC").replace(/\s+/g, " ").trim();
  function paragraphs(html) {
    const body = new DOMParser().parseFromString(html || "", "text/html").body;
    if (!body) return [];
    body.querySelectorAll("script, style").forEach((e) => e.remove());
    body.querySelectorAll("br").forEach((e) => e.replaceWith("\n"));
    body.querySelectorAll("p, div, h1, h2, h3, h4, h5, h6, li, blockquote, tr, section").forEach((e) => e.after("\n"));
    return body.textContent.split("\n").map(clean).filter(Boolean);
  }
  const htmlToText = (html) => paragraphs(html).join("\n");

  const u16 = (b, o) => (b[o] << 8) | b[o + 1];
  const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  const ascii = (b, o, n) => String.fromCharCode(...b.subarray(o, o + n));

  // Nhận diện: tiêu đề cơ sở dữ liệu Palm có kiểu "BOOK" + "MOBI" (hoặc "TEXtREAd" cho PalmDOC thường).
  function isMobi(bytes) {
    if (bytes.length < 78) return false;
    const t = ascii(bytes, 60, 8);
    return t === "BOOKMOBI" || t === "TEXtREAd";
  }

  // Giải nén PalmDOC (LZ77 đơn giản, khối 4096 byte).
  function palmdoc(src) {
    const out = new Uint8Array(src.length * 8 + 16);
    let o = 0;
    for (let i = 0; i < src.length; ) {
      const c = src[i++];
      if (c >= 1 && c <= 8) {                   // c byte nguyên văn
        for (let k = 0; k < c && i < src.length; k++) out[o++] = src[i++];
      } else if (c < 0x80) {                    // 1 byte nguyên văn
        out[o++] = c;
      } else if (c >= 0xC0) {                   // dấu cách + 1 ký tự
        out[o++] = 0x20; out[o++] = c ^ 0x80;
      } else {                                  // tham chiếu ngược: 11 bit khoảng cách, 3 bit độ dài
        const pair = (c << 8) | src[i++];
        const dist = (pair >> 3) & 0x7FF, len = (pair & 7) + 3;
        for (let k = 0; k < len; k++, o++) out[o] = out[o - dist];
      }
    }
    return out.subarray(0, o);
  }

  // Một số file gắn thêm dữ liệu ở cuối mỗi khối chữ; cần bỏ trước khi giải nén.
  function trailingSize(data, flags) {
    let size = 0;
    const entry = (end) => {
      let bitpos = 0, result = 0;
      for (let p = end; p > 0; ) {
        const v = data[--p];
        result |= (v & 0x7F) << bitpos;
        bitpos += 7;
        if ((v & 0x80) || bitpos >= 28 || p === 0) return result;
      }
      return result;
    };
    for (let f = flags >> 1; f; f >>= 1) if (f & 1) size += entry(data.length - size);
    if (flags & 1) size += (data[data.length - size - 1] & 0x3) + 1;
    return size;
  }

  const imageType = (b) =>
    b[0] === 0xFF && b[1] === 0xD8 ? "image/jpeg" :
    b[0] === 0x89 && b[1] === 0x50 ? "image/png" :
    b[0] === 0x47 && b[1] === 0x49 ? "image/gif" :
    b[0] === 0x42 && b[1] === 0x4D ? "image/bmp" : "";

  // Chương mở đầu bằng "Chương 12", "Chapter 3", "Hồi 5", "Quyển 2"…
  const CHAPTER_LINE = /^\s*(chương|chuong|chapter|hồi|hoi|quyển|quyen|tiết|第)\s*[0-9０-９一二三四五六七八九十百千零〇IVXLC]+/i;

  async function parse(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!isMobi(bytes)) throw new Error("Không phải file PRC/MOBI hợp lệ");

    // ---- bảng bản ghi ----
    const count = u16(bytes, 76);
    const offs = [];
    for (let i = 0; i < count; i++) offs.push(u32(bytes, 78 + i * 8));
    offs.push(bytes.length);
    const rec = (i) => bytes.subarray(offs[i], offs[i + 1]);

    // ---- bản ghi 0: PalmDOC + MOBI + EXTH ----
    const r0 = rec(0);
    const compression = u16(r0, 0);
    const textLength = u32(r0, 4);
    const textRecords = u16(r0, 8);
    const encryption = u16(r0, 12);
    if (encryption) throw new Error("File này có khoá DRM nên không đọc được nội dung. Hãy dùng bản không có DRM.");
    if (compression === 17480) throw new Error("File dùng kiểu nén HUFF/CDIC. Hãy mở bằng Calibre và chuyển sang EPUB trước khi đăng.");
    if (compression !== 1 && compression !== 2) throw new Error(`Kiểu nén chưa hỗ trợ (${compression})`);

    const hasMobi = r0.length > 20 && ascii(r0, 16, 4) === "MOBI";
    const headerLen = hasMobi ? u32(r0, 20) : 0;
    const encoding = hasMobi ? u32(r0, 28) : 1252;
    const decoder = new TextDecoder(encoding === 65001 ? "utf-8" : "windows-1252");
    const firstImage = hasMobi ? u32(r0, 108) : 0xFFFFFFFF;
    const extraFlags = hasMobi && headerLen >= 0xE4 ? u16(r0, 16 + 0xE2) : 0;

    let title = hasMobi ? decoder.decode(r0.subarray(u32(r0, 84), u32(r0, 84) + u32(r0, 88))) : "";
    if (!title) title = ascii(bytes, 0, 32).replace(/\0.*$/, "").replace(/_/g, " ");
    const meta = { author: [], description: "", tags: [], coverIndex: null };
    if (hasMobi && (u32(r0, 128) & 0x40)) {
      let p = 16 + headerLen;
      if (ascii(r0, p, 4) === "EXTH") {
        const n = u32(r0, p + 8);
        p += 12;
        for (let i = 0; i < n && p + 8 <= r0.length; i++) {
          const type = u32(r0, p), len = u32(r0, p + 4), data = r0.subarray(p + 8, p + len);
          const text = () => decoder.decode(data).trim();
          if (type === 100) meta.author.push(text());
          else if (type === 103) meta.description = text();
          else if (type === 105) meta.tags.push(...text().split(/[;,]/).map((s) => s.trim()).filter(Boolean));
          else if (type === 503 && text()) title = text();
          else if (type === 201 && data.length >= 4) meta.coverIndex = u32(data, 0);
          p += len;
        }
      }
    }

    // ---- chữ: giải nén từng khối, nối lại ----
    const parts = [];
    let total = 0;
    for (let i = 1; i <= textRecords && i < count; i++) {
      let data = rec(i);
      if (extraFlags) data = data.subarray(0, data.length - trailingSize(data, extraFlags));
      const out = compression === 2 ? palmdoc(data) : data;
      parts.push(out);
      total += out.length;
    }
    const text = new Uint8Array(total);
    for (let i = 0, o = 0; i < parts.length; o += parts[i].length, i++) text.set(parts[i], o);
    const body = text.subarray(0, Math.min(textLength || total, total));

    const chapters = splitChapters(body, decoder);
    if (!chapters.length) throw new Error("Không tìm thấy nội dung chương trong file");

    // ---- ảnh bìa ----
    let cover = null;
    if (firstImage !== 0xFFFFFFFF && firstImage < count) {
      const tryIndex = (k) => {
        const r = k < count ? rec(k) : null;
        const t = r && imageType(r);
        return t ? new Blob([r.slice()], { type: t }) : null;
      };
      cover = (meta.coverIndex != null && tryIndex(firstImage + meta.coverIndex)) || tryIndex(firstImage);
    }

    return {
      title: clean(title),
      author: meta.author.map(clean).filter(Boolean).join(", "),
      description: htmlToText(meta.description),
      tags: [...new Set(meta.tags.map(clean))],
      cover,
      chapters,
    };
  }

  // Chia chương: ưu tiên mục lục (<a filepos=…>) vì nó chỉ đúng vị trí byte của từng chương;
  // không có thì chia theo ngắt trang / dòng "Chương N".
  function splitChapters(body, decoder) {
    const latin = new TextDecoder("latin1").decode(body); // 1 byte = 1 ký tự: vị trí trùng với filepos
    const links = [];
    const re = /<a\b[^>]*\bfilepos\s*=\s*["']?(\d+)["']?[^>]*>([\s\S]*?)<\/a>/gi;
    for (let m; (m = re.exec(latin)); ) {
      const label = clean(decoder.decode(body.subarray(m.index, m.index + m[0].length)).replace(/<[^>]+>/g, " "));
      const pos = +m[1];
      if (label && label.length < 150 && pos > 0 && pos < body.length) links.push({ pos, label, at: m.index });
    }
    const seen = new Set();
    const toc = links.filter((l) => !seen.has(l.pos) && seen.add(l.pos)).sort((a, b) => a.pos - b.pos);

    const chapterOf = (from, to, fallbackTitle) => {
      const paras = paragraphs(decoder.decode(body.subarray(from, to)));
      const first = paras[0] || "";
      const title = fallbackTitle || (first.length < 120 ? first : "");
      if (paras[0] && title && paras[0].toLowerCase() === title.toLowerCase()) paras.shift();
      return { title, content: paras.join("\n") };
    };

    if (toc.length >= 2) {
      // mục lục thường nằm ở đầu hoặc cuối sách; chương cuối dừng trước trang mục lục nếu nó ở sau
      const tocStart = Math.min(...toc.map((l) => l.at));
      const out = [];
      toc.forEach((l, i) => {
        let end = i + 1 < toc.length ? toc[i + 1].pos : body.length;
        if (tocStart > l.pos && tocStart < end) end = latin.lastIndexOf("<mbp:pagebreak", tocStart) > l.pos ? latin.lastIndexOf("<mbp:pagebreak", tocStart) : tocStart;
        const ch = chapterOf(l.pos, end, l.label);
        if (ch.content.length >= 20) out.push(ch);
      });
      if (out.length >= 2) return out;
    }

    // Không có mục lục.
    const pages = decoder.decode(body).split(/<mbp:pagebreak\s*\/?>/i).map(paragraphs);
    const lines = pages.flat();
    const isHeading = (l) => l.length < 150 && CHAPTER_LINE.test(l);
    const out = [];

    if (lines.some(isHeading)) {
      // 1) có dòng "Chương N": mỗi dòng như vậy mở một chương
      let cur = null;
      for (const l of lines) {
        if (isHeading(l)) { if (cur) out.push(cur); cur = { title: l, lines: [] }; }
        else if (cur) cur.lines.push(l);
      }
      if (cur) out.push(cur);
    } else if (pages.filter((p) => p.join("").length >= 20).length >= 2) {
      // 2) theo ngắt trang; dòng ngắn đầu trang làm tên chương
      for (const p of pages) {
        if (p.join("").length < 20) continue;
        const head = p[0].length < 120 ? p[0] : "";
        out.push({ title: head, lines: head ? p.slice(1) : p });
      }
    } else {
      // 3) một khối liền: chia mỗi phần ~6000 ký tự, cắt ở ranh giới đoạn
      let cur = { title: "", lines: [] }, size = 0;
      for (const l of lines) {
        cur.lines.push(l); size += l.length;
        if (size > 6000) { out.push(cur); cur = { title: "", lines: [] }; size = 0; }
      }
      if (cur.lines.length) out.push(cur);
    }
    return out
      .map((c, i) => ({ title: c.title || `Phần ${i + 1}`, content: c.lines.join("\n") }))
      .filter((c) => c.content.length >= 20);
  }

  return { parse, isMobi };
})();
