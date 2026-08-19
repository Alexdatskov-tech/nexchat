-- =============================================================================
-- NEXCHAT - PATCH 3 (DMs, friends, role icons, attachment ordering)
-- Run once in Supabase -> SQL Editor. Safe to re-run.
-- Run nexchat_rls_fix.sql first if you haven't.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. New columns
-- -----------------------------------------------------------------------------
alter table public.roles                  add column if not exists icon_url text;
alter table public.message_attachments    add column if not exists position integer not null default 0;
alter table public.dm_message_attachments add column if not exists position integer not null default 0;

-- Attachments must render in the exact order they were sent, not grouped by type.
create index if not exists idx_msg_att_order    on public.message_attachments(message_id, position);
create index if not exists idx_dm_msg_att_order on public.dm_message_attachments(message_id, position);

-- -----------------------------------------------------------------------------
-- 2. Non-recursive DM participation helper
--    The old dm_participants policy queried dm_participants from inside its own
--    policy, which is an infinite recursion loop. SECURITY DEFINER breaks it.
-- -----------------------------------------------------------------------------
create or replace function public.is_dm_participant(p_conv uuid, p_user uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.dm_participants
    where conversation_id = p_conv and user_id = p_user
  );
$$;

drop policy if exists "dm_participants_select" on public.dm_participants;
create policy "dm_participants_select" on public.dm_participants for select
  using (public.is_dm_participant(conversation_id, auth.uid()));

drop policy if exists "dm_participants_insert" on public.dm_participants;
create policy "dm_participants_insert" on public.dm_participants for insert
  with check (
    user_id = auth.uid()
    or public.is_dm_participant(conversation_id, auth.uid())
  );

drop policy if exists "dm_participants_delete" on public.dm_participants;
create policy "dm_participants_delete" on public.dm_participants for delete
  using (
    user_id = auth.uid()
    or exists (select 1 from public.dm_participants p
               where p.conversation_id = dm_participants.conversation_id
                 and p.user_id = auth.uid() and p.is_admin)
  );

drop policy if exists "dm_conv_select_participant" on public.dm_conversations;
create policy "dm_conv_select_participant" on public.dm_conversations for select
  using (public.is_dm_participant(id, auth.uid()));

drop policy if exists "dm_conv_update_admin" on public.dm_conversations;
create policy "dm_conv_update_admin" on public.dm_conversations for update
  using (public.is_dm_participant(id, auth.uid()))
  with check (public.is_dm_participant(id, auth.uid()));

drop policy if exists "dm_messages_select" on public.dm_messages;
create policy "dm_messages_select" on public.dm_messages for select
  using (public.is_dm_participant(conversation_id, auth.uid()));

drop policy if exists "dm_messages_insert" on public.dm_messages;
create policy "dm_messages_insert" on public.dm_messages for insert
  with check (author_id = auth.uid() and public.is_dm_participant(conversation_id, auth.uid()));

drop policy if exists "dm_attachments_select" on public.dm_message_attachments;
create policy "dm_attachments_select" on public.dm_message_attachments for select
  using (exists (select 1 from public.dm_messages m
                 where m.id = dm_message_attachments.message_id
                   and public.is_dm_participant(m.conversation_id, auth.uid())));

drop policy if exists "dm_reactions_select" on public.dm_message_reactions;
create policy "dm_reactions_select" on public.dm_message_reactions for select
  using (exists (select 1 from public.dm_messages m
                 where m.id = dm_message_reactions.message_id
                   and public.is_dm_participant(m.conversation_id, auth.uid())));

-- -----------------------------------------------------------------------------
-- 3. Open (or reuse) a 1:1 DM with someone
-- -----------------------------------------------------------------------------
create or replace function public.open_dm(p_other uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
  v_me uuid := auth.uid();
begin
  if v_me is null then raise exception 'not signed in'; end if;
  if v_me = p_other then raise exception 'cannot DM yourself'; end if;

  if exists (select 1 from public.blocked_users
             where (user_id = p_other and blocked_id = v_me)
                or (user_id = v_me and blocked_id = p_other)) then
    raise exception 'cannot message this person';
  end if;

  -- Reuse the existing 1:1 thread if there already is one.
  select c.id into v_id
  from public.dm_conversations c
  join public.dm_participants a on a.conversation_id = c.id and a.user_id = v_me
  join public.dm_participants b on b.conversation_id = c.id and b.user_id = p_other
  where c.is_group = false
  limit 1;

  if v_id is not null then return v_id; end if;

  insert into public.dm_conversations (is_group, created_by) values (false, v_me) returning id into v_id;
  insert into public.dm_participants (conversation_id, user_id, is_admin)
  values (v_id, v_me, true), (v_id, p_other, true);

  return v_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- 4. Create a group chat
-- -----------------------------------------------------------------------------
create or replace function public.create_group_dm(p_name text, p_members uuid[])
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
  v_me uuid := auth.uid();
  v_u  uuid;
begin
  if v_me is null then raise exception 'not signed in'; end if;

  insert into public.dm_conversations (is_group, name, created_by)
  values (true, coalesce(nullif(trim(p_name), ''), 'Group chat'), v_me)
  returning id into v_id;

  insert into public.dm_participants (conversation_id, user_id, is_admin) values (v_id, v_me, true);

  foreach v_u in array p_members loop
    if v_u <> v_me then
      insert into public.dm_participants (conversation_id, user_id)
      values (v_id, v_u) on conflict do nothing;
    end if;
  end loop;

  return v_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- 5. Friend requests
-- -----------------------------------------------------------------------------
create or replace function public.send_friend_request(p_username text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_them uuid;
begin
  select id into v_them from public.profiles where lower(username) = lower(trim(p_username));
  if v_them is null then raise exception 'No one goes by that username.'; end if;
  if v_them = v_me then raise exception 'You can''t add yourself.'; end if;

  if exists (select 1 from public.blocked_users
             where (user_id = v_them and blocked_id = v_me) or (user_id = v_me and blocked_id = v_them)) then
    raise exception 'You can''t add this person.';
  end if;

  -- If they already asked you, accept instead of creating a duplicate.
  if exists (select 1 from public.friendships where user_id = v_them and friend_id = v_me and status = 'pending') then
    update public.friendships set status = 'accepted' where user_id = v_them and friend_id = v_me;
    insert into public.friendships (user_id, friend_id, status)
    values (v_me, v_them, 'accepted')
    on conflict (user_id, friend_id) do update set status = 'accepted';
    return v_them;
  end if;

  insert into public.friendships (user_id, friend_id, status)
  values (v_me, v_them, 'pending')
  on conflict (user_id, friend_id) do nothing;

  return v_them;
end;
$$;

create or replace function public.accept_friend_request(p_from uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_me uuid := auth.uid();
begin
  update public.friendships set status = 'accepted'
  where user_id = p_from and friend_id = v_me and status = 'pending';

  insert into public.friendships (user_id, friend_id, status)
  values (v_me, p_from, 'accepted')
  on conflict (user_id, friend_id) do update set status = 'accepted';
end;
$$;

create or replace function public.remove_friend(p_other uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_me uuid := auth.uid();
begin
  delete from public.friendships
  where (user_id = v_me and friend_id = p_other) or (user_id = p_other and friend_id = v_me);
end;
$$;

-- Friend rows are readable by either side; helpers above handle the writes.
drop policy if exists "friendships_select" on public.friendships;
create policy "friendships_select" on public.friendships for select
  using (user_id = auth.uid() or friend_id = auth.uid());

-- -----------------------------------------------------------------------------
-- 6. Realtime for DMs
-- -----------------------------------------------------------------------------
do $$ begin alter publication supabase_realtime add table public.dm_participants; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.friendships; exception when duplicate_object then null; end $$;

-- =============================================================================
-- Done.
-- =============================================================================
