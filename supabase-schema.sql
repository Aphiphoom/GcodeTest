-- =============================================================================
-- supabase-schema.sql
-- -----------------------------------------------------------------------------
-- รันไฟล์นี้ใน Supabase Dashboard -> SQL Editor -> New query -> วางทั้งหมด -> Run
-- สร้างตารางสำหรับ: โปรไฟล์สมาชิก (สถานะ/สิทธิ์), การตั้งค่าโปรแกรมต่อคน, login log
-- พร้อม Row Level Security (RLS) ที่ทำหน้าที่แทน "Netlify Functions" ทั้งหมด —
-- เบราว์เซอร์เรียก Supabase ตรงได้อย่างปลอดภัย เพราะกฎการเข้าถึงถูกบังคับใน database
-- ไม่ต้องมี backend function แยกแม้แต่ตัวเดียว
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1) ตาราง profiles: หนึ่งแถวต่อสมาชิกหนึ่งคน เก็บ role/status/วันหมดอายุ
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  role text not null default 'member',      -- 'member' | 'admin'
  status text not null default 'pending',   -- 'pending' | 'active' | 'suspended'
  expires_at timestamptz,                   -- ใช้ได้ถึงวันที่ (null = ไม่จำกัด)
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 2) ตาราง user_settings: การตั้งค่าโปรแกรมผูกกับ user (Tool/Machine/Mapping/Post)
-- ---------------------------------------------------------------------------
create table if not exists public.user_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  machine jsonb not null default '{}'::jsonb,
  tools jsonb not null default '{}'::jsonb,
  saved_mappings jsonb not null default '{}'::jsonb,
  tool_change text not null default '',
  header text not null default '',
  footer text not null default '',
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 3) ตาราง login_logs: ประวัติการ login (เวลา/IP/เมือง/ประเทศ/อุปกรณ์)
--    หมายเหตุ: ค่า ip/city/country มาจากเบราว์เซอร์ผู้ใช้เอง (เรียก API หาตำแหน่ง
--    ตัวเอง) ไม่ใช่ server-side แบบที่ Netlify Functions ทำได้ — เชื่อถือได้น้อยกว่า
--    เดิมเล็กน้อย (คนที่ตั้งใจปลอมแก้โค้ดได้) แต่ใช้แค่เตือนแอดมินดูเฉย ๆ จึงยอมรับได้
-- ---------------------------------------------------------------------------
create table if not exists public.login_logs (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  ip text,
  city text,
  country text,
  country_code text,
  user_agent text,
  flagged boolean not null default false
);

-- ---------------------------------------------------------------------------
-- 4) เปิด Row Level Security
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.user_settings enable row level security;
alter table public.login_logs enable row level security;

-- ---------------------------------------------------------------------------
-- 5) ฟังก์ชันช่วยเช็คว่า user ปัจจุบันเป็น admin หรือไม่ (ใช้ใน policy หลายที่)
--    security definer เพื่อให้ query ตาราง profiles ได้แม้ RLS ของ profiles เองจะกันอยู่
-- ---------------------------------------------------------------------------
create or replace function public.is_admin() returns boolean as $$
  select exists(
    select 1 from public.profiles where id = auth.uid() and role = 'admin'
  );
$$ language sql security definer stable;

-- ---------------------------------------------------------------------------
-- 6) Policies: profiles
-- ---------------------------------------------------------------------------
drop policy if exists "select own profile" on public.profiles;
create policy "select own profile" on public.profiles
  for select using (auth.uid() = id);

drop policy if exists "admin select all profiles" on public.profiles;
create policy "admin select all profiles" on public.profiles
  for select using (public.is_admin());

-- สมาชิกทั่วไป "ห้าม" แก้ไข role/status/expires_at ของตัวเอง — มีแค่ insert ตอนสมัคร
-- (ทำผ่าน trigger ด้านล่าง ไม่ใช่ client เรียกตรง) และ admin เท่านั้นที่ update ได้
drop policy if exists "admin update any profile" on public.profiles;
create policy "admin update any profile" on public.profiles
  for update using (public.is_admin());

drop policy if exists "insert own profile via trigger" on public.profiles;
create policy "insert own profile via trigger" on public.profiles
  for insert with check (auth.uid() = id);

-- ---------------------------------------------------------------------------
-- 7) Policies: user_settings (อ่าน/เขียนได้แค่ของตัวเอง)
-- ---------------------------------------------------------------------------
drop policy if exists "select own settings" on public.user_settings;
create policy "select own settings" on public.user_settings
  for select using (auth.uid() = user_id);

drop policy if exists "insert own settings" on public.user_settings;
create policy "insert own settings" on public.user_settings
  for insert with check (auth.uid() = user_id);

drop policy if exists "update own settings" on public.user_settings;
create policy "update own settings" on public.user_settings
  for update using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- 8) Policies: login_logs (insert ของตัวเอง, admin อ่านได้ทุกคน, เจ้าตัวอ่านได้แค่ตัวเอง)
-- ---------------------------------------------------------------------------
drop policy if exists "insert own log" on public.login_logs;
create policy "insert own log" on public.login_logs
  for insert with check (auth.uid() = user_id);

drop policy if exists "select own log" on public.login_logs;
create policy "select own log" on public.login_logs
  for select using (auth.uid() = user_id);

drop policy if exists "admin select all logs" on public.login_logs;
create policy "admin select all logs" on public.login_logs
  for select using (public.is_admin());

-- ---------------------------------------------------------------------------
-- 9) Trigger: สร้างแถว profiles อัตโนมัติทันทีที่มีคนสมัครสมาชิกใหม่
--    (status เริ่มต้น 'pending', role เริ่มต้น 'member' — แอดมินต้องมาเปลี่ยนเอง)
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user() returns trigger as $$
begin
  insert into public.profiles (id, email, role, status)
  values (new.id, new.email, 'member', 'pending');
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- =============================================================================
-- เสร็จแล้ว! ขั้นต่อไป: ตั้งบัญชีแอดมินคนแรกด้วยมือ (ดูคำอธิบายใน README.md ข้อ 3)
-- =============================================================================
