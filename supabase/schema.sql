-- 運動ログ用テーブル。Supabase の SQL Editor に貼り付けて「Run」してください。
create table if not exists public.workouts (
  id          uuid primary key,
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  date        date not null,
  type        text not null check (type in ('strength','run')),
  part        text,
  exercise    text,
  weight      numeric,
  reps        text,
  sets        integer,
  minutes     numeric,
  km          numeric,
  place       text,
  memo        text,
  created_at  timestamptz not null default now()
);
create index if not exists workouts_user_date on public.workouts (user_id, date);

-- 本人の記録だけを読み書きできるようにする（必須）
alter table public.workouts enable row level security;

drop policy if exists "own rows select" on public.workouts;
drop policy if exists "own rows insert" on public.workouts;
drop policy if exists "own rows update" on public.workouts;
drop policy if exists "own rows delete" on public.workouts;
create policy "own rows select" on public.workouts for select to authenticated using (user_id = auth.uid());
create policy "own rows insert" on public.workouts for insert to authenticated with check (user_id = auth.uid());
create policy "own rows update" on public.workouts for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own rows delete" on public.workouts for delete to authenticated using (user_id = auth.uid());

-- 追加（v2）：セット別の記録と片脚
alter table public.workouts add column if not exists set_list jsonb;
alter table public.workouts add column if not exists unilateral boolean not null default false;
grant select, insert, update, delete on public.workouts to authenticated;

-- 追加（v3）：トレーニング開始時刻
alter table public.workouts add column if not exists started_at timestamptz;

-- v4: 休憩終了のプッシュ通知
-- push_subs（端末ごとの通知の宛先）、rest_timers（いま動いている休憩タイマー）、
-- app_secrets（VAPID鍵など。RLS有効・ポリシーなしでサーバー専用。値はリポジトリに置かない）
create table if not exists public.push_subs (endpoint text primary key, user_id uuid not null default auth.uid() references auth.users(id) on delete cascade, p256dh text not null, auth text not null, created_at timestamptz not null default now());
create table if not exists public.rest_timers (user_id uuid primary key default auth.uid() references auth.users(id) on delete cascade, timer_id uuid not null, fire_at timestamptz not null, note text, updated_at timestamptz not null default now());
create table if not exists public.app_secrets (name text primary key, value text not null);
-- RLS・ポリシー・grantは body_metrics と同じ形（app_secrets はポリシーなし＋anon/authenticatedからrevoke）
