# Tu Tiên Các

Web đọc truyện tu tiên, **không có backend**:

- **Vercel**: chỉ chứa web tĩnh (thư mục `public/`). Gồm trang đọc `/` và trang quản trị `/admin`.
- **Bunny Storage + Pull Zone**: chứa truyện (.epub), ảnh bìa, nhạc và file `catalog.json`.
- **Người đọc**: tiến độ đọc, tủ sách, cài đặt và nhạc đang chọn lưu trong localStorage. Truyện đã tải lưu trong IndexedDB, mở lại không phải tải lại.
- **Admin**: trang `/admin` upload thẳng lên Bunny Storage từ trình duyệt.

```
Người đọc ──▶ Vercel (/)       ──đọc──▶ Bunny CDN (catalog.json, .epub, ảnh, nhạc)
Admin     ──▶ Vercel (/admin)  ──ghi──▶ Bunny Storage API ──▶ Storage Zone ──▶ Pull Zone
```

## Trang quản trị `/admin`

- **Truyện**:
  - Kéo thả file **EPUB** hoặc **PRC / MOBI / AZW3** (định dạng Kindle cũ) vào, web tự đọc tên, tác giả, giới thiệu, thể loại, ảnh bìa và danh sách chương.
  - Đọc được cả hai kiểu nén của PRC/MOBI: PalmDOC và HUFF/CDIC.
  - File có khoá DRM thì không đọc được. Dùng bản không có DRM, hoặc mở bằng [Calibre](https://calibre-ebook.com), chuyển sang EPUB rồi đăng.
  - Sửa thông tin rồi bấm **Đăng truyện**.
  - Sửa, ẩn/hiện (lưu nháp), sắp xếp thứ tự, thay EPUB, đổi ảnh bìa, xoá truyện (xoá luôn file trên Bunny).
- **Nhạc nền**: tải mp3/ogg/m4a lên, đổi tên, nghe thử, xoá.
- **Cài đặt**: tên trang, thông báo ở đầu thư viện, mật khẩu quản trị, kiểm tra kết nối CDN.

### Mật khẩu

1. Lần đầu, đăng nhập bằng **mật khẩu Storage Zone** (Bunny → Storage → *FTP & API Access* → *Password*).
2. Vào **Cài đặt → Mật khẩu quản trị**, đặt mật khẩu riêng (ít nhất 10 ký tự). Từ đó đăng nhập bằng mật khẩu này.

Cách hoạt động:

- Mật khẩu quản trị dùng để mã hoá mật khẩu Storage (PBKDF2-SHA256 600.000 vòng + AES-GCM). Bản mã được lưu tại `_admin/key.json` trên Bunny.
- Code và Vercel không chứa bí mật nào.
- Bản mã ai cũng tải được, nên mật khẩu quản trị cần **dài và khó đoán**.
- Mật khẩu Storage gốc luôn đăng nhập được. Nếu đổi mật khẩu Storage trên Bunny, hãy đăng nhập bằng mật khẩu mới rồi đặt lại mật khẩu quản trị.
- "Ghi nhớ trên máy này" lưu mật khẩu Storage trong trình duyệt. Chỉ bật trên máy riêng của bạn.

Mỗi lần thay EPUB hoặc ảnh bìa, nội dung mới được lưu ở thư mục/tên file mới (kèm mã thời gian), nên CDN không bao giờ trả bản cũ. Bản cũ tự bị xoá.

## Cấu trúc trên Bunny Storage

```
/catalog.json                     danh sách truyện, nhạc, thông tin trang (chỉ khi KHÔNG dùng Supabase)
/novels/<id>/<phiên bản>/toc.json danh sách tên chương
/novels/<id>/<phiên bản>/c<k>.json gói 50 chương (c0 = chương 1–50, c1 = 51–100…)
/bia/*.jpg                        ảnh bìa (thu nhỏ còn 600px)
/nhac/*.mp3                       nhạc nền tải lên
/_admin/key.json                  mật khẩu quản trị đã mã hoá
```

Khi đăng truyện, trang quản trị đọc EPUB rồi chia thành các gói 50 chương. Người đọc chỉ tải danh sách chương và gói chứa chương đang đọc (khoảng 150–200 KB), không phải tải cả file EPUB.

`catalog.json` do trang quản trị tự ghi. Truyện thêm tay dạng `{"file": "truyen/abc.epub"}` vẫn đọc được (người đọc tải cả EPUB). Trong trang quản trị, mở **Sửa** truyện đó và bấm **Chuyển sang dạng tải nhanh** để chia gói.

## Tính năng trang đọc

- **Tải nhanh theo gói**: mở truyện dài vài nghìn chương gần như tức thì. Gói kế tiếp được tải trước khi gần đọc hết gói hiện tại.
- **Cài như ứng dụng (PWA)**:
  - Trên Android/máy tính, bấm nút **Cài app** trên thanh trên cùng.
  - Trên iPhone, dùng Safari: bấm **Chia sẻ → Thêm vào MH chính**.
- **Đọc khi không có mạng**:
  - Các chương đã mở được lưu lại trên máy.
  - Nút **Tải về đọc offline** ở trang truyện tải sẵn cả truyện.
- **Nghe truyện**:
  - Bấm 🎧 trong trình đọc để nghe bằng giọng đọc có sẵn trên máy.
  - Chỉnh được tốc độ và giọng đọc. Chạm vào đoạn nào thì đọc từ đoạn đó.
  - Đọc hết chương thì tự sang chương sau, nhạc nền tự nhỏ lại khi đang đọc.
  - Cần máy có giọng tiếng Việt. Android và Microsoft Edge thường có sẵn; trên Windows, thêm trong *Cài đặt → Thời gian & ngôn ngữ → Giọng nói*.
- **Giọng AI · Người kể chuyện**: chọn trong ô giọng đọc của thanh nghe. Giọng được tạo ngay trên máy người đọc, không qua máy chủ.
  - Dùng model [VieNeu-TTS v3 Nano](https://huggingface.co/pnnbao-ump/VieNeu-TTS-v3-Nano) (Apache-2.0) chạy bằng onnxruntime-web trong Web Worker. Giọng người kể chuyện là giọng clone, lưu sẵn ở `public/ai-voice/narrator.json`.
  - Lần đầu tải khoảng 280 MB model từ Hugging Face, lưu trong bộ nhớ trình duyệt (Cache Storage). Các lần sau mở ngay, kể cả khi mất mạng.
  - Đọc từng câu: câu đầu phát sau vài giây, trong lúc nghe trang tự sinh trước 3 đoạn phía sau.
  - Chuyển chữ thành âm vị bằng bảng tra âm tiết `public/ai-voice/g2p_vi.json` (khoảng 100 KB khi nén), khớp 98,9% với bộ sea-g2p gốc.
  - Cần header `Cross-Origin-Opener-Policy` / `Cross-Origin-Embedder-Policy` (đã có trong `vercel.json` và `serve.ps1`) để chạy đa luồng. Trình duyệt không hỗ trợ (Safari cũ) vẫn chạy được nhưng chỉ 1 luồng, chậm hơn.
  - Laptop Core i5 đời 12: tạo giọng nhanh gấp khoảng 1,7 lần tốc độ nghe. Máy yếu hơn có thể phải chờ giữa các đoạn.

## Cài đặt Bunny

1. Tạo **Storage Zone** (ví dụ `tutien`) và ghi nhớ vùng (region) của nó.
2. Tạo **Pull Zone** với nguồn (origin) là Storage Zone đó, ví dụ `https://tutien.b-cdn.net`.
3. Pull Zone → **Headers** → bật **Add CORS headers** và thêm các đuôi `json, epub, jpg, png, webp, mp3, ogg, m4a`.
   Thiếu bước này thì trang đọc không tải được truyện. Mục **Cài đặt** trong /admin có dòng kiểm tra kết nối.
4. Pull Zone → **Caching**: kiểm tra **Vary Cache → URL Query String** đang bật. Khi đó truyện mới hiện trên trang đọc sau khoảng 1 phút.

## Supabase: tài khoản người đọc + đăng nhập quản trị an toàn (tuỳ chọn)

Khi bật:
- **Danh sách truyện, nhạc nền, tên trang, thông báo** nằm trong database (bảng `novels`, `music`, `site_settings`) thay cho `catalog.json`.
  - Admin thêm, sửa, ẩn hay xoá truyện thì người đọc thấy **ngay**, không bị CDN giữ bản cũ.
  - Trang đọc lưu lại danh sách lần tải gần nhất, nên vẫn mở được khi mất mạng hoặc khi Supabase đang tạm dừng.
- **Nội dung chương, ảnh bìa, file nhạc** vẫn nằm trên Bunny CDN. Mỗi lần đăng là một đường dẫn mới nên không bao giờ lẫn bản cũ.
- **Người đọc** đăng nhập để tiến độ đọc và tủ sách tự đồng bộ giữa các máy. Không đăng nhập vẫn đọc bình thường.
- **Admin** đăng nhập bằng tài khoản. Việc ghi lên Bunny đi qua Edge Function `bunny`, nên mật khẩu Storage chỉ nằm trên server Supabase.

Nếu đã chạy `schema.sql` bản cũ, hãy **chạy lại bản mới**. Lệnh chạy lại được nhiều lần và không làm mất dữ liệu. Trước đây đã có truyện trong `catalog.json` thì vào **/admin → Cài đặt** và bấm **Chuyển sang database**.

Các bước (làm trên dashboard Supabase, không cần cài gì):

1. **SQL Editor → New query**: dán toàn bộ file [`supabase/schema.sql`](supabase/schema.sql) rồi bấm **Run**.
2. **Authentication → URL Configuration**:
   - *Site URL*: địa chỉ Vercel, ví dụ `https://tutiencac.vercel.app`.
   - *Redirect URLs*: thêm `https://tutiencac.vercel.app/**` (và `http://localhost:5500/**` nếu chạy thử trên máy).
3. **Edge Functions → Deploy a new function → Via Editor**:
   - Đặt tên `bunny`.
   - Dán nội dung [`supabase/functions/bunny/index.ts`](supabase/functions/bunny/index.ts).
   - Bấm **Deploy**, để nguyên *Verify JWT* đang bật.
   - Mỗi lần file này thay đổi, dán lại và Deploy lại. Bản hiện tại nhận **lô nhiều file trong một request** (`POST ?batch=1`): trang quản trị gom các gói chương thành lô ~4 MB, function tự ghi song song lên Bunny. Đăng truyện nhanh hơn nhiều so với gửi từng gói (mỗi gói tốn thêm một preflight CORS và một lượt trình duyệt → Supabase → Bunny). Function bản cũ chưa có lô thì trang tự gửi từng gói như trước.
4. **Edge Functions → Secrets**, thêm 3 biến:
   - `BUNNY_STORAGE_ZONE` = tên Storage Zone, ví dụ `tutiencac`.
   - `BUNNY_STORAGE_KEY` = mật khẩu Storage, lấy ở Bunny → Storage → FTP & API Access → Password.
   - `BUNNY_STORAGE_HOST` = `storage.bunnycdn.com`, hoặc máy chủ theo vùng của zone.
5. **Project Settings → API**: copy *Project URL* và khoá *anon public* vào `public/config.js`:
   ```js
   supabaseUrl: "https://xxxx.supabase.co",
   supabaseAnonKey: "eyJ...",
   ```
   Khoá anon là khoá công khai, đưa lên web được. **Không** dùng khoá `service_role`.
6. Deploy lại Vercel, mở trang đọc, bấm **Đăng nhập → Chưa có tài khoản? Đăng ký** để tạo tài khoản của bạn.
7. Cấp quyền quản trị cho tài khoản đó trong **SQL Editor** (thay email):
   ```sql
   insert into public.admins (user_id)
   select id from auth.users where email = 'email-cua-ban@example.com' on conflict do nothing;
   ```
8. Mở `/admin` và đăng nhập bằng email + mật khẩu vừa tạo. Vào **Cài đặt** và bấm xoá file `_admin/key.json` cũ nếu trang báo còn.

Lưu ý:
- **Email xác nhận**: Supabase chỉ gửi được vài email mỗi giờ bằng máy chủ mặc định.
  - Khi có nhiều người đăng ký, cài SMTP riêng trong *Authentication → Emails*.
  - Hoặc tắt *Confirm email* trong *Authentication → Providers → Email*.
- **Đăng nhập Google**: bật trong *Authentication → Providers → Google*, rồi đặt `googleLogin: true` trong `config.js`.
- **Gói miễn phí**: project bị tạm dừng nếu không có ai dùng trong 1 tuần. Vào dashboard bấm *Restore* là chạy lại. Trong lúc tạm dừng, trang đọc vẫn đọc được bình thường, chỉ không đồng bộ được.
- **Không còn đăng nhập dự phòng bằng mật khẩu Storage** khi đã bật Supabase. Danh sách truyện giờ nằm trong database, nên chỉ tài khoản admin trên Supabase sửa được.

Chạy thử trên máy: `serve.ps1 -Mock` có giả lập cả Edge Function ở `/_mock/sb/functions/v1/bunny`. Token `tok-admin` là admin, `tok-user` là người dùng thường.

## Deploy lên Vercel

1. Sửa `public/config.js`:
   ```js
   cdnBase: "https://tutien.b-cdn.net",
   storageZone: "tutien",
   storageHost: "sg.storage.bunnycdn.com", // theo vùng Storage Zone, Falkenstein là storage.bunnycdn.com
   ```
2. Đưa thư mục dự án lên GitHub, rồi trên Vercel chọn **Add New → Project** và import repo. Không cần build, `vercel.json` đã cấu hình sẵn.

Để trống `cdnBase` thì trang đọc chạy chế độ demo với 3 truyện mẫu trong `public/js/demo-data.js`.

## Chạy thử trên máy

```bash
powershell -ExecutionPolicy Bypass -File serve.ps1
```

Mở http://localhost:5500 (trang đọc) và http://localhost:5500/admin (quản trị).

Muốn thử trang quản trị mà chưa có Bunny, chạy thêm `-Mock` để giả lập Bunny Storage trên máy:

```bash
powershell -ExecutionPolicy Bypass -File serve.ps1 -Mock
```

Dữ liệu giả lập lưu trong thư mục `mock-bunny\`. Trên màn hình đăng nhập, mở **Kết nối Bunny** và điền:

- Storage Zone: `test`
- Máy chủ Storage: `http://localhost:5500/_mock`
- CDN: `http://localhost:5500/_mock/test`

Mật khẩu là `devkey`.

## Nhạc nền

- 4 bài dựng sẵn được tổng hợp trực tiếp bằng Web Audio theo thang ngũ cung, gồm tiếng cổ cầm, tiêu, chuông, mưa, gió và giọt nước. Không cần file và không lo bản quyền:
  - *Thanh Sơn Tĩnh Tọa*
  - *Vân Hải Phiêu Diêu*
  - *Trúc Lâm Thính Vũ*
  - *Linh Tuyền Cổ Động*
- Bài tải lên qua /admin hiện thêm trong danh sách. Chỉ dùng nhạc bạn có quyền phát.

## Mã nguồn

| File | Nội dung |
|---|---|
| `public/index.html`, `public/js/app.js` | Trang đọc: thư viện, tủ sách, trình đọc, sao lưu/khôi phục dữ liệu |
| `public/admin/` | Trang quản trị |
| `public/js/epub.js` | Đọc EPUB trên trình duyệt (dùng JSZip từ cdnjs), dùng chung cho cả hai trang |
| `public/js/music.js` | Nhạc nền |
| `public/config.js` | Cấu hình kết nối Bunny (không chứa mật khẩu) |
| `serve.ps1` | Server tĩnh để chạy thử, kèm chế độ giả lập Bunny |
