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

-- ------------------------------------------------------------------
-- CẤP QUYỀN QUẢN TRỊ (chạy riêng, SAU KHI đã đăng ký tài khoản trên web):
-- thay email rồi bôi đen 2 dòng dưới và bấm Run.
--
-- insert into public.admins (user_id)
-- select id from auth.users where email = 'email-cua-ban@example.com' on conflict do nothing;
