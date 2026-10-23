-- Tu Tiên Các: bảng dữ liệu trên Supabase.
-- Chạy một lần trong Supabase → SQL Editor → New query → dán toàn bộ file này → Run.
-- Chạy lại cũng không sao (không xoá dữ liệu cũ).

-- Tiến độ đọc + tủ sách của từng tài khoản (một dòng mỗi người).
create table if not exists public.reader_state (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  constraint reader_state_size check (pg_column_size(data) < 1000000)
);

alter table public.reader_state enable row level security;

drop policy if exists "reader_state: xem của mình" on public.reader_state;
create policy "reader_state: xem của mình" on public.reader_state
  for select to authenticated using ((select auth.uid()) = user_id);

drop policy if exists "reader_state: tạo của mình" on public.reader_state;
create policy "reader_state: tạo của mình" on public.reader_state
  for insert to authenticated with check ((select auth.uid()) = user_id);

drop policy if exists "reader_state: sửa của mình" on public.reader_state;
create policy "reader_state: sửa của mình" on public.reader_state
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

drop policy if exists "reader_state: xoá của mình" on public.reader_state;
create policy "reader_state: xoá của mình" on public.reader_state
  for delete to authenticated using ((select auth.uid()) = user_id);

-- Danh sách tài khoản quản trị. Trình duyệt không ghi được bảng này;
-- thêm admin bằng câu lệnh ở cuối file.
create table if not exists public.admins (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.admins enable row level security;

drop policy if exists "admins: tự kiểm tra" on public.admins;
create policy "admins: tự kiểm tra" on public.admins
  for select to authenticated using ((select auth.uid()) = user_id);

-- Hàm kiểm tra người đang đăng nhập có phải admin không (dùng trong các quy tắc bên dưới).
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = ''
as $$ select exists (select 1 from public.admins where user_id = (select auth.uid())); $$;

-- ------------------------------------------------------------------
-- Thư viện: danh sách truyện, nhạc nền, thông tin trang (thay cho catalog.json).
-- Ai cũng đọc được; truyện đang ẩn chỉ admin thấy; chỉ admin được sửa.
-- Nội dung chương và ảnh bìa vẫn nằm trên Bunny, ở đây chỉ lưu đường dẫn.

create table if not exists public.novels (
  id          text primary key,              -- mã truyện, dùng trong địa chỉ trang và tiến độ đọc
  title       text not null,
  author      text,
  tags        text[] not null default '{}',
  status      text,
  description text,
  cover       text,                          -- bia/<id>-<mã>.jpg
  dir         text,                          -- novels/<id>/<phiên bản> (gói chương)
  file        text,                          -- truyen/*.epub (truyện cũ chưa chia gói)
  chunk       int not null default 50,
  chapters    int not null default 0,
  words       bigint not null default 0,
  hidden      boolean not null default false,
  updated     text,                          -- mã thời gian lần thay nội dung gần nhất
  position    double precision not null default 0,
  updated_at  timestamptz not null default now()
);

create table if not exists public.music (
  file     text primary key,                 -- nhac/*.mp3 trên Bunny
  title    text not null default '',
  position double precision not null default 0
);

create table if not exists public.site_settings (
  id     int primary key default 1 check (id = 1),
  name   text,
  notice text
);

alter table public.novels enable row level security;
alter table public.music enable row level security;
alter table public.site_settings enable row level security;

drop policy if exists "novels: ai cũng xem" on public.novels;
create policy "novels: ai cũng xem" on public.novels
  for select to anon, authenticated using (not hidden or (select public.is_admin()));
drop policy if exists "novels: admin sửa" on public.novels;
create policy "novels: admin sửa" on public.novels
  for all to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));

drop policy if exists "music: ai cũng xem" on public.music;
create policy "music: ai cũng xem" on public.music for select to anon, authenticated using (true);
drop policy if exists "music: admin sửa" on public.music;
create policy "music: admin sửa" on public.music
  for all to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));

drop policy if exists "site: ai cũng xem" on public.site_settings;
create policy "site: ai cũng xem" on public.site_settings for select to anon, authenticated using (true);
drop policy if exists "site: admin sửa" on public.site_settings;
create policy "site: admin sửa" on public.site_settings
  for all to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));

-- Quyền truy cập bảng qua API (quy tắc RLS ở trên vẫn quyết định từng dòng).
grant select on public.novels, public.music, public.site_settings to anon, authenticated;
grant insert, update, delete on public.novels, public.music, public.site_settings to authenticated;
grant select, insert, update, delete on public.reader_state to authenticated;
grant select on public.admins to authenticated;

-- ------------------------------------------------------------------
-- CẤP QUYỀN QUẢN TRỊ (chạy riêng, SAU KHI đã đăng ký tài khoản trên web):
-- thay email rồi bôi đen 2 dòng dưới và bấm Run.
--
-- insert into public.admins (user_id)
-- select id from auth.users where email = 'email-cua-ban@example.com' on conflict do nothing;
