-- ============================================================
-- Studrio Booth — Admin Dashboard setup
-- Run this once in Supabase SQL Editor (Project → SQL Editor → New query)
-- ============================================================

-- ---- 1. SESSIONS TABLE ----
-- One row per photobooth session (= one photostrip taken).
-- Mirrors the session.json already uploaded to Storage, but as a
-- queryable table so the dashboard doesn't have to list/parse storage
-- folders to build the gallery list or count "photostrips taken".
create table if not exists public.sessions (
  id text primary key,
  frame_type text,
  design text,
  final_strip_url text,
  final_strip_video_url text,
  created_at timestamptz not null default now()
);

alter table public.sessions enable row level security;

-- The kiosk itself is NOT logged in (anon key) — it must still be able
-- to insert a new session row the moment a strip is finished.
create policy "kiosk can insert sessions"
  on public.sessions for insert
  to anon
  with check (true);

-- Only the authenticated admin (you, logged into admin.html) can list
-- or delete sessions. Guests never query this table directly — they
-- read session.json from the public bucket URL instead (unchanged).
create policy "admin can read sessions"
  on public.sessions for select
  to authenticated
  using (true);

create policy "admin can delete sessions"
  on public.sessions for delete
  to authenticated
  using (true);


-- ---- 2. PRINT EVENTS TABLE ----
-- One row per physical print job (so "copies printed" can be a simple
-- SUM(quantity) instead of an easily-corrupted counter).
create table if not exists public.print_events (
  id bigint generated always as identity primary key,
  session_id text references public.sessions(id) on delete cascade,
  quantity int not null default 1,
  printed_at timestamptz not null default now()
);

alter table public.print_events enable row level security;

create policy "kiosk can log print events"
  on public.print_events for insert
  to anon
  with check (true);

create policy "admin can read print events"
  on public.print_events for select
  to authenticated
  using (true);


-- ---- 3. STORAGE BUCKET — tighten delete permission ----
-- Your bucket policies currently allow open INSERT/UPDATE (fine, the
-- kiosk needs that) but should NOT allow anonymous DELETE. Run this to
-- ensure only an authenticated admin session can delete files, while
-- the kiosk (anon) can still upload and guests can still read.
--
-- NOTE: if you already have broader policies from initial setup,
-- check Storage → photobooth bucket → Policies in the dashboard and
-- remove any "anon" DELETE policy, then add:

create policy "admin can delete photobooth files"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'photobooth');

-- ============================================================
-- After running this:
-- 1. Go to Authentication → Users → Add user, create your admin login
--    (email + password) — this is what admin.html will sign in with.
-- 2. Confirm Storage → photobooth bucket → Policies shows:
--    SELECT: public/anon (unchanged, guests need this)
--    INSERT/UPDATE: anon (unchanged, kiosk needs this)
--    DELETE: authenticated only (added above)
-- ============================================================
