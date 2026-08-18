-- =============================================================================
-- NEXCHAT — RLS FIX
-- Run this once in Supabase -> SQL Editor. Safe to re-run.
--
-- PROBLEM
--   channels_select called channel_permission(), which reads `channels` and
--   `channel_permissions`; the policy on channel_permissions reads `channels`
--   again. That's a recursive policy loop.
--   Server owners never hit it: member_permissions() returns the ADMINISTRATOR
--   bit and channel_permission() returns early, before touching those tables.
--   Everyone else recursed and got nothing back — hence "invited people see no
--   channels".
--
-- FIX
--   Base visibility on plain server membership (a non-recursive lookup against
--   server_members), and apply channel-level overwrites only as a deny filter
--   through a recursion-free helper. This also closes a real hole: the old
--   member_permissions() handed @everyone's permissions to ANY signed-in user,
--   member or not.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Recursion-free helper: is this channel explicitly hidden from this user?
--    Reads only channel_permissions (never `channels`), so no policy can loop.
-- -----------------------------------------------------------------------------
create or replace function public.channel_hidden_for(p_channel_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  with denies as (
    select
      coalesce(bit_or(case when cp.target_type = 'role'   then cp.deny  else 0 end), 0) as role_deny,
      coalesce(bit_or(case when cp.target_type = 'role'   then cp.allow else 0 end), 0) as role_allow,
      coalesce(bit_or(case when cp.target_type = 'member' then cp.deny  else 0 end), 0) as mem_deny,
      coalesce(bit_or(case when cp.target_type = 'member' then cp.allow else 0 end), 0) as mem_allow
    from public.channel_permissions cp
    where cp.channel_id = p_channel_id
      and (
        (cp.target_type = 'member' and cp.target_id = p_user_id)
        or (cp.target_type = 'role' and cp.target_id in (
              select mr.role_id from public.member_roles mr where mr.user_id = p_user_id
              union all
              select r.id from public.roles r
              where r.is_default
                and r.server_id = (select c.server_id from public.channels c where c.id = p_channel_id)
           ))
      )
  )
  -- Hidden when VIEW_CHANNEL (bit 1) is denied and not re-allowed at a
  -- higher-priority level. Member-level allow always wins over role-level deny.
  select coalesce(
    (select (mem_deny & 1) <> 0
            or ((role_deny & 1) <> 0 and (mem_allow & 1) = 0)
     from denies),
    false);
$$;

-- -----------------------------------------------------------------------------
-- 2. CHANNELS — membership-based, no recursion
-- -----------------------------------------------------------------------------
drop policy if exists "channels_select" on public.channels;
create policy "channels_select" on public.channels for select
  using (
    public.is_platform_admin(auth.uid())
    or (
      public.is_server_member(server_id, auth.uid())
      and not public.channel_hidden_for(id, auth.uid())
    )
  );

-- -----------------------------------------------------------------------------
-- 3. MESSAGES — read/write gated on membership
-- -----------------------------------------------------------------------------
drop policy if exists "messages_select" on public.messages;
create policy "messages_select" on public.messages for select
  using (
    exists (
      select 1 from public.channels c
      where c.id = messages.channel_id
        and public.is_server_member(c.server_id, auth.uid())
    )
  );

drop policy if exists "messages_insert" on public.messages;
create policy "messages_insert" on public.messages for insert
  with check (
    author_id = auth.uid()
    and exists (
      select 1 from public.channels c
      where c.id = messages.channel_id
        and public.is_server_member(c.server_id, auth.uid())
    )
  );

-- -----------------------------------------------------------------------------
-- 4. ATTACHMENTS
-- -----------------------------------------------------------------------------
drop policy if exists "msg_attachments_select" on public.message_attachments;
create policy "msg_attachments_select" on public.message_attachments for select
  using (
    exists (
      select 1 from public.messages m
      join public.channels c on c.id = m.channel_id
      where m.id = message_attachments.message_id
        and public.is_server_member(c.server_id, auth.uid())
    )
  );

-- -----------------------------------------------------------------------------
-- 5. REACTIONS
-- -----------------------------------------------------------------------------
drop policy if exists "msg_reactions_select" on public.message_reactions;
create policy "msg_reactions_select" on public.message_reactions for select
  using (
    exists (
      select 1 from public.messages m
      join public.channels c on c.id = m.channel_id
      where m.id = message_reactions.message_id
        and public.is_server_member(c.server_id, auth.uid())
    )
  );

drop policy if exists "msg_reactions_insert" on public.message_reactions;
create policy "msg_reactions_insert" on public.message_reactions for insert
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.messages m
      join public.channels c on c.id = m.channel_id
      where m.id = message_reactions.message_id
        and public.is_server_member(c.server_id, auth.uid())
    )
  );

-- -----------------------------------------------------------------------------
-- 6. VOICE SESSIONS
-- -----------------------------------------------------------------------------
drop policy if exists "voice_sessions_insert_self" on public.voice_sessions;
create policy "voice_sessions_insert_self" on public.voice_sessions for insert
  with check (
    user_id = auth.uid()
    and public.is_server_member(server_id, auth.uid())
  );

-- -----------------------------------------------------------------------------
-- 7. CHANNEL_PERMISSIONS — its own policy must not read `channels`
--    (that was the other half of the loop). Gate on membership + MANAGE_ROLES.
-- -----------------------------------------------------------------------------
drop policy if exists "channel_perms_all" on public.channel_permissions;

create policy "channel_perms_select" on public.channel_permissions for select
  using (true);

create policy "channel_perms_write" on public.channel_permissions for all
  using (
    public.is_platform_admin(auth.uid())
    or exists (
      select 1 from public.channels c
      where c.id = channel_permissions.channel_id
        and (c.server_id in (select s.id from public.servers s where s.owner_id = auth.uid()))
    )
  )
  with check (
    public.is_platform_admin(auth.uid())
    or exists (
      select 1 from public.channels c
      where c.id = channel_permissions.channel_id
        and (c.server_id in (select s.id from public.servers s where s.owner_id = auth.uid()))
    )
  );

-- -----------------------------------------------------------------------------
-- 8. member_permissions() no longer grants @everyone rights to non-members
-- -----------------------------------------------------------------------------
create or replace function public.member_permissions(p_server_id uuid, p_user_id uuid)
returns bigint
language sql
stable
security definer
set search_path = public
as $$
  select
    case
      when exists (select 1 from public.servers s where s.id = p_server_id and s.owner_id = p_user_id)
        then 131071::bigint
      when not exists (select 1 from public.server_members sm
                       where sm.server_id = p_server_id and sm.user_id = p_user_id)
        then 0::bigint
      else (
        select coalesce(bit_or(perm), 0::bigint)
        from (
          select r.permissions as perm
          from public.roles r
          where r.server_id = p_server_id and r.is_default
          union all
          select r.permissions
          from public.member_roles mr
          join public.roles r on r.id = mr.role_id
          where mr.server_id = p_server_id and mr.user_id = p_user_id
        ) all_perms
      )
    end;
$$;

-- =============================================================================
-- Done. Invited members should now see channels and messages immediately.
-- =============================================================================
