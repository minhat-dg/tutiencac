// Đọc file PRC / MOBI / AZW3 ngoài luồng giao diện, để trang quản trị không đứng hình khi đọc file lớn.
// Vào: File. Ra: {type:"progress", label, r} … rồi {type:"done", book} hoặc {type:"error", message}.
importScripts("/js/mobi.js");

self.onmessage = async ({ data: file }) => {
  try {
    let last = 0;
    const book = await self.Mobi.parse(file, (label, r) => {
      const now = Date.now();
      if (now - last > 100) { last = now; self.postMessage({ type: "progress", label, r }); }
    });
    self.postMessage({ type: "done", book });
  } catch (e) {
    self.postMessage({ type: "error", message: (e && e.message) || String(e) });
  }
};
