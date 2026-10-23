// Edge Function "bunny": cổng duy nhất để trang quản trị ghi lên Bunny Storage.
// Mật khẩu Storage chỉ nằm trong Secrets của Supabase, trình duyệt không bao giờ thấy.
//
//   GET    /functions/v1/bunny?path=<đường dẫn>   đọc file / liệt kê thư mục (path kết thúc bằng "/")
//   PUT    /functions/v1/bunny?path=<đường dẫn>   ghi file (body = nội dung)
//   DELETE /functions/v1/bunny?path=<đường dẫn>   xoá file / thư mục
//
// Chỉ tài khoản có trong bảng public.admins mới dùng được.
// Secrets cần đặt: BUNNY_STORAGE_ZONE, BUNNY_STORAGE_KEY, BUNNY_STORAGE_HOST (tuỳ chọn).
import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, PUT, DELETE, OPTIONS",
};

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
  if (!["GET", "PUT", "DELETE"].includes(req.method)) return json(405, "Không hỗ trợ");

  // 1. Ai đang gọi, có phải admin không?
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const admin = token ? await isAdmin(token) : null;
  if (admin === null) return json(401, "Chưa đăng nhập");
  if (!admin) return json(403, "Tài khoản này không có quyền quản trị");

  // 2. Chuyển tiếp tới Bunny Storage.
  const path = new URL(req.url).searchParams.get("path") ?? "";
  if (path.split("/").some((p) => p === ".." || p === ".")) return json(400, "Đường dẫn không hợp lệ");
  const zone = Deno.env.get("BUNNY_STORAGE_ZONE");
  const key = Deno.env.get("BUNNY_STORAGE_KEY");
  const host = Deno.env.get("BUNNY_STORAGE_HOST") || "storage.bunnycdn.com";
  if (!zone || !key) return json(500, "Chưa đặt BUNNY_STORAGE_ZONE / BUNNY_STORAGE_KEY trong Secrets");

  const target = `https://${host}/${encodeURIComponent(zone)}/${path.split("/").map(encodeURIComponent).join("/")}`;
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
