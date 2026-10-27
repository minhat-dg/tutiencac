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
-- Thư viện: danh sách truyện, thông tin trang (thay cho catalog.json).
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

create table if not exists public.site_settings (
  id     int primary key default 1 check (id = 1),
  name   text,
  notice text
);

alter table public.novels enable row level security;
alter table public.site_settings enable row level security;

drop policy if exists "novels: ai cũng xem" on public.novels;
create policy "novels: ai cũng xem" on public.novels
  for select to anon, authenticated using (not hidden or (select public.is_admin()));
drop policy if exists "novels: admin sửa" on public.novels;
create policy "novels: admin sửa" on public.novels
  for all to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));

drop policy if exists "site: ai cũng xem" on public.site_settings;
create policy "site: ai cũng xem" on public.site_settings for select to anon, authenticated using (true);
drop policy if exists "site: admin sửa" on public.site_settings;
create policy "site: admin sửa" on public.site_settings
  for all to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));

-- Quyền truy cập bảng qua API (quy tắc RLS ở trên vẫn quyết định từng dòng).
grant select on public.novels, public.site_settings to anon, authenticated;
grant insert, update, delete on public.novels, public.site_settings to authenticated;
grant select, insert, update, delete on public.reader_state to authenticated;
grant select on public.admins to authenticated;

-- ------------------------------------------------------------------
-- Thống kê truy cập (ẩn danh): mỗi trình duyệt có một mã ngẫu nhiên, không lưu IP hay tài khoản.
-- Trình duyệt không đọc/ghi thẳng 2 bảng này (bật RLS, không có quy tắc nào);
-- chỉ đi qua hàm track() (ai cũng gọi được) và admin_stats() (chỉ admin).

create table if not exists public.page_views (
  id      bigint generated always as identity primary key,
  at      timestamptz not null default now(),
  visitor text not null,
  page    text not null,                     -- home, novel, read, shelf…
  novel   text,
  chapter int
);
create index if not exists page_views_at on public.page_views (at);
create index if not exists page_views_visitor on public.page_views (visitor, at);

-- Ai đang mở trang: mỗi trình duyệt một dòng, cập nhật khoảng mỗi phút.
create table if not exists public.presence (
  visitor   text primary key,
  page      text not null,
  novel     text,
  chapter   int,
  listening boolean not null default false,  -- đang nghe giọng đọc
  seen      timestamptz not null default now()
);
create index if not exists presence_seen on public.presence (seen);

alter table public.page_views enable row level security;
alter table public.presence enable row level security;

-- p_view = true: tính một lượt xem (mở trang); false: chỉ báo "vẫn đang ở đây".
create or replace function public.track(p_visitor text, p_page text, p_novel text, p_chapter int, p_view boolean, p_listening boolean)
returns void language plpgsql security definer set search_path = ''
as $$
begin
  if p_visitor is null or p_visitor !~ '^[a-z0-9]{12,32}$' then return; end if;
  p_page := left(coalesce(p_page, ''), 20);
  p_novel := left(p_novel, 120);
  if p_view and not exists (   -- bỏ lượt mở lại đúng trang đó trong 30 giây (tải lại, bấm qua lại)
    select 1 from public.page_views v
    where v.visitor = p_visitor and v.at > now() - interval '30 seconds'
      and v.page = p_page and v.novel is not distinct from p_novel and v.chapter is not distinct from p_chapter
  ) then
    insert into public.page_views (visitor, page, novel, chapter) values (p_visitor, p_page, p_novel, p_chapter);
  end if;
  insert into public.presence (visitor, page, novel, chapter, listening, seen)
  values (p_visitor, p_page, p_novel, p_chapter, coalesce(p_listening, false), now())
  on conflict (visitor) do update
    set page = excluded.page, novel = excluded.novel, chapter = excluded.chapter, listening = excluded.listening, seen = now();
end;
$$;

-- Số liệu cho trang quản trị. Ngày tính theo giờ Việt Nam. Dọn luôn dữ liệu cũ.
create or replace function public.admin_stats(p_days int default 14)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  tz constant text := 'Asia/Ho_Chi_Minh';
  online_since constant timestamptz := now() - interval '150 seconds';
  today date := (now() at time zone tz)::date;
  result jsonb;
begin
  if not public.is_admin() then raise exception 'Chỉ admin xem được thống kê'; end if;
  p_days := least(greatest(coalesce(p_days, 14), 1), 90);
  delete from public.presence where seen < now() - interval '1 day';
  delete from public.page_views where at < now() - interval '180 days';

  select jsonb_build_object(
    'online', (select count(*) from public.presence where seen > online_since),
    'listening', (select count(*) from public.presence where seen > online_since and listening),
    'reading', coalesce((
      select jsonb_agg(r order by r.n desc, r.novel) from (
        select novel, chapter, count(*) as n, count(*) filter (where listening) as listening
        from public.presence where seen > online_since and page = 'read' and novel is not null
        group by novel, chapter order by n desc limit 30
      ) r), '[]'::jsonb),
    'pages', coalesce((
      select jsonb_object_agg(page, n) from (
        select page, count(*) as n from public.presence where seen > online_since group by page
      ) p), '{}'::jsonb),
    'daily', (
      select jsonb_agg(jsonb_build_object('day', d.day::date, 'views', coalesce(v.views, 0), 'visitors', coalesce(v.visitors, 0)) order by d.day)
      from generate_series((today - (p_days - 1))::timestamp, today::timestamp, interval '1 day') as d(day)
      left join (
        select (at at time zone tz)::date as day, count(*) as views, count(distinct visitor) as visitors
        from public.page_views where at >= (today - (p_days - 1))::timestamp at time zone tz
        group by 1
      ) v on v.day = d.day::date),
    'top', coalesce((
      select jsonb_agg(t order by t.views desc) from (
        select novel, count(*) as views, count(distinct visitor) as visitors
        from public.page_views
        where novel is not null and at >= (today - 6)::timestamp at time zone tz
        group by novel order by views desc limit 10
      ) t), '[]'::jsonb)
  ) into result;
  return result;
end;
$$;

grant execute on function public.track(text, text, text, int, boolean, boolean) to anon, authenticated;
grant execute on function public.admin_stats(int) to authenticated;

-- ------------------------------------------------------------------
-- CẤP QUYỀN QUẢN TRỊ (chạy riêng, SAU KHI đã đăng ký tài khoản trên web):
-- thay email rồi bôi đen 2 dòng dưới và bấm Run.
--
-- insert into public.admins (user_id)
-- select id from auth.users where email = 'email-cua-ban@example.com' on conflict do nothing;
