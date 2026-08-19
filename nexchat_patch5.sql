-- =============================================================================
-- NEXCHAT — PATCH 5
-- Publishes the reaction tables to Realtime so reactions appear for everyone
-- instantly, instead of only after a refresh.
--
-- Why this is needed: the client already subscribes to INSERT/DELETE on
-- message_reactions, but a table that is not in the supabase_realtime
-- publication never emits those events -- the channel still reports
-- SUBSCRIBED, it is simply silent. Reactions therefore only showed up on
-- a page reload.
--
-- `replica identity full` matters specifically for DELETE: without it the
-- payload carries only the primary key, so the client cannot tell which
-- emoji or which user was removed and can't un-paint the right bubble.
--
-- Run once in Supabase -> SQL Editor. Safe to re-run.
-- =============================================================================

do $$ begin alter publication supabase_realtime add table public.message_reactions; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.dm_message_reactions; exception when duplicate_object then null; end $$;

alter table public.message_reactions    replica identity full;
alter table public.dm_message_reactions replica identity full;
