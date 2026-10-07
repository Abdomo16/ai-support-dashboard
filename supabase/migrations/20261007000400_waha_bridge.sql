-- Links the dashboard to the self-hosted WhatsApp stack (WAHA + n8n on the VM).
-- n8n writes inbound/AI messages directly; agent replies are queued here (delivery_status = 'queued')
-- and n8n's outbox workflow sends them through WAHA, so the VM never has to be reachable from outside.

-- ---------------------------------------------------------------------------
-- WhatsApp accounts served by WAHA
-- ---------------------------------------------------------------------------
alter table public.whatsapp_accounts
  add column if not exists provider text not null default 'meta' check (provider in ('meta', 'waha')),
  add column if not exists session text,
  add column if not exists qr_code text,
  add column if not exists status_detail text,
  add column if not exists status_checked_at timestamptz;

create index if not exists messages_outbox_idx on public.messages(sent_at) where delivery_status = 'queued';

-- ---------------------------------------------------------------------------
-- Carry over n8n-era data
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.organization_members') is not null then
    insert into public.profiles (id, email, full_name)
    select u.id, u.email, coalesce(m.full_name, u.raw_user_meta_data ->> 'full_name')
      from public.organization_members m join auth.users u on u.id = m.user_id
    on conflict (id) do nothing;
    insert into public.org_members (org_id, user_id, role)
    select m.org_id, m.user_id, case m.role::text when 'owner' then 'owner' when 'admin' then 'admin' else 'agent' end
      from public.organization_members m join public.profiles p on p.id = m.user_id
     where m.is_active
    on conflict (org_id, user_id) do nothing;
  end if;

  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'messages' and column_name = 'channel_message_id') then
    update public.messages set wa_message_id = channel_message_id where wa_message_id is null and channel_message_id is not null;
  end if;

  -- Weekly working hours lived in the availability table; the dashboard keeps them on team_members.
  if to_regclass('public.availability') is not null then
    update public.team_members tm set availability = hours.availability
      from (
        select team_member_id, jsonb_object_agg(day, ranges) as availability
          from (
            select team_member_id,
                   (array['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'])[day_of_week + 1] as day,
                   jsonb_agg(jsonb_build_object('start', to_char(start_time, 'HH24:MI'), 'end', to_char(end_time, 'HH24:MI')) order by start_time) as ranges
              from public.availability
             where specific_date is null and is_available and team_member_id is not null
             group by team_member_id, day_of_week
          ) per_day
         group by team_member_id
      ) hours
     where tm.id = hours.team_member_id and tm.availability = '{}'::jsonb;
  end if;
end $$;

-- Organizations that were already answering customers before the dashboard existed.
insert into public.ai_settings (org_id, is_live)
select o.id, exists (select 1 from public.conversations c where c.org_id = o.id) from public.organizations o
on conflict (org_id) do nothing;
insert into public.subscriptions (org_id) select id from public.organizations on conflict (org_id) do nothing;
update public.organizations o set onboarding_completed = true, onboarding_step = 'done'
 where not o.onboarding_completed and exists (select 1 from public.conversations c where c.org_id = o.id);

-- ---------------------------------------------------------------------------
-- RLS for the remaining n8n-era tables (read-only for members; n8n uses the owner role)
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  for t in select c.table_name
             from information_schema.columns c
             join information_schema.tables tb on tb.table_schema = c.table_schema and tb.table_name = c.table_name
            where c.table_schema = 'public' and c.column_name = 'org_id' and tb.table_type = 'BASE TABLE'
              and not exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = c.table_name)
              and c.table_name not in ('integration_secrets')
  loop
    perform public.apply_tenant_policies(t, null, null);
  end loop;
end $$;

alter table if exists public.organization_members enable row level security;
