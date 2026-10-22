// Đọc file EPUB ngay trên trình duyệt: lấy thông tin truyện, ảnh bìa và nội dung từng chương (dạng chữ thuần).
window.Epub = (() => {
  "use strict";

  const JSZIP_URL = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";
  let jszipLoading;
  function loadJSZip() {
    if (window.JSZip) return Promise.resolve();
    return (jszipLoading ||= new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = JSZIP_URL;
      s.onload = resolve;
      s.onerror = () => { jszipLoading = null; reject(new Error("Không tải được thư viện JSZip")); };
      document.head.appendChild(s);
    }));
  }

  const parseXml = (s) => new DOMParser().parseFromString(s, "application/xml");
  const byTag = (node, tag) => [...node.getElementsByTagNameNS("*", tag)];
  const clean = (s) => (s || "").normalize("NFC").replace(/\s+/g, " ").trim();
  // href is relative to the file that contains it
  const resolve = (fromFile, href) => decodeURIComponent(new URL(href, "http://x/" + fromFile).pathname.slice(1));

  function parseHtml(src) {
    let doc = new DOMParser().parseFromString(src, "application/xhtml+xml");
    if (doc.getElementsByTagName("parsererror").length) doc = new DOMParser().parseFromString(src, "text/html");
    return doc;
  }

  // Turn a document body into a list of paragraphs.
  function paragraphs(body) {
    if (!body) return [];
    body.querySelectorAll("script, style").forEach((e) => e.remove());
    body.querySelectorAll("br").forEach((e) => e.replaceWith("\n"));
    body.querySelectorAll("p, div, h1, h2, h3, h4, h5, h6, li, blockquote, tr, section").forEach((e) => e.after("\n"));
    return body.textContent.split("\n").map(clean).filter(Boolean);
  }
  const htmlToText = (s) => paragraphs(new DOMParser().parseFromString(s || "", "text/html").body).join("\n");

  async function tocTitles(zip, opf, manifest) {
    const titles = {};
    const add = (fromFile, href, label) => {
      const file = (href || "").split("#")[0];
      if (!file || !label) return;
      const p = resolve(fromFile, file);
      if (!titles[p]) titles[p] = label;
    };
    // EPUB 3: nav document
    const nav = Object.values(manifest).find((m) => /\bnav\b/.test(m.props));
    if (nav && zip.file(nav.href)) {
      const doc = parseHtml(await zip.file(nav.href).async("string"));
      const navs = byTag(doc, "nav");
      const toc = navs.find((n) => /toc/.test(n.getAttribute("epub:type") || n.getAttributeNS("http://www.idpf.org/2007/ops", "type") || "")) || navs[0];
      if (toc) for (const a of byTag(toc, "a")) add(nav.href, a.getAttribute("href"), clean(a.textContent));
    }
    // EPUB 2: NCX
    if (!Object.keys(titles).length) {
      const tocId = byTag(opf, "spine")[0]?.getAttribute("toc");
      const ncx = manifest[tocId] || Object.values(manifest).find((m) => m.type === "application/x-dtbncx+xml");
      if (ncx && zip.file(ncx.href)) {
        const doc = parseXml(await zip.file(ncx.href).async("string"));
        for (const np of byTag(doc, "navPoint")) {
          add(ncx.href, byTag(np, "content")[0]?.getAttribute("src"), clean(byTag(np, "text")[0]?.textContent));
        }
      }
    }
    return titles;
  }

  function findCover(opf, manifest) {
    const items = Object.values(manifest);
    let c = items.find((m) => /\bcover-image\b/.test(m.props));
    if (!c) {
      const id = byTag(opf, "meta").find((m) => m.getAttribute("name") === "cover")?.getAttribute("content");
      c = manifest[id];
    }
    if (!c || !c.type.startsWith("image/")) c = items.find((m) => m.type.startsWith("image/") && /cover|bia/i.test(m.id + m.href));
    return c && c.type.startsWith("image/") ? c : null;
  }

  /**
   * @param {Blob|ArrayBuffer} source
   * @returns {Promise<{title, author, description, tags, cover: Blob|null, chapters: {title, content}[]}>}
   */
  async function parse(source) {
    await loadJSZip();
    const zip = await window.JSZip.loadAsync(source);
    const read = (p) => {
      const f = zip.file(p);
      if (!f) throw new Error("EPUB thiếu tệp " + p);
      return f.async("string");
    };

    const opfPath = byTag(parseXml(await read("META-INF/container.xml")), "rootfile")[0]?.getAttribute("full-path");
    if (!opfPath) throw new Error("EPUB không hợp lệ (không có OPF)");
    const opf = parseXml(await read(opfPath));

    const manifest = {};
    for (const it of byTag(opf, "item")) {
      manifest[it.getAttribute("id")] = {
        id: it.getAttribute("id") || "",
        href: resolve(opfPath, it.getAttribute("href") || ""),
        type: it.getAttribute("media-type") || "",
        props: it.getAttribute("properties") || "",
      };
    }

    const md = (tag) => byTag(opf, tag).map((e) => clean(e.textContent)).filter(Boolean);
    const titles = await tocTitles(zip, opf, manifest);

    const chapters = [];
    for (const ref of byTag(opf, "itemref")) {
      const item = manifest[ref.getAttribute("idref")];
      if (!item || !/html/.test(item.type) || /\bnav\b/.test(item.props) || !zip.file(item.href)) continue;
      const doc = parseHtml(await read(item.href));
      const body = doc.body || byTag(doc, "body")[0];
      const heading = clean(body?.querySelector("h1, h2, h3")?.textContent);
      const paras = paragraphs(body);
      if (paras.join("").length < 20) continue; // trang bìa, trang trống
      const title = titles[item.href] || heading || `Chương ${chapters.length + 1}`;
      if (paras[0] && paras[0].toLowerCase() === title.toLowerCase()) paras.shift();
      chapters.push({ title, content: paras.join("\n") });
    }
    if (!chapters.length) throw new Error("Không tìm thấy chương nào trong EPUB");

    const coverItem = findCover(opf, manifest);
    const cover = coverItem && zip.file(coverItem.href)
      ? new Blob([await zip.file(coverItem.href).async("uint8array")], { type: coverItem.type })
      : null;

    return {
      title: md("title")[0] || "",
      author: md("creator").join(", "),
      description: htmlToText(byTag(opf, "description")[0]?.textContent),
      tags: md("subject"),
      cover,
      chapters,
    };
  }

  return { parse, loadJSZip };
})();
