// Cấu hình công khai (không chứa mật khẩu). Sửa xong deploy lại Vercel.
window.TT_CONFIG = {
  // Địa chỉ Pull Zone Bunny CDN trỏ vào Storage Zone chứa truyện, ví dụ "https://tutien.b-cdn.net".
  // Để trống = chế độ demo, dùng 3 truyện mẫu có sẵn trong code.
  cdnBase: "https://tutiencac.b-cdn.net/",

  // Dùng cho trang quản trị /admin.
  storageZone: "tutiencac",                     // tên Storage Zone, ví dụ "tutien"
  storageHost: "storage.bunnycdn.com", // theo vùng của Storage Zone, ví dụ "sg.storage.bunnycdn.com"

  // Tài khoản người đọc + trang quản trị qua Supabase (tuỳ chọn, để trống = tắt).
  // Lấy ở Supabase → Project Settings → API: "Project URL" và khoá "anon public".
  // Khoá anon là khoá công khai, đưa lên web được. KHÔNG điền khoá service_role ở đây.
  supabaseUrl: "https://fmflnuynfpnmvdvnxuqy.supabase.co",
  supabaseAnonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZtZmxudXluZnBubXZkdm54dXF5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI3MDAwOTksImV4cCI6MjEwODI3NjA5OX0.zxFgh-py0RrPbGiidpP1OLOwsCe8dTEQj61IlxtmzNw",
  googleLogin: false, // true sau khi bật Google trong Supabase → Authentication → Providers
};
