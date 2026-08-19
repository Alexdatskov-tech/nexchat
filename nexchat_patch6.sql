-- =============================================================================
-- NEXCHAT - PATCH 6
-- Ban appeals, plus the Realtime publication entry that makes a ban land
-- instantly on an already-signed-in session.
--
-- Run once in the Supabase SQL Editor. Safe to re-run.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Realtime for bans
--    guard.js subscribes to UPDATEs on the signed-in user's own profile row so
--    a ban takes effect immediately. A table that is not in the publication
--    never emits those events -- the channel still reports SUBSCRIBED, it is
--    simply silent -- and the ban would only be caught by the 15 s poll.
--
--    `replica identity full` is what puts the *old* row in the payload; without
--    it an UPDATE arrives carrying only the primary key and the client cannot
--    see that is_banned flipped.
-- -----------------------------------------------------------------------------
do $$ begin alter publication supabase_realtime add table public.profiles; exception when duplicate_object then null; end $$;
alter table public.profiles replica identity full;

-- -----------------------------------------------------------------------------
-- 2. A banned user must still be able to read their own row
--    The guard watches profiles for is_banned, and the sign-in path reads
--    ban_reason to show on the ban card. If a policy hides banned rows then
--    neither can see the thing they are looking for.
-- -----------------------------------------------------------------------------
drop policy if exists "profiles_select_self" on public.profiles;
create policy "profiles_select_self" on public.profiles for select
  using (id = auth.uid());

-- -----------------------------------------------------------------------------
-- 3. Appeals
-- -----------------------------------------------------------------------------
create table if not exists public.ban_appeals (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles(id) on delete cascade,
  message      text not null check (char_length(message) between 10 and 2000),
  status       text not null default 'pending' check (status in ('pending','accepted','declined')),
  created_at   timestamptz not null default now(),
  reviewed_by  uuid references public.profiles(id),
  reviewed_at  timestamptz,
  review_note  text
);

create index if not exists idx_ban_appeals_status on public.ban_appeals(status, created_at desc);

-- One pending appeal at a time, so a banned user cannot flood the queue.
create unique index if not exists idx_ban_appeals_one_pending
  on public.ban_appeals(user_id) where status = 'pending';

alter table public.ban_appeals enable row level security;

-- A user may file an appeal for themselves, and only while actually banned.
drop policy if exists "ban_appeals_insert_self" on public.ban_appeals;
create policy "ban_appeals_insert_self" on public.ban_appeals for insert
  with check (
    user_id = auth.uid()
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_banned)
  );

-- Users see their own appeals; admins see everything.
drop policy if exists "ban_appeals_select" on public.ban_appeals;
create policy "ban_appeals_select" on public.ban_appeals for select
  using (
    user_id = auth.uid()
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_platform_admin)
  );

-- Only admins rule on an appeal.
drop policy if exists "ban_appeals_update_admin" on public.ban_appeals;
create policy "ban_appeals_update_admin" on public.ban_appeals for update
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_platform_admin))
  with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_platform_admin));

-- -----------------------------------------------------------------------------
-- 4. Accepting an appeal lifts the ban in the same step
--    SECURITY DEFINER so the two writes cannot half-apply: an accepted appeal
--    with the account still locked would be worse than no appeal at all.
-- -----------------------------------------------------------------------------
create or replace function public.resolve_ban_appeal(
  p_appeal_id uuid,
  p_accept    boolean,
  p_note      text default null
) returns void language plpgsql security definer set search_path = public as $$
declare v_user uuid;
begin
  if not exists (select 1 from public.profiles where id = auth.uid() and is_platform_admin) then
    raise exception 'not authorised';
  end if;

  select user_id into v_user from public.ban_appeals where id = p_appeal_id;
  if v_user is null then raise exception 'no such appeal'; end if;

  update public.ban_appeals
     set status      = case when p_accept then 'accepted' else 'declined' end,
         reviewed_by = auth.uid(),
         reviewed_at = now(),
         review_note = p_note
   where id = p_appeal_id;

  if p_accept then
    update public.profiles set is_banned = false, ban_reason = null where id = v_user;
  end if;
end;
$$;

revoke all on function public.resolve_ban_appeal(uuid, boolean, text) from public;
grant execute on function public.resolve_ban_appeal(uuid, boolean, text) to authenticated;

-- -----------------------------------------------------------------------------
-- Verification
--   Runs last, so it only reports if the whole file arrived. A truncated paste
--   is the likeliest failure here -- if this final query does not appear in the
--   results, the patch did not finish and should be re-run from the top.
-- -----------------------------------------------------------------------------
select
  to_regclass('public.ban_appeals')                              is not null as ban_appeals_table,
  to_regproc('public.resolve_ban_appeal(uuid,boolean,text)')     is not null as resolve_function,
  exists (select 1 from pg_publication_tables
           where pubname = 'supabase_realtime'
             and schemaname = 'public' and tablename = 'profiles')          as profiles_realtime,
  exists (select 1 from pg_indexes
           where schemaname = 'public'
             and indexname = 'idx_ban_appeals_one_pending')                 as one_pending_index,
  exists (select 1 from pg_policies
           where schemaname = 'public' and tablename = 'profiles'
             and policyname = 'profiles_select_self')                       as self_select_policy;
