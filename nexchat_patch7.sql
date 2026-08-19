-- =============================================================================
-- NEXCHAT - PATCH 7
-- Lets an existing admin promote and demote other admins.
--
-- Run once in the Supabase SQL Editor. Safe to re-run.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Stop is_platform_admin from being self-granted
--    Admin status lives in a column on profiles, and users can update their own
--    profile row (that is how display names and themes are saved). Nothing so
--    far stops someone sending an update that also flips is_platform_admin on
--    their own row, which would hand out the whole admin panel for free.
--
--    Rather than trust every present and future profiles policy to exclude the
--    column, this trigger refuses any change to it that did not come from the
--    function below. The function announces itself with a transaction-local
--    setting, which a client cannot forge over PostgREST.
-- -----------------------------------------------------------------------------
create or replace function public.guard_platform_admin()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.is_platform_admin is distinct from old.is_platform_admin
     and coalesce(current_setting('nexchat.admin_grant', true), '') <> 'on' then
    raise exception 'admin status can only be changed with set_user_admin()';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_platform_admin on public.profiles;
create trigger trg_guard_platform_admin
  before update on public.profiles
  for each row execute function public.guard_platform_admin();

-- -----------------------------------------------------------------------------
-- 2. Audit trail
--    Promotions are the most consequential action in the app, so who did what
--    to whom is worth keeping. Readable by admins only.
-- -----------------------------------------------------------------------------
create table if not exists public.admin_grants (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  granted    boolean not null,
  actor_id   uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists idx_admin_grants_created on public.admin_grants (created_at desc);

alter table public.admin_grants enable row level security;

drop policy if exists "admin_grants_select_admin" on public.admin_grants;
create policy "admin_grants_select_admin" on public.admin_grants for select
  using (exists (select 1 from public.profiles p
                  where p.id = auth.uid() and p.is_platform_admin));

-- No insert/update/delete policy: only the SECURITY DEFINER function writes here.

-- -----------------------------------------------------------------------------
-- 3. The grant/revoke entry point
--    Guards, in order:
--      * caller must already be an admin
--      * the target has to exist
--      * nobody demotes themselves, which is the easy way to lock the last
--        admin out of the panel by accident
--      * the final admin cannot be removed, which is the hard way to do it
-- -----------------------------------------------------------------------------
create or replace function public.set_user_admin(
  p_user_id uuid,
  p_admin   boolean
) returns void language plpgsql security definer set search_path = public as $$
declare v_current boolean;
begin
  if not exists (select 1 from public.profiles where id = auth.uid() and is_platform_admin) then
    raise exception 'not authorised';
  end if;

  select is_platform_admin into v_current from public.profiles where id = p_user_id;
  if v_current is null then
    raise exception 'no such user';
  end if;

  if p_user_id = auth.uid() and not p_admin then
    raise exception 'you cannot remove your own admin access';
  end if;

  -- Already in the requested state: nothing to do, and no audit noise.
  if v_current = p_admin then
    return;
  end if;

  if not p_admin
     and (select count(*) from public.profiles where is_platform_admin) <= 1 then
    raise exception 'there must be at least one admin';
  end if;

  -- Unlocks the trigger for this statement only.
  perform set_config('nexchat.admin_grant', 'on', true);
  update public.profiles set is_platform_admin = p_admin where id = p_user_id;
  perform set_config('nexchat.admin_grant', 'off', true);

  insert into public.admin_grants (user_id, granted, actor_id)
  values (p_user_id, p_admin, auth.uid());
end;
$$;

revoke all on function public.set_user_admin(uuid, boolean) from public;
grant execute on function public.set_user_admin(uuid, boolean) to authenticated;

-- -----------------------------------------------------------------------------
-- Verification
--   Runs last, so it only reports if the whole file arrived. If this query does
--   not appear in the results, the paste was truncated and the patch should be
--   re-run from the top.
-- -----------------------------------------------------------------------------
select
  to_regproc('public.set_user_admin(uuid,boolean)')  is not null as set_user_admin_fn,
  to_regclass('public.admin_grants')                 is not null as audit_table,
  exists (select 1 from pg_trigger
           where tgname = 'trg_guard_platform_admin'
             and tgrelid = 'public.profiles'::regclass)          as escalation_guard,
  (select count(*) from public.profiles where is_platform_admin) as current_admins;
