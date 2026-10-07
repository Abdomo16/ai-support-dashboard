-- Autexa multi-tenancy: organizations, members, roles, and RLS on the core support tables.
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  email text,
  avatar_url text,
  created_at timestamptz not null default now()
);

insert into public.profiles (id, email, full_name)
select id, email, raw_user_meta_data ->> 'full_name' from auth.users
on conflict (id) do nothing;

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name, avatar_url)
  values (new.id, new.email, coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'), new.raw_user_meta_data ->> 'avatar_url')
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

create table if not exists public.platform_admins (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Organizations (tenants)
-- ---------------------------------------------------------------------------
create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  industry text,
  timezone text not null default 'UTC',
  locale text not null default 'en',
  status text not null default 'active' check (status in ('active', 'suspended')),
  plan text not null default 'trial',
  parent_org_id uuid references public.organizations(id) on delete set null,
  is_agency boolean not null default false,
  brand_name text,
  logo_url text,
  brand_color text,
  custom_domain text,
  business_hours jsonb not null default '{}'::jsonb,
  settings jsonb not null default '{}'::jsonb,
  onboarding_step text not null default 'whatsapp',
  onboarding_completed boolean not null default false,
  created_at timestamptz not null default now()
);
alter table public.organizations
  add column if not exists locale text not null default 'en',
  add column if not exists status text not null default 'active' check (status in ('active', 'suspended')),
  add column if not exists plan text not null default 'trial',
  add column if not exists parent_org_id uuid references public.organizations(id) on delete set null,
  add column if not exists is_agency boolean not null default false,
  add column if not exists brand_name text,
  add column if not exists logo_url text,
  add column if not exists brand_color text,
  add column if not exists custom_domain text,
  add column if not exists business_hours jsonb not null default '{}'::jsonb,
  add column if not exists settings jsonb not null default '{}'::jsonb,
  add column if not exists onboarding_step text not null default 'whatsapp',
  add column if not exists onboarding_completed boolean not null default false;

create table if not exists public.org_members (
  org_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null default 'agent' check (role in ('owner', 'admin', 'agent', 'viewer')),
  notification_prefs jsonb not null default '{"sound": true, "browser": true, "handoffs": true}'::jsonb,
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);
create index if not exists org_members_user_idx on public.org_members(user_id);

create table if not exists public.org_invitations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  email text not null,
  role text not null default 'agent' check (role in ('owner', 'admin', 'agent', 'viewer')),
  invited_by uuid references public.profiles(id) on delete set null,
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  unique (org_id, email)
);

-- ---------------------------------------------------------------------------
-- Role helpers (security definer so policies can call them without recursion)
-- ---------------------------------------------------------------------------
create or replace function public.is_platform_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.platform_admins where user_id = auth.uid());
$$;

-- Platform admins act as owners everywhere (support impersonation); agency
-- owners/admins inherit their role in child organizations.
create or replace function public.org_role(p_org uuid) returns text
language sql stable security definer set search_path = public as $$
  select case when public.is_platform_admin() or coalesce(auth.role(), '') = 'service_role' then 'owner' else coalesce(
    (select role from public.org_members where org_id = p_org and user_id = auth.uid()),
    (select m.role from public.organizations o
       join public.org_members m on m.org_id = o.parent_org_id
      where o.id = p_org and m.user_id = auth.uid() and m.role in ('owner', 'admin'))
  ) end;
$$;

create or replace function public.is_org_member(p_org uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.org_role(p_org) is not null;
$$;

create or replace function public.has_org_role(p_org uuid, p_roles text[]) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.org_role(p_org) = any(p_roles), false);
$$;

create or replace function public.my_organizations()
returns table (id uuid, name text, role text, status text, brand_name text, logo_url text, brand_color text, parent_org_id uuid, is_agency boolean, onboarding_completed boolean)
language sql stable security definer set search_path = public as $$
  select o.id, o.name, public.org_role(o.id), o.status, o.brand_name, o.logo_url, o.brand_color, o.parent_org_id, o.is_agency, o.onboarding_completed
    from public.organizations o
   where exists (select 1 from public.org_members m where m.org_id = o.id and m.user_id = auth.uid())
      or exists (select 1 from public.org_members m where m.org_id = o.parent_org_id and m.user_id = auth.uid() and m.role in ('owner', 'admin'))
   order by o.name;
$$;

-- ---------------------------------------------------------------------------
-- Core support tables (created if missing, extended if they already exist)
-- ---------------------------------------------------------------------------
create table if not exists public.customers (id uuid primary key default gen_random_uuid());
alter table public.customers
  add column if not exists org_id uuid references public.organizations(id) on delete cascade,
  add column if not exists full_name text,
  add column if not exists phone text,
  add column if not exists email text,
  add column if not exists tags text[] not null default '{}',
  add column if not exists notes text,
  add column if not exists custom_fields jsonb not null default '{}'::jsonb,
  add column if not exists opted_in boolean not null default true,
  add column if not exists opted_out_at timestamptz,
  add column if not exists birthday date,
  add column if not exists language text,
  add column if not exists last_seen_at timestamptz,
  add column if not exists created_at timestamptz not null default now();
create index if not exists customers_org_phone_idx on public.customers(org_id, phone);

create table if not exists public.conversations (id uuid primary key default gen_random_uuid());
alter table public.conversations
  add column if not exists org_id uuid references public.organizations(id) on delete cascade,
  add column if not exists customer_id uuid references public.customers(id) on delete cascade,
  add column if not exists status text not null default 'open',
  add column if not exists is_ai_handled boolean not null default true,
  add column if not exists ai_paused boolean not null default false,
  add column if not exists assigned_to uuid references public.profiles(id) on delete set null,
  add column if not exists last_message_at timestamptz,
  add column if not exists last_message_preview text,
  add column if not exists last_inbound_at timestamptz,
  add column if not exists first_response_at timestamptz,
  add column if not exists summary text,
  add column if not exists intent text,
  add column if not exists sentiment text,
  add column if not exists ai_confidence numeric,
  add column if not exists resolved_at timestamptz,
  add column if not exists csat_requested_at timestamptz,
  add column if not exists created_at timestamptz not null default now();
create index if not exists conversations_org_last_idx on public.conversations(org_id, last_message_at desc);
create index if not exists conversations_customer_idx on public.conversations(customer_id);

create table if not exists public.messages (id uuid primary key default gen_random_uuid());
alter table public.messages
  add column if not exists org_id uuid references public.organizations(id) on delete cascade,
  add column if not exists conversation_id uuid references public.conversations(id) on delete cascade,
  add column if not exists content text,
  add column if not exists sent_at timestamptz not null default now(),
  add column if not exists direction text not null default 'inbound',
  add column if not exists is_ai_generated boolean not null default false,
  add column if not exists sender_type text,
  add column if not exists sent_by uuid references public.profiles(id) on delete set null,
  add column if not exists is_internal_note boolean not null default false,
  add column if not exists message_type text not null default 'text',
  add column if not exists media_path text,
  add column if not exists media_mime text,
  add column if not exists payload jsonb,
  add column if not exists wa_message_id text,
  add column if not exists delivery_status text,
  add column if not exists ai_confidence numeric,
  add column if not exists feedback smallint,
  add column if not exists feedback_note text;
create index if not exists messages_conversation_idx on public.messages(conversation_id, sent_at);
create index if not exists messages_org_sent_idx on public.messages(org_id, sent_at);
create index if not exists messages_wa_idx on public.messages(wa_message_id);

create table if not exists public.services (id uuid primary key default gen_random_uuid());
alter table public.services
  add column if not exists org_id uuid references public.organizations(id) on delete cascade,
  add column if not exists name text,
  add column if not exists description text,
  add column if not exists duration_minutes int not null default 30,
  add column if not exists price numeric,
  add column if not exists currency text not null default 'USD',
  add column if not exists is_active boolean not null default true,
  add column if not exists created_at timestamptz not null default now();

create table if not exists public.team_members (id uuid primary key default gen_random_uuid());
alter table public.team_members
  add column if not exists org_id uuid references public.organizations(id) on delete cascade,
  add column if not exists full_name text,
  add column if not exists email text,
  add column if not exists phone text,
  add column if not exists user_id uuid references public.profiles(id) on delete set null,
  add column if not exists availability jsonb not null default '{}'::jsonb,
  add column if not exists is_active boolean not null default true,
  add column if not exists created_at timestamptz not null default now();

create table if not exists public.appointments (id uuid primary key default gen_random_uuid());
alter table public.appointments
  add column if not exists org_id uuid references public.organizations(id) on delete cascade,
  add column if not exists customer_id uuid references public.customers(id) on delete cascade,
  add column if not exists service_id uuid references public.services(id) on delete set null,
  add column if not exists team_member_id uuid references public.team_members(id) on delete set null,
  add column if not exists conversation_id uuid references public.conversations(id) on delete set null,
  add column if not exists starts_at timestamptz,
  add column if not exists ends_at timestamptz,
  add column if not exists status text not null default 'scheduled',
  add column if not exists created_by_ai boolean not null default false,
  add column if not exists notes text,
  add column if not exists reminder_24h_sent_at timestamptz,
  add column if not exists reminder_1h_sent_at timestamptz,
  add column if not exists google_event_id text,
  add column if not exists google_synced_at timestamptz,
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists created_at timestamptz not null default now();
create index if not exists appointments_org_start_idx on public.appointments(org_id, starts_at);

create table if not exists public.human_handoffs (id uuid primary key default gen_random_uuid());
alter table public.human_handoffs
  add column if not exists org_id uuid references public.organizations(id) on delete cascade,
  add column if not exists conversation_id uuid references public.conversations(id) on delete cascade,
  add column if not exists status text not null default 'pending',
  add column if not exists reason text,
  add column if not exists priority text not null default 'normal',
  add column if not exists requested_at timestamptz not null default now(),
  add column if not exists claimed_by uuid references public.profiles(id) on delete set null,
  add column if not exists claimed_at timestamptz,
  add column if not exists resolved_at timestamptz;
create index if not exists handoffs_org_status_idx on public.human_handoffs(org_id, status);

create table if not exists public.knowledge_base_articles (id uuid primary key default gen_random_uuid());
alter table public.knowledge_base_articles
  add column if not exists org_id uuid references public.organizations(id) on delete cascade,
  add column if not exists question text,
  add column if not exists answer text,
  add column if not exists category text,
  add column if not exists keywords text[] not null default '{}',
  add column if not exists is_active boolean not null default true,
  add column if not exists usage_count int not null default 0,
  add column if not exists source text not null default 'manual',
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
-- Old policies on these tables may allow anonymous reads; tenancy replaces them.
do $$
declare p record;
begin
  for p in select policyname, tablename from pg_policies
            where schemaname = 'public'
              and tablename = any (array['customers', 'conversations', 'messages', 'services', 'team_members', 'appointments', 'human_handoffs', 'knowledge_base_articles'])
  loop
    execute format('drop policy %I on public.%I', p.policyname, p.tablename);
  end loop;
end $$;

create or replace function public.apply_tenant_policies(p_table text, p_write_roles text[], p_delete_roles text[])
returns void language plpgsql as $$
begin
  execute format('alter table public.%I enable row level security', p_table);
  execute format('drop policy if exists tenant_select on public.%I', p_table);
  execute format('drop policy if exists tenant_insert on public.%I', p_table);
  execute format('drop policy if exists tenant_update on public.%I', p_table);
  execute format('drop policy if exists tenant_delete on public.%I', p_table);
  execute format('create policy tenant_select on public.%I for select to authenticated using (public.is_org_member(org_id))', p_table);
  if p_write_roles is not null then
    execute format('create policy tenant_insert on public.%I for insert to authenticated with check (public.has_org_role(org_id, %L))', p_table, p_write_roles);
    execute format('create policy tenant_update on public.%I for update to authenticated using (public.has_org_role(org_id, %L)) with check (public.has_org_role(org_id, %L))', p_table, p_write_roles, p_write_roles);
  end if;
  if p_delete_roles is not null then
    execute format('create policy tenant_delete on public.%I for delete to authenticated using (public.has_org_role(org_id, %L))', p_table, p_delete_roles);
  end if;
end $$;
revoke execute on function public.apply_tenant_policies(text, text[], text[]) from public, anon, authenticated;

select public.apply_tenant_policies(t, array['owner', 'admin', 'agent'], array['owner', 'admin'])
  from unnest(array['customers', 'conversations', 'messages', 'appointments', 'human_handoffs', 'knowledge_base_articles']) as t;
select public.apply_tenant_policies(t, array['owner', 'admin'], array['owner', 'admin'])
  from unnest(array['services', 'team_members']) as t;

alter table public.profiles enable row level security;
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated using (
  id = auth.uid() or public.is_platform_admin() or exists (
    select 1 from public.org_members mine join public.org_members theirs on theirs.org_id = mine.org_id
     where mine.user_id = auth.uid() and theirs.user_id = profiles.id));
drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

alter table public.platform_admins enable row level security;
drop policy if exists platform_admins_self on public.platform_admins;
create policy platform_admins_self on public.platform_admins for select to authenticated using (user_id = auth.uid());

alter table public.organizations enable row level security;
drop policy if exists organizations_select on public.organizations;
create policy organizations_select on public.organizations for select to authenticated using (public.is_org_member(id));
drop policy if exists organizations_update on public.organizations;
create policy organizations_update on public.organizations for update to authenticated
  using (public.has_org_role(id, array['owner', 'admin'])) with check (public.has_org_role(id, array['owner', 'admin']));
drop policy if exists organizations_delete on public.organizations;
create policy organizations_delete on public.organizations for delete to authenticated using (public.has_org_role(id, array['owner']));
-- Plan, status and agency flags are only changed by billing and platform admins.
revoke update on public.organizations from authenticated;
grant update (name, industry, timezone, locale, brand_name, logo_url, brand_color, custom_domain, business_hours, settings, onboarding_step, onboarding_completed)
  on public.organizations to authenticated;

alter table public.org_members enable row level security;
drop policy if exists org_members_select on public.org_members;
create policy org_members_select on public.org_members for select to authenticated using (public.is_org_member(org_id));
drop policy if exists org_members_update_self on public.org_members;
create policy org_members_update_self on public.org_members for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
revoke update on public.org_members from authenticated;
grant update (notification_prefs) on public.org_members to authenticated;

alter table public.org_invitations enable row level security;
drop policy if exists invitations_select on public.org_invitations;
create policy invitations_select on public.org_invitations for select to authenticated using (public.has_org_role(org_id, array['owner', 'admin']));
drop policy if exists invitations_insert on public.org_invitations;
create policy invitations_insert on public.org_invitations for insert to authenticated with check (
  public.has_org_role(org_id, array['owner', 'admin']) and (role <> 'owner' or public.has_org_role(org_id, array['owner'])));
drop policy if exists invitations_delete on public.org_invitations;
create policy invitations_delete on public.org_invitations for delete to authenticated using (public.has_org_role(org_id, array['owner', 'admin']));

-- ---------------------------------------------------------------------------
-- Membership RPCs
-- ---------------------------------------------------------------------------
create or replace function public.accept_pending_invitations() returns int
language plpgsql security definer set search_path = public as $$
declare v_email text := lower(auth.jwt() ->> 'email'); v_count int;
begin
  if auth.uid() is null or v_email is null then return 0; end if;
  insert into public.org_members (org_id, user_id, role)
  select org_id, auth.uid(), role from public.org_invitations where lower(email) = v_email and accepted_at is null
  on conflict (org_id, user_id) do nothing;
  get diagnostics v_count = row_count;
  update public.org_invitations set accepted_at = now() where lower(email) = v_email and accepted_at is null;
  return v_count;
end $$;

create or replace function public.set_member_role(p_org uuid, p_user uuid, p_role text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.has_org_role(p_org, array['owner', 'admin']) then raise exception 'forbidden'; end if;
  if (p_role = 'owner' or exists (select 1 from public.org_members where org_id = p_org and user_id = p_user and role = 'owner'))
     and not public.has_org_role(p_org, array['owner']) then raise exception 'only owners can change owners'; end if;
  if p_role <> 'owner' and (select count(*) from public.org_members where org_id = p_org and role = 'owner' and user_id <> p_user) = 0 then
    raise exception 'an organization needs at least one owner';
  end if;
  update public.org_members set role = p_role where org_id = p_org and user_id = p_user;
end $$;

create or replace function public.remove_member(p_org uuid, p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_user <> auth.uid() and not public.has_org_role(p_org, array['owner', 'admin']) then raise exception 'forbidden'; end if;
  if exists (select 1 from public.org_members where org_id = p_org and user_id = p_user and role = 'owner') then
    if p_user <> auth.uid() and not public.has_org_role(p_org, array['owner']) then raise exception 'only owners can remove owners'; end if;
    if (select count(*) from public.org_members where org_id = p_org and role = 'owner') = 1 then raise exception 'an organization needs at least one owner'; end if;
  end if;
  delete from public.org_members where org_id = p_org and user_id = p_user;
end $$;

-- Assigns rows created before multi-tenancy (org_id is null) to an organization.
create or replace function public.claim_unassigned_data(p_org uuid) returns void
language plpgsql security definer set search_path = public as $$
declare t text;
begin
  if not public.is_platform_admin() then raise exception 'forbidden'; end if;
  foreach t in array array['customers', 'conversations', 'messages', 'services', 'team_members', 'appointments', 'human_handoffs', 'knowledge_base_articles'] loop
    execute format('update public.%I set org_id = $1 where org_id is null', t) using p_org;
  end loop;
end $$;
