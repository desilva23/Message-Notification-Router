-- ---------------------------------------------------------------------------
-- Message Notification Router — Supabase schema
--
-- Run once against a fresh project:
--   psql "$SUPABASE_DB_URL" -f supabase/schema.sql
-- or paste into the Supabase SQL editor.
--
-- Then seed with:  npm run db:seed
--
-- Two kinds of table live here. Reference tables mirror the challenge dataset
-- and are read-only to the application. Run tables record what the router
-- decided, so a deployed instance keeps a history of its own predictions.
--
-- Row level security is enabled on every table without exception. The anon key
-- reaches the browser, so anything reachable with it is effectively public;
-- read-only policies are granted deliberately (this is a public demonstration
-- over a synthetic dataset) and no policy anywhere grants insert, update or
-- delete to anon. Writes require the service role key, which stays server-side.
-- ---------------------------------------------------------------------------

create extension if not exists "pgcrypto";

-- --- Reference tables ------------------------------------------------------

create table if not exists public.users (
  user_id                     text primary key,
  do_not_disturb_window       text not null default '',
  messages_opened_30d         integer not null default 0,
  messages_replied_30d        integer not null default 0,
  notifications_dismissed_30d integer not null default 0,
  messages_reported_30d       integer not null default 0
);

create table if not exists public.groups (
  group_id     text primary key,
  group_name   text not null default '',
  group_type   text not null default '',
  member_count integer not null default 0,
  admin_count  integer not null default 0,
  created_at   text not null default '',
  messages_30d integer not null default 0
);

create table if not exists public.group_members (
  group_id                    text not null references public.groups (group_id) on delete cascade,
  user_id                     text not null references public.users (user_id) on delete cascade,
  role                        text not null default 'member',
  joined_at                   text not null default '',
  messages_sent_30d           integer not null default 0,
  messages_read_30d           integer not null default 0,
  replies_sent_30d            integer not null default 0,
  notifications_dismissed_30d integer not null default 0,
  group_muted_by_user         integer not null default 0,
  primary key (group_id, user_id)
);

create table if not exists public.business_accounts (
  business_id                    text primary key,
  display_name                   text not null default '',
  brand_name                     text not null default '',
  category                       text not null default '',
  verified                       integer not null default 0,
  official_domain                text not null default '',
  domain_used_by_sender          text not null default '',
  account_age_days               integer not null default 0,
  messages_sent_30d              integer not null default 0,
  user_reports_30d               integer not null default 0,
  domain_used_by_sender_age_days integer not null default 0
);

create table if not exists public.user_business_history (
  user_id                 text not null references public.users (user_id) on delete cascade,
  business_id             text not null references public.business_accounts (business_id) on delete cascade,
  why_user_knows_account  text not null default '',
  last_activity_at        text not null default '',
  allows_promotions       integer not null default 0,
  promotions_opted_out_at text not null default '',
  activity_count_180d     integer not null default 0,
  messages_opened_30d     integer not null default 0,
  messages_dismissed_30d  integer not null default 0,
  messages_replied_30d    integer not null default 0,
  last_reply_at           text not null default '',
  primary key (user_id, business_id)
);

create table if not exists public.message_history (
  message_id        text primary key,
  user_id           text not null,
  conversation_type text not null default 'personal',
  group_id          text not null default '',
  business_id       text not null default '',
  sender_user_id    text not null default '',
  created_at        text not null default '',
  message_text      text not null default '',
  media_type        text not null default '',
  media_id          text not null default '',
  forwarded_count   integer not null default 0
);

create index if not exists message_history_user_idx on public.message_history (user_id);

create table if not exists public.message_events (
  user_id                text not null,
  message_id             text not null references public.message_history (message_id) on delete cascade,
  message_opened         integer not null default 0,
  message_replied        integer not null default 0,
  reaction_time_minutes  integer,
  notification_dismissed integer not null default 0,
  muted_after_message    integer not null default 0,
  message_reported       integer not null default 0,
  primary key (user_id, message_id)
);

create table if not exists public.daily_notification_summary (
  user_id                text not null references public.users (user_id) on delete cascade,
  date                   text not null,
  notifications_sent     integer not null default 0,
  notifications_dismissed integer not null default 0,
  primary key (user_id, date)
);

create table if not exists public.messages (
  message_id        text primary key,
  user_id           text not null,
  conversation_type text not null default 'personal',
  group_id          text not null default '',
  business_id       text not null default '',
  sender_user_id    text not null default '',
  created_at        text not null default '',
  message_text      text not null default '',
  media_type        text not null default '',
  media_id          text not null default '',
  forwarded_count   integer not null default 0
);

-- OCR and transcripts derived from dataset/media. Stored as jsonb so the shape
-- can evolve with the analyser without a migration.
create table if not exists public.media_analysis (
  media_id   text primary key,
  media_kind text not null check (media_kind in ('image', 'voice')),
  analysis   jsonb not null
);

-- --- Run tables ------------------------------------------------------------

create table if not exists public.routing_runs (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  engine_version text not null default '1.0.0',
  -- Whether the optional LLM adjudicator participated in this run, so a run
  -- that used it is never silently compared against one that did not.
  adjudicator   boolean not null default false,
  message_count integer not null default 0,
  notes         text not null default ''
);

create table if not exists public.routing_predictions (
  run_id               uuid not null references public.routing_runs (id) on delete cascade,
  message_id           text not null,
  action               text not null check (action in ('notify', 'digest', 'mute')),
  message_type         text not null check (message_type in (
                         'personal', 'urgent', 'event', 'payment', 'business_update',
                         'promotion', 'greeting', 'forward', 'spam', 'scam', 'unknown')),
  reason               text not null,
  confidence           numeric(4, 3) not null check (confidence >= 0 and confidence <= 1),
  evidence_message_ids text not null default 'none',
  -- Full signal trace, so a stored prediction stays explainable after the fact.
  signals              jsonb not null default '[]'::jsonb,
  primary key (run_id, message_id)
);

create index if not exists routing_predictions_action_idx
  on public.routing_predictions (run_id, action);

-- --- Row level security ----------------------------------------------------

alter table public.users                      enable row level security;
alter table public.groups                     enable row level security;
alter table public.group_members              enable row level security;
alter table public.business_accounts          enable row level security;
alter table public.user_business_history      enable row level security;
alter table public.message_history            enable row level security;
alter table public.message_events             enable row level security;
alter table public.daily_notification_summary enable row level security;
alter table public.messages                   enable row level security;
alter table public.media_analysis             enable row level security;
alter table public.routing_runs               enable row level security;
alter table public.routing_predictions        enable row level security;

-- Read-only access for the anon key. Every policy is `for select` only —
-- there is deliberately no anon insert/update/delete policy anywhere, so a
-- leaked anon key exposes synthetic reference data and nothing more.
do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'users', 'groups', 'group_members', 'business_accounts', 'user_business_history',
    'message_history', 'message_events', 'daily_notification_summary', 'messages',
    'media_analysis', 'routing_runs', 'routing_predictions'
  ]
  loop
    execute format(
      'drop policy if exists %I on public.%I', 'anon_read_' || table_name, table_name
    );
    execute format(
      'create policy %I on public.%I for select to anon, authenticated using (true)',
      'anon_read_' || table_name, table_name
    );
  end loop;
end
$$;
