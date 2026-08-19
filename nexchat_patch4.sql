-- =============================================================================
-- NEXCHAT - PATCH 4
-- Publishes attachment tables to Realtime so files appear the instant they're
-- uploaded, instead of only after a refresh.
-- Run once in Supabase -> SQL Editor. Safe to re-run.
-- =============================================================================

do $$ begin alter publication supabase_realtime add table public.message_attachments; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.dm_message_attachments; exception when duplicate_object then null; end $$;

alter table public.message_attachments    replica identity full;
alter table public.dm_message_attachments replica identity full;
