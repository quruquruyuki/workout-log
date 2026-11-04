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
