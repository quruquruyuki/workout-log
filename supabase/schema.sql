-- 運動ログ用テーブル（Supabase プロジェクト「quruquruyuki's Project」に同居。2026-11-20 に別プロジェクト workout-log から移行）
-- ほかのアプリと表がぶつからないよう、名前は wl_ で始める。どれも「本人の行だけ」読み書きできる（RLS）。
create table if not exists public.wl_workouts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  date date not null,
  type text not null check (type = any (array['strength','run'])),
  part text, exercise text, weight numeric, reps text, sets integer,
  minutes numeric, km numeric, place text, memo text,
  created_at timestamptz not null default now(),
  set_list jsonb,
  unilateral boolean not null default false,
  started_at timestamptz
);
create index if not exists wl_workouts_user_date on public.wl_workouts (user_id, date);

create table if not exists public.wl_body_metrics (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  date date not null, weight numeric, fat numeric, memo text,
  created_at timestamptz not null default now()
);

-- 休憩終了のプッシュ通知の登録先と、動いているタイマー
create table if not exists public.wl_push_subs (
  endpoint text primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  p256dh text not null, auth text not null,
  created_at timestamptz not null default now()
);
create table if not exists public.wl_rest_timers (
  user_id uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  timer_id uuid not null, fire_at timestamptz not null, note text,
  updated_at timestamptz not null default now()
);

-- Claudeのアドバイス（種目ごと。画面からは読む・消すだけ）
create table if not exists public.wl_coach_notes (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  exercise text not null, note text not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, exercise)
);

-- 通知用の鍵など（関数 workout-rest-push だけが読む。値はここには書かない）
create table if not exists public.wl_secrets (name text primary key, value text not null);

alter table public.wl_workouts enable row level security;
alter table public.wl_body_metrics enable row level security;
alter table public.wl_push_subs enable row level security;
alter table public.wl_rest_timers enable row level security;
alter table public.wl_coach_notes enable row level security;
alter table public.wl_secrets enable row level security;

do $$
declare t text;
begin
  foreach t in array array['wl_workouts','wl_body_metrics','wl_push_subs','wl_rest_timers'] loop
    execute format('create policy "own select" on public.%I for select to authenticated using (user_id = (select auth.uid()))', t);
    execute format('create policy "own insert" on public.%I for insert to authenticated with check (user_id = (select auth.uid()))', t);
    execute format('create policy "own update" on public.%I for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()))', t);
    execute format('create policy "own delete" on public.%I for delete to authenticated using (user_id = (select auth.uid()))', t);
  end loop;
end $$;
create policy "own select" on public.wl_coach_notes for select to authenticated using (user_id = (select auth.uid()));
create policy "own delete" on public.wl_coach_notes for delete to authenticated using (user_id = (select auth.uid()));

grant select, insert, update, delete on public.wl_workouts, public.wl_body_metrics, public.wl_push_subs, public.wl_rest_timers to authenticated;
grant select, delete on public.wl_coach_notes to authenticated;
grant all on public.wl_workouts, public.wl_body_metrics, public.wl_push_subs, public.wl_rest_timers, public.wl_coach_notes, public.wl_secrets to service_role;
revoke all on public.wl_workouts, public.wl_body_metrics, public.wl_push_subs, public.wl_rest_timers, public.wl_coach_notes, public.wl_secrets from anon;
revoke all on public.wl_secrets from authenticated;
