// Edge Function "bunny": cổng duy nhất để trang quản trị ghi lên Bunny Storage.
// Mật khẩu Storage chỉ nằm trong Secrets của Supabase, trình duyệt không bao giờ thấy.
//
//   GET    /functions/v1/bunny?path=<đường dẫn>   đọc file / liệt kê thư mục (path kết thúc bằng "/")
//   PUT    /functions/v1/bunny?path=<đường dẫn>   ghi file (body = nội dung)
//   DELETE /functions/v1/bunny?path=<đường dẫn>   xoá file / thư mục
//   POST   /functions/v1/bunny?batch=1           ghi NHIỀU file trong một request (body: xem readBatch)
//
// Lô (batch) để đăng truyện nhanh: một truyện là vài chục gói nhỏ. Gửi từng gói thì mỗi gói tốn một
// preflight CORS + một lượt trình duyệt → Supabase → Bunny. Gửi cả lô thì trình duyệt chỉ đi một lượt,
// phần còn lại function ghi song song lên Bunny trên đường truyền giữa các máy chủ.
//
// Chỉ tài khoản có trong bảng public.admins mới dùng được.
// Secrets cần đặt: BUNNY_STORAGE_ZONE, BUNNY_STORAGE_KEY, BUNNY_STORAGE_HOST (tuỳ chọn).
import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, PUT, POST, DELETE, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

const badPath = (path: string) => !path || path.split("/").some((p) => p === ".." || p === ".");

// Body của lô: lặp lại [độ dài đường dẫn u32 BE][đường dẫn UTF-8][độ dài dữ liệu u32 BE][dữ liệu]
function readBatch(buf: Uint8Array): { path: string; data: Uint8Array }[] | null {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength), dec = new TextDecoder(), out = [];
  for (let o = 0; o < buf.length; ) {
    if (o + 4 > buf.length) return null;
    const pl = dv.getUint32(o); o += 4;
    if (o + pl + 4 > buf.length) return null;
    const path = dec.decode(buf.subarray(o, o + pl)); o += pl;
    const dl = dv.getUint32(o); o += 4;
    if (o + dl > buf.length || badPath(path)) return null;
    out.push({ path, data: buf.subarray(o, o + dl) }); o += dl;
  }
  return out;
}

const PARALLEL = 8;
async function putBatch(files: { path: string; data: Uint8Array }[], url: (p: string) => string, key: string) {
  const failed: string[] = [];
  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      const f = files[next++];
      for (let attempt = 1; ; attempt++) {
        const res = await fetch(url(f.path), { method: "PUT", headers: { AccessKey: key, "Content-Type": "application/octet-stream" }, body: f.data })
          .catch(() => null);
        await res?.body?.cancel();
        if (res && res.ok) break;
        if (attempt >= 3) { failed.push(f.path); break; }
        await new Promise((r) => setTimeout(r, 500 * attempt));
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, files.length) }, worker));
  return failed;
}

const json = (status: number, error: string) =>
  new Response(JSON.stringify({ error }), { status, headers: { ...cors, "Content-Type": "application/json" } });

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

// Một lần đăng truyện gửi vài chục file liền nhau. Kiểm tra token + quyền admin một lần
// rồi nhớ kết quả theo token trong 5 phút (không quá hạn token), thay vì hỏi lại ở mỗi file.
const CACHE_MS = 5 * 60 * 1000;
const checked = new Map<string, { admin: boolean; until: number }>();

async function isAdmin(token: string): Promise<boolean | null> {
  const now = Date.now();
  const hit = checked.get(token);
  if (hit && hit.until > now) return hit.admin;

  const { data: { user } } = await db.auth.getUser(token);
  if (!user) return null;
  const { data: row } = await db.from("admins").select("user_id").eq("user_id", user.id).maybeSingle();

  let exp = now + CACHE_MS;
  try { exp = Math.min(exp, JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).exp * 1000); } catch { /* giữ 5 phút */ }
  if (checked.size > 500) checked.clear();
  checked.set(token, { admin: !!row, until: exp });
  return !!row;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (!["GET", "PUT", "POST", "DELETE"].includes(req.method)) return json(405, "Không hỗ trợ");

  // 1. Ai đang gọi, có phải admin không?
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const admin = token ? await isAdmin(token) : null;
  if (admin === null) return json(401, "Chưa đăng nhập");
  if (!admin) return json(403, "Tài khoản này không có quyền quản trị");

  // 2. Chuyển tiếp tới Bunny Storage.
  const params = new URL(req.url).searchParams;
  const path = params.get("path") ?? "";
  if (path.split("/").some((p) => p === ".." || p === ".")) return json(400, "Đường dẫn không hợp lệ");
  const zone = Deno.env.get("BUNNY_STORAGE_ZONE");
  const key = Deno.env.get("BUNNY_STORAGE_KEY");
  const host = Deno.env.get("BUNNY_STORAGE_HOST") || "storage.bunnycdn.com";
  if (!zone || !key) return json(500, "Chưa đặt BUNNY_STORAGE_ZONE / BUNNY_STORAGE_KEY trong Secrets");
  const urlOf = (p: string) => `https://${host}/${encodeURIComponent(zone)}/${p.split("/").map(encodeURIComponent).join("/")}`;

  // 2a. Lô nhiều file
  if (req.method === "POST") {
    if (params.get("batch") !== "1") return json(405, "Không hỗ trợ");
    const files = readBatch(new Uint8Array(await req.arrayBuffer()));
    if (!files || !files.length) return json(400, "Lô không hợp lệ");
    const failed = await putBatch(files, urlOf, key);
    return new Response(JSON.stringify({ count: files.length, failed }), {
      status: failed.length ? 502 : 200,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  const target = urlOf(path);
  const res = await fetch(target, {
    method: req.method,
    headers: { AccessKey: key, ...(req.method === "PUT" ? { "Content-Type": "application/octet-stream" } : {}) },
    body: req.method === "PUT" ? req.body : undefined,
    // @ts-ignore: cần khi chuyển tiếp body dạng stream
    duplex: "half",
  });
  return new Response(res.body, {
    status: res.status,
    headers: { ...cors, "Content-Type": res.headers.get("Content-Type") ?? "application/octet-stream" },
  });
});
