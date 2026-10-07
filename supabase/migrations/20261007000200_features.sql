-- Feature tables: AI, knowledge (RAG), WhatsApp, growth, commerce, billing and platform.
create schema if not exists extensions;
create extension if not exists vector with schema extensions;

-- ---------------------------------------------------------------------------
-- AI agent
-- ---------------------------------------------------------------------------
create table if not exists public.ai_settings (
  org_id uuid primary key references public.organizations(id) on delete cascade,
  is_live boolean not null default false,
  persona_name text not null default 'Nova',
  tone text not null default 'friendly',
  languages text[] not null default '{en,ar}',
  dialect text not null default 'auto',
  system_prompt text not null default '',
  fallback_message text not null default 'Thanks for your message! A member of our team will get back to you shortly.',
  after_hours_mode text not null default 'ai_continues' check (after_hours_mode in ('ai_continues', 'away_message', 'handoff')),
  after_hours_message text not null default 'We are currently closed. We will reply as soon as we are back.',
  blocked_topics text[] not null default '{}',
  model text not null default 'gpt-4o-mini',
  temperature numeric not null default 0.3,
  confidence_threshold numeric not null default 0.55,
  handoff_keywords text[] not null default '{human,agent,manager,موظف,انسان,مدير}',
  handoff_on_negative_sentiment boolean not null default true,
  handoff_on_low_confidence boolean not null default true,
  handoff_on_human_request boolean not null default true,
  vip_tags text[] not null default '{vip}',
  sla_minutes int not null default 15,
  csat_enabled boolean not null default true,
  tools_enabled text[] not null default '{bookings,orders,payments,handoff}',
  updated_at timestamptz not null default now()
);

create table if not exists public.ai_events (
  id bigserial primary key,
  org_id uuid references public.organizations(id) on delete cascade,
  conversation_id uuid references public.conversations(id) on delete set null,
  kind text not null,
  latency_ms int,
  tokens_in int not null default 0,
  tokens_out int not null default 0,
  cost_usd numeric not null default 0,
  error text,
  created_at timestamptz not null default now()
);
create index if not exists ai_events_org_created_idx on public.ai_events(org_id, created_at desc);

create table if not exists public.canned_responses (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  shortcut text not null,
  title text not null,
  body text not null,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (org_id, shortcut)
);

-- ---------------------------------------------------------------------------
-- Knowledge (RAG)
-- ---------------------------------------------------------------------------
create table if not exists public.kb_documents (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  title text not null,
  source_type text not null check (source_type in ('file', 'url', 'text')),
  source_url text,
  storage_path text,
  raw_text text,
  status text not null default 'pending' check (status in ('pending', 'processing', 'ready', 'failed')),
  error text,
  chunk_count int not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.kb_chunks (
  id bigserial primary key,
  org_id uuid not null references public.organizations(id) on delete cascade,
  document_id uuid references public.kb_documents(id) on delete cascade,
  article_id uuid references public.knowledge_base_articles(id) on delete cascade,
  content text not null,
  embedding extensions.vector(1536),
  created_at timestamptz not null default now()
);
create index if not exists kb_chunks_org_idx on public.kb_chunks(org_id);
create index if not exists kb_chunks_embedding_idx on public.kb_chunks using hnsw (embedding extensions.vector_cosine_ops);

create table if not exists public.unanswered_questions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  conversation_id uuid references public.conversations(id) on delete set null,
  question text not null,
  occurrences int not null default 1,
  status text not null default 'open' check (status in ('open', 'resolved', 'ignored')),
  article_id uuid references public.knowledge_base_articles(id) on delete set null,
  created_at timestamptz not null default now(),
  last_asked_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- WhatsApp and integrations
-- ---------------------------------------------------------------------------
create table if not exists public.whatsapp_accounts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  phone_number_id text not null unique,
  waba_id text,
  display_phone text,
  verified_name text,
  status text not null default 'connected' check (status in ('connected', 'disconnected', 'error')),
  last_webhook_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.integrations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  provider text not null,
  status text not null default 'connected' check (status in ('connected', 'disconnected', 'error')),
  config jsonb not null default '{}'::jsonb,
  error text,
  connected_at timestamptz not null default now(),
  last_sync_at timestamptz,
  unique (org_id, provider)
);

-- Secrets are never readable from the browser; only the service role and set_integration_secret() touch them.
create table if not exists public.integration_secrets (
  org_id uuid not null references public.organizations(id) on delete cascade,
  provider text not null,
  secret jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (org_id, provider)
);

create table if not exists public.whatsapp_templates (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  category text not null default 'MARKETING' check (category in ('MARKETING', 'UTILITY', 'AUTHENTICATION')),
  language text not null default 'en',
  header_text text,
  body text not null,
  footer text,
  buttons jsonb not null default '[]'::jsonb,
  status text not null default 'draft' check (status in ('draft', 'pending', 'approved', 'rejected', 'paused', 'disabled')),
  meta_template_id text,
  rejection_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, name, language)
);

-- ---------------------------------------------------------------------------
-- Growth
-- ---------------------------------------------------------------------------
create table if not exists public.broadcasts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  template_id uuid references public.whatsapp_templates(id) on delete set null,
  segment jsonb not null default '{"tags": [], "opted_in_only": true}'::jsonb,
  variables jsonb not null default '[]'::jsonb,
  status text not null default 'draft' check (status in ('draft', 'scheduled', 'sending', 'sent', 'failed')),
  scheduled_at timestamptz,
  sent_at timestamptz,
  total int not null default 0,
  sent int not null default 0,
  delivered int not null default 0,
  read int not null default 0,
  replied int not null default 0,
  failed int not null default 0,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.broadcast_recipients (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  broadcast_id uuid not null references public.broadcasts(id) on delete cascade,
  customer_id uuid references public.customers(id) on delete cascade,
  wa_message_id text,
  status text not null default 'queued' check (status in ('queued', 'sent', 'delivered', 'read', 'replied', 'failed', 'skipped')),
  error text,
  updated_at timestamptz not null default now(),
  unique (broadcast_id, customer_id)
);
create index if not exists broadcast_recipients_wa_idx on public.broadcast_recipients(wa_message_id);

create table if not exists public.automations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  trigger text not null check (trigger in ('no_reply_24h', 'booking_created', 'booking_completed', 'inquiry_abandoned', 'birthday', 'new_customer', 'conversation_resolved')),
  conditions jsonb not null default '{}'::jsonb,
  actions jsonb not null default '[]'::jsonb,
  delay_minutes int not null default 0,
  is_active boolean not null default true,
  run_count int not null default 0,
  last_run_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.automation_runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  automation_id uuid not null references public.automations(id) on delete cascade,
  dedupe_key text not null,
  customer_id uuid references public.customers(id) on delete set null,
  status text not null default 'done',
  error text,
  created_at timestamptz not null default now(),
  unique (automation_id, dedupe_key)
);

create table if not exists public.csat_responses (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  conversation_id uuid references public.conversations(id) on delete cascade,
  customer_id uuid references public.customers(id) on delete set null,
  score smallint not null check (score between 1 and 5),
  comment text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Commerce
-- ---------------------------------------------------------------------------
create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  description text,
  price numeric not null default 0,
  currency text not null default 'USD',
  sku text,
  image_url text,
  stock int,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  customer_id uuid references public.customers(id) on delete set null,
  conversation_id uuid references public.conversations(id) on delete set null,
  items jsonb not null default '[]'::jsonb,
  total numeric not null default 0,
  currency text not null default 'USD',
  status text not null default 'pending' check (status in ('pending', 'paid', 'fulfilled', 'cancelled', 'refunded')),
  payment_provider text,
  payment_link text,
  payment_ref text,
  external_id text,
  created_by_ai boolean not null default false,
  paid_at timestamptz,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Billing and platform
-- ---------------------------------------------------------------------------
create table if not exists public.plans (
  id text primary key,
  name text not null,
  price_monthly numeric not null default 0,
  currency text not null default 'USD',
  limits jsonb not null,
  stripe_price_id text,
  is_public boolean not null default true,
  sort int not null default 0
);

insert into public.plans (id, name, price_monthly, limits, sort) values
  ('trial', 'Trial', 0, '{"conversations": 100, "ai_messages": 500, "seats": 2, "numbers": 1}', 0),
  ('starter', 'Starter', 49, '{"conversations": 1000, "ai_messages": 5000, "seats": 3, "numbers": 1}', 1),
  ('growth', 'Growth', 149, '{"conversations": 5000, "ai_messages": 25000, "seats": 10, "numbers": 3}', 2),
  ('scale', 'Scale', 399, '{"conversations": 20000, "ai_messages": 100000, "seats": 30, "numbers": 10}', 3)
on conflict (id) do nothing;

create table if not exists public.subscriptions (
  org_id uuid primary key references public.organizations(id) on delete cascade,
  plan_id text not null references public.plans(id) default 'trial',
  status text not null default 'trialing' check (status in ('trialing', 'active', 'past_due', 'canceled')),
  stripe_customer_id text,
  stripe_subscription_id text,
  current_period_end timestamptz,
  trial_ends_at timestamptz default (now() + interval '14 days'),
  updated_at timestamptz not null default now()
);

create table if not exists public.usage_counters (
  org_id uuid not null references public.organizations(id) on delete cascade,
  period date not null,
  conversations int not null default 0,
  ai_messages int not null default 0,
  messages_sent int not null default 0,
  ai_tokens bigint not null default 0,
  ai_cost_usd numeric not null default 0,
  wa_cost_usd numeric not null default 0,
  alerted_at timestamptz,
  primary key (org_id, period)
);

create table if not exists public.audit_log (
  id bigserial primary key,
  org_id uuid references public.organizations(id) on delete cascade,
  actor_id uuid references public.profiles(id) on delete set null,
  action text not null,
  entity text not null,
  entity_id text,
  details jsonb,
  created_at timestamptz not null default now()
);
create index if not exists audit_log_org_idx on public.audit_log(org_id, created_at desc);

create table if not exists public.api_keys (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  prefix text not null,
  key_hash text not null unique,
  created_by uuid references public.profiles(id) on delete set null,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- RLS for feature tables
-- ---------------------------------------------------------------------------
select public.apply_tenant_policies(t, array['owner', 'admin', 'agent'], array['owner', 'admin'])
  from unnest(array['canned_responses', 'kb_documents', 'unanswered_questions', 'orders', 'csat_responses']) as t;
select public.apply_tenant_policies(t, array['owner', 'admin'], array['owner', 'admin'])
  from unnest(array['ai_settings', 'whatsapp_templates', 'broadcasts', 'automations', 'products', 'integrations', 'whatsapp_accounts']) as t;
select public.apply_tenant_policies(t, null, null)
  from unnest(array['ai_events', 'kb_chunks', 'broadcast_recipients', 'automation_runs', 'subscriptions', 'usage_counters', 'api_keys']) as t;

alter table public.api_keys enable row level security;
drop policy if exists tenant_update on public.api_keys;
create policy tenant_update on public.api_keys for update to authenticated
  using (public.has_org_role(org_id, array['owner', 'admin'])) with check (public.has_org_role(org_id, array['owner', 'admin']));

alter table public.audit_log enable row level security;
drop policy if exists audit_select on public.audit_log;
create policy audit_select on public.audit_log for select to authenticated using (public.has_org_role(org_id, array['owner', 'admin']));

alter table public.integration_secrets enable row level security;

alter table public.plans enable row level security;
drop policy if exists plans_select on public.plans;
create policy plans_select on public.plans for select to authenticated using (true);
