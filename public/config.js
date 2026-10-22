// Cấu hình công khai (không chứa mật khẩu). Sửa xong deploy lại Vercel.
window.TT_CONFIG = {
  // Địa chỉ Pull Zone Bunny CDN trỏ vào Storage Zone chứa truyện, ví dụ "https://tutien.b-cdn.net".
  // Để trống = chế độ demo, dùng 3 truyện mẫu có sẵn trong code.
  cdnBase: "https://tutiencac.b-cdn.net/",

  // Dùng cho trang quản trị /admin.
  storageZone: "tutiencac",                     // tên Storage Zone, ví dụ "tutien"
  storageHost: "storage.bunnycdn.com", // theo vùng của Storage Zone, ví dụ "sg.storage.bunnycdn.com"
};
