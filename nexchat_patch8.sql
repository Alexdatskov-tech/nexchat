-- =============================================================================
-- NEXCHAT - PATCH 8
-- Account self-deletion: creates a SECURITY DEFINER function so users can
-- delete their own account and all their data from the client.
--
-- Run once in the Supabase SQL Editor. Safe to re-run.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. SECURITY DEFINER function that deletes the calling user's auth.users row.
--    CASCADE handles all referencing data in public tables (profiles, servers,
--    messages, DMs, friendships, ban_appeals, admin_grants, etc.).
--
--    The function runs as its owner (supabase_admin / database superuser), so
--    it has DELETE access on auth.users in the auth schema.
--
--    We guard it with auth.uid() so one user cannot delete another.
-- -----------------------------------------------------------------------------
create or replace function public.delete_my_account()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid;
begin
  v_uid := auth.uid();
  if v_uid is null then
    raise exception 'not signed in';
  end if;

  -- Attempt to delete the user from auth.users. The CASCADE foreign-key
  -- relationships on public.profiles and all the referencing tables handle
  -- cleaning up every piece of user data.
  delete from auth.users where id = v_uid;

  -- If the delete failed (e.g. another concurrent session already did it),
  -- that is fine -- there is nothing left to do.
end;
$$;

-- Only authenticated users may invoke this function.
revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;

-- -----------------------------------------------------------------------------
-- Verification
--   Runs last, so it only reports if the whole file arrived. If this query
--   does not appear in the results, the paste was truncated.
-- -----------------------------------------------------------------------------
select
  to_regproc('public.delete_my_account()') is not null as delete_fn_created;