-- Triggers, RPCs (onboarding, analytics, search, health, billing, admin), realtime and storage.

-- ---------------------------------------------------------------------------
-- Organization lifecycle
-- ---------------------------------------------------------------------------
create or replace function public.create_organization(p_name text, p_industry text default null, p_timezone text default 'UTC', p_locale text default 'en', p_parent uuid default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if p_parent is not null and not (public.has_org_role(p_parent, array['owner', 'admin'])
     and coalesce((select is_agency from public.organizations where id = p_parent), false)) then
    raise exception 'only agency admins can create client workspaces';
  end if;
  insert into public.organizations (name, industry, timezone, locale, parent_org_id)
  values (p_name, p_industry, coalesce(p_timezone, 'UTC'), coalesce(p_locale, 'en'), p_parent) returning id into v_id;
  insert into public.org_members (org_id, user_id, role) values (v_id, auth.uid(), 'owner');
  insert into public.ai_settings (org_id) values (v_id);
  insert into public.subscriptions (org_id) values (v_id);
  return v_id;
end $$;

-- ---------------------------------------------------------------------------
-- Usage metering
-- ---------------------------------------------------------------------------
create or replace function public.bump_usage(p_org uuid, p_conversations int default 0, p_ai_messages int default 0, p_messages_sent int default 0,
  p_tokens bigint default 0, p_ai_cost numeric default 0, p_wa_cost numeric default 0)
returns void language sql security definer set search_path = public as $$
  insert into public.usage_counters (org_id, period, conversations, ai_messages, messages_sent, ai_tokens, ai_cost_usd, wa_cost_usd)
  values (p_org, date_trunc('month', now())::date, p_conversations, p_ai_messages, p_messages_sent, p_tokens, p_ai_cost, p_wa_cost)
  on conflict (org_id, period) do update set
    conversations = usage_counters.conversations + excluded.conversations,
    ai_messages = usage_counters.ai_messages + excluded.ai_messages,
    messages_sent = usage_counters.messages_sent + excluded.messages_sent,
    ai_tokens = usage_counters.ai_tokens + excluded.ai_tokens,
    ai_cost_usd = usage_counters.ai_cost_usd + excluded.ai_cost_usd,
    wa_cost_usd = usage_counters.wa_cost_usd + excluded.wa_cost_usd;
$$;
revoke execute on function public.bump_usage(uuid, int, int, int, bigint, numeric, numeric) from public, anon, authenticated;
grant execute on function public.bump_usage(uuid, int, int, int, bigint, numeric, numeric) to service_role;

create or replace function public.usage_summary(p_org uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_plan public.plans; v_sub public.subscriptions; v_usage public.usage_counters;
begin
  if not public.is_org_member(p_org) then raise exception 'forbidden'; end if;
  select * into v_sub from public.subscriptions where org_id = p_org;
  select * into v_plan from public.plans where id = coalesce(v_sub.plan_id, 'trial');
  select * into v_usage from public.usage_counters where org_id = p_org and period = date_trunc('month', now())::date;
  return jsonb_build_object(
    'plan', to_jsonb(v_plan),
    'subscription', to_jsonb(v_sub),
    'usage', jsonb_build_object(
      'conversations', coalesce(v_usage.conversations, 0),
      'ai_messages', coalesce(v_usage.ai_messages, 0),
      'messages_sent', coalesce(v_usage.messages_sent, 0),
      'ai_tokens', coalesce(v_usage.ai_tokens, 0),
      'seats', (select count(*) from public.org_members where org_id = p_org),
      'numbers', (select count(*) from public.whatsapp_accounts where org_id = p_org and status = 'connected')));
end $$;

-- ---------------------------------------------------------------------------
-- Message and conversation triggers
-- ---------------------------------------------------------------------------
create or replace function public.messages_before_insert() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.org_id is null then select org_id into new.org_id from public.conversations where id = new.conversation_id; end if;
  if new.sender_type is null then
    new.sender_type := case when new.direction = 'inbound' then 'customer' when new.is_ai_generated then 'ai' else 'agent' end;
  end if;
  return new;
end $$;
drop trigger if exists messages_before_insert on public.messages;
create trigger messages_before_insert before insert on public.messages for each row execute function public.messages_before_insert();

create or replace function public.messages_after_insert() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.is_internal_note then return null; end if;
  update public.conversations set
    last_message_at = new.sent_at,
    last_message_preview = left(coalesce(nullif(new.content, ''), '[' || new.message_type || ']'), 200),
    last_inbound_at = case when new.direction = 'inbound' then new.sent_at else last_inbound_at end,
    first_response_at = case when new.direction = 'outbound' and first_response_at is null then new.sent_at else first_response_at end
  where id = new.conversation_id;
  if new.direction = 'inbound' then
    update public.customers set last_seen_at = new.sent_at where id = (select customer_id from public.conversations where id = new.conversation_id);
  elsif new.org_id is not null then
    perform public.bump_usage(new.org_id, 0, case when new.is_ai_generated then 1 else 0 end, 1);
  end if;
  return null;
end $$;
drop trigger if exists messages_after_insert on public.messages;
create trigger messages_after_insert after insert on public.messages for each row execute function public.messages_after_insert();

create or replace function public.conversations_after_insert() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.org_id is not null then perform public.bump_usage(new.org_id, 1); end if;
  return null;
end $$;
drop trigger if exists conversations_after_insert on public.conversations;
create trigger conversations_after_insert after insert on public.conversations for each row execute function public.conversations_after_insert();

create or replace function public.conversations_before_update() returns trigger
language plpgsql as $$
begin
  if new.status = 'resolved' and old.status is distinct from 'resolved' then new.resolved_at := now(); end if;
  if new.status <> 'resolved' and old.status = 'resolved' then new.resolved_at := null; new.csat_requested_at := null; end if;
  return new;
end $$;
drop trigger if exists conversations_before_update on public.conversations;
create trigger conversations_before_update before update on public.conversations for each row execute function public.conversations_before_update();

create or replace function public.handoffs_before_update() returns trigger
language plpgsql as $$
begin
  if new.status = 'claimed' and old.status is distinct from 'claimed' then
    new.claimed_at := coalesce(new.claimed_at, now());
    new.claimed_by := coalesce(new.claimed_by, auth.uid());
  end if;
  if new.status = 'resolved' and old.status is distinct from 'resolved' then new.resolved_at := now(); end if;
  return new;
end $$;
drop trigger if exists handoffs_before_update on public.human_handoffs;
create trigger handoffs_before_update before update on public.human_handoffs for each row execute function public.handoffs_before_update();

create or replace function public.ai_events_after_insert() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.org_id is not null and (new.tokens_in + new.tokens_out > 0 or new.cost_usd > 0) then
    perform public.bump_usage(new.org_id, 0, 0, 0, new.tokens_in + new.tokens_out, new.cost_usd);
  end if;
  return null;
end $$;
drop trigger if exists ai_events_after_insert on public.ai_events;
create trigger ai_events_after_insert after insert on public.ai_events for each row execute function public.ai_events_after_insert();

create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
drop trigger if exists kb_articles_touch on public.knowledge_base_articles;
create trigger kb_articles_touch before update on public.knowledge_base_articles for each row execute function public.touch_updated_at();
drop trigger if exists templates_touch on public.whatsapp_templates;
create trigger templates_touch before update on public.whatsapp_templates for each row execute function public.touch_updated_at();
create or replace function public.appointments_touch() returns trigger language plpgsql as $$
begin
  -- Only scheduling changes need to be pushed to Google Calendar again.
  if (new.starts_at, new.ends_at, new.status, new.service_id, new.team_member_id, new.notes)
     is distinct from (old.starts_at, old.ends_at, old.status, old.service_id, old.team_member_id, old.notes) then
    new.updated_at := now();
  end if;
  return new;
end $$;
drop trigger if exists appointments_touch on public.appointments;
create trigger appointments_touch before update on public.appointments for each row execute function public.appointments_touch();
drop trigger if exists ai_settings_touch on public.ai_settings;
create trigger ai_settings_touch before update on public.ai_settings for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Audit log
-- ---------------------------------------------------------------------------
create or replace function public.write_audit_log() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_row jsonb := to_jsonb(coalesce(new, old)); v_org uuid; v_details jsonb;
begin
  v_org := coalesce((v_row ->> 'org_id')::uuid, case when tg_table_name = 'organizations' then (v_row ->> 'id')::uuid end);
  -- Cascading deletes of a whole organization have nothing left to audit against.
  if tg_op = 'DELETE' and not exists (select 1 from public.organizations where id = v_org) then return null; end if;
  if tg_op = 'UPDATE' then
    select jsonb_agg(n.key) into v_details from jsonb_each(to_jsonb(new)) n
     where n.value is distinct from (to_jsonb(old) -> n.key) and n.key not in ('updated_at', 'last_run_at', 'run_count', 'last_webhook_at', 'last_sync_at');
    if v_details is null then return null; end if;
    v_details := jsonb_build_object('changed', v_details);
  end if;
  insert into public.audit_log (org_id, actor_id, action, entity, entity_id, details)
  values (v_org, auth.uid(), lower(tg_op), tg_table_name, coalesce(v_row ->> 'id', v_row ->> 'user_id', v_row ->> 'org_id'), v_details);
  return null;
end $$;

do $$
declare t text;
begin
  foreach t in array array['organizations', 'org_members', 'org_invitations', 'ai_settings', 'automations', 'integrations', 'whatsapp_accounts',
                           'broadcasts', 'whatsapp_templates', 'knowledge_base_articles', 'api_keys', 'products', 'services', 'team_members'] loop
    execute format('drop trigger if exists audit_%s on public.%I', t, t);
    execute format('create trigger audit_%s after insert or update or delete on public.%I for each row execute function public.write_audit_log()', t, t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Analytics (aggregated server-side instead of counting rows in the browser)
-- ---------------------------------------------------------------------------
create or replace function public.avg_response_seconds(p_org uuid, p_from timestamptz, p_to timestamptz) returns numeric
language sql stable security definer set search_path = public as $$
  select round(avg(extract(epoch from (r.sent_at - i.sent_at)))::numeric, 1)
    from public.messages i
    cross join lateral (
      select o.sent_at from public.messages o
       where o.conversation_id = i.conversation_id and o.direction = 'outbound' and not o.is_internal_note and o.sent_at >= i.sent_at
       order by o.sent_at limit 1) r
   where i.org_id = p_org and i.direction = 'inbound' and i.sent_at >= p_from and i.sent_at < p_to
     and public.is_org_member(p_org);
$$;

create or replace function public.dashboard_metrics(p_org uuid, p_from timestamptz, p_to timestamptz) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_prev timestamptz := p_from - (p_to - p_from); r jsonb;
begin
  if not public.is_org_member(p_org) then raise exception 'forbidden'; end if;
  select jsonb_build_object(
    'conversations', count(*) filter (where created_at >= p_from and created_at < p_to),
    'conversations_prev', count(*) filter (where created_at >= v_prev and created_at < p_from),
    'ai_resolved', count(*) filter (where created_at >= p_from and created_at < p_to and status = 'resolved' and is_ai_handled),
    'ai_resolved_prev', count(*) filter (where created_at >= v_prev and created_at < p_from and status = 'resolved' and is_ai_handled),
    'resolved', count(*) filter (where created_at >= p_from and created_at < p_to and status = 'resolved'),
    'open_conversations', count(*) filter (where status = 'open'))
  into r from public.conversations where org_id = p_org;

  r := r || jsonb_build_object(
    'handoffs', (select count(*) from public.human_handoffs where org_id = p_org and requested_at >= p_from and requested_at < p_to),
    'handoffs_prev', (select count(*) from public.human_handoffs where org_id = p_org and requested_at >= v_prev and requested_at < p_from),
    'pending_handoffs', (select count(*) from public.human_handoffs where org_id = p_org and status = 'pending'),
    'new_customers', (select count(*) from public.customers where org_id = p_org and created_at >= p_from and created_at < p_to),
    'inbound', (select count(*) from public.messages where org_id = p_org and direction = 'inbound' and sent_at >= p_from and sent_at < p_to),
    'outbound', (select count(*) from public.messages where org_id = p_org and direction = 'outbound' and not is_internal_note and sent_at >= p_from and sent_at < p_to),
    'ai_messages', (select count(*) from public.messages where org_id = p_org and is_ai_generated and sent_at >= p_from and sent_at < p_to),
    'avg_response_seconds', public.avg_response_seconds(p_org, p_from, p_to),
    'avg_response_seconds_prev', public.avg_response_seconds(p_org, v_prev, p_from),
    'csat_avg', (select round(avg(score)::numeric, 2) from public.csat_responses where org_id = p_org and created_at >= p_from and created_at < p_to),
    'csat_count', (select count(*) from public.csat_responses where org_id = p_org and created_at >= p_from and created_at < p_to),
    'ai_bookings', (select count(*) from public.appointments where org_id = p_org and created_by_ai and created_at >= p_from and created_at < p_to),
    'ai_revenue', coalesce((select sum(total) from public.orders where org_id = p_org and created_by_ai and status in ('paid', 'fulfilled') and paid_at >= p_from and paid_at < p_to), 0)
                + coalesce((select sum(s.price) from public.appointments a join public.services s on s.id = a.service_id
                             where a.org_id = p_org and a.created_by_ai and a.status not in ('cancelled', 'no_show') and a.created_at >= p_from and a.created_at < p_to), 0),
    'revenue', coalesce((select sum(total) from public.orders where org_id = p_org and status in ('paid', 'fulfilled') and paid_at >= p_from and paid_at < p_to), 0));
  return r;
end $$;

create or replace function public.conversation_trend(p_org uuid, p_from timestamptz, p_to timestamptz, p_tz text default 'UTC')
returns table (day date, total bigint, ai_resolved bigint, handoffs bigint)
language sql stable security definer set search_path = public as $$
  with days as (
    select d::date as day from generate_series((p_from at time zone p_tz)::date, ((p_to - interval '1 second') at time zone p_tz)::date, interval '1 day') d)
  select days.day,
         (select count(*) from public.conversations c where c.org_id = p_org and (c.created_at at time zone p_tz)::date = days.day),
         (select count(*) from public.conversations c where c.org_id = p_org and c.status = 'resolved' and c.is_ai_handled and (c.created_at at time zone p_tz)::date = days.day),
         (select count(*) from public.human_handoffs h where h.org_id = p_org and (h.requested_at at time zone p_tz)::date = days.day)
    from days where public.is_org_member(p_org) order by days.day;
$$;

create or replace function public.peak_hours(p_org uuid, p_from timestamptz, p_to timestamptz, p_tz text default 'UTC')
returns table (dow int, hour int, total bigint)
language sql stable security definer set search_path = public as $$
  select extract(dow from sent_at at time zone p_tz)::int, extract(hour from sent_at at time zone p_tz)::int, count(*)
    from public.messages
   where org_id = p_org and direction = 'inbound' and sent_at >= p_from and sent_at < p_to and public.is_org_member(p_org)
   group by 1, 2;
$$;

create or replace function public.top_intents(p_org uuid, p_from timestamptz, p_to timestamptz)
returns table (intent text, total bigint)
language sql stable security definer set search_path = public as $$
  select coalesce(intent, 'unclassified'), count(*) from public.conversations
   where org_id = p_org and created_at >= p_from and created_at < p_to and public.is_org_member(p_org)
   group by 1 order by 2 desc limit 10;
$$;

create or replace function public.agent_performance(p_org uuid, p_from timestamptz, p_to timestamptz)
returns table (user_id uuid, full_name text, email text, role text, messages bigint, conversations bigint, handoffs_resolved bigint, avg_claim_seconds numeric)
language sql stable security definer set search_path = public as $$
  select m.user_id, p.full_name, p.email, m.role,
         (select count(*) from public.messages x where x.org_id = p_org and x.sent_by = m.user_id and not x.is_internal_note and x.sent_at >= p_from and x.sent_at < p_to),
         (select count(distinct x.conversation_id) from public.messages x where x.org_id = p_org and x.sent_by = m.user_id and x.sent_at >= p_from and x.sent_at < p_to),
         (select count(*) from public.human_handoffs h where h.org_id = p_org and h.claimed_by = m.user_id and h.status = 'resolved' and h.resolved_at >= p_from and h.resolved_at < p_to),
         (select round(avg(extract(epoch from h.claimed_at - h.requested_at))::numeric, 0) from public.human_handoffs h
           where h.org_id = p_org and h.claimed_by = m.user_id and h.claimed_at >= p_from and h.claimed_at < p_to)
    from public.org_members m join public.profiles p on p.id = m.user_id
   where m.org_id = p_org and public.is_org_member(p_org)
   order by 5 desc;
$$;

create or replace function public.activity_feed(p_org uuid, p_limit int default 8)
returns table (kind text, subject text, entity_id uuid, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  select * from (
    select 'handoff_requested' as kind, coalesce(cu.full_name, cu.phone) as subject, h.conversation_id as entity_id, h.requested_at as created_at
      from public.human_handoffs h left join public.conversations c on c.id = h.conversation_id left join public.customers cu on cu.id = c.customer_id
     where h.org_id = p_org
    union all
    select case when c.is_ai_handled then 'ai_resolved' else 'resolved' end, coalesce(cu.full_name, cu.phone), c.id, c.resolved_at
      from public.conversations c left join public.customers cu on cu.id = c.customer_id
     where c.org_id = p_org and c.resolved_at is not null
    union all
    select 'booking_created', coalesce(cu.full_name, cu.phone), a.id, a.created_at
      from public.appointments a left join public.customers cu on cu.id = a.customer_id where a.org_id = p_org
    union all
    select 'kb_ready', d.title, d.id, d.created_at from public.kb_documents d where d.org_id = p_org and d.status = 'ready'
    union all
    select 'order_paid', coalesce(cu.full_name, cu.phone), o.id, o.paid_at
      from public.orders o left join public.customers cu on cu.id = o.customer_id where o.org_id = p_org and o.paid_at is not null
  ) feed
  where public.is_org_member(p_org) and feed.created_at is not null
  order by 4 desc limit p_limit;
$$;

create or replace function public.ai_health(p_org uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare r jsonb;
begin
  if not public.is_org_member(p_org) then raise exception 'forbidden'; end if;
  select jsonb_build_object(
    'replies', count(*) filter (where kind = 'ai_reply'),
    'errors', count(*) filter (where kind like '%error'),
    'avg_latency_ms', round(avg(latency_ms) filter (where kind = 'ai_reply')),
    'tokens', coalesce(sum(tokens_in + tokens_out), 0),
    'cost_usd', coalesce(sum(cost_usd), 0),
    'last_event_at', max(created_at))
  into r from public.ai_events where org_id = p_org and created_at > now() - interval '24 hours';
  return r || jsonb_build_object(
    'whatsapp', coalesce((select jsonb_agg(jsonb_build_object('display_phone', display_phone, 'status', status, 'last_webhook_at', last_webhook_at))
                            from public.whatsapp_accounts where org_id = p_org), '[]'::jsonb),
    'is_live', coalesce((select is_live from public.ai_settings where org_id = p_org), false));
end $$;

-- ---------------------------------------------------------------------------
-- Global search
-- ---------------------------------------------------------------------------
create or replace function public.global_search(p_org uuid, p_term text)
returns table (kind text, id uuid, title text, subtitle text)
language plpgsql stable security definer set search_path = public as $$
declare v text := '%' || replace(replace(replace(trim(p_term), '\', '\\'), '%', '\%'), '_', '\_') || '%';
begin
  if not public.is_org_member(p_org) or length(trim(p_term)) < 2 then return; end if;
  return query
    (select 'customer'::text, c.id, coalesce(c.full_name, c.phone), coalesce(c.phone, c.email)
       from public.customers c where c.org_id = p_org and (c.full_name ilike v or c.phone ilike v or c.email ilike v) limit 6)
    union all
    (select 'conversation'::text, c.id, coalesce(cu.full_name, cu.phone, 'Customer'), c.last_message_preview
       from public.conversations c left join public.customers cu on cu.id = c.customer_id
      where c.org_id = p_org and (cu.full_name ilike v or cu.phone ilike v or c.last_message_preview ilike v or c.summary ilike v)
      order by c.last_message_at desc nulls last limit 6)
    union all
    (select 'message'::text, m.conversation_id, left(m.content, 80), to_char(m.sent_at, 'YYYY-MM-DD HH24:MI')
       from public.messages m where m.org_id = p_org and m.content ilike v order by m.sent_at desc limit 6)
    union all
    (select 'article'::text, a.id, a.question, a.category from public.knowledge_base_articles a
      where a.org_id = p_org and (a.question ilike v or a.answer ilike v) limit 6);
end $$;

-- ---------------------------------------------------------------------------
-- Knowledge retrieval (service role only)
-- ---------------------------------------------------------------------------
create or replace function public.match_kb_chunks(p_org uuid, p_embedding extensions.vector, p_count int default 5)
returns table (content text, similarity double precision, document_id uuid, article_id uuid)
language sql stable security definer set search_path = public, extensions as $$
  select content, 1 - (embedding <=> p_embedding), document_id, article_id
    from public.kb_chunks where org_id = p_org and embedding is not null
   order by embedding <=> p_embedding limit p_count;
$$;
revoke execute on function public.match_kb_chunks(uuid, extensions.vector, int) from public, anon, authenticated;
grant execute on function public.match_kb_chunks(uuid, extensions.vector, int) to service_role;

-- ---------------------------------------------------------------------------
-- Integrations, API keys, compliance
-- ---------------------------------------------------------------------------
create or replace function public.set_integration_secret(p_org uuid, p_provider text, p_secret jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.has_org_role(p_org, array['owner', 'admin']) then raise exception 'forbidden'; end if;
  insert into public.integration_secrets (org_id, provider, secret) values (p_org, p_provider, p_secret)
  on conflict (org_id, provider) do update set secret = integration_secrets.secret || excluded.secret, updated_at = now();
end $$;

create or replace function public.disconnect_integration(p_org uuid, p_provider text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.has_org_role(p_org, array['owner', 'admin']) then raise exception 'forbidden'; end if;
  delete from public.integration_secrets where org_id = p_org and provider = p_provider;
  update public.integrations set status = 'disconnected' where org_id = p_org and provider = p_provider;
  if p_provider = 'whatsapp' then update public.whatsapp_accounts set status = 'disconnected' where org_id = p_org; end if;
end $$;

create or replace function public.create_api_key(p_org uuid, p_name text) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare v_key text := 'atx_' || encode(gen_random_bytes(24), 'hex');
begin
  if not public.has_org_role(p_org, array['owner', 'admin']) then raise exception 'forbidden'; end if;
  insert into public.api_keys (org_id, name, prefix, key_hash, created_by)
  values (p_org, p_name, left(v_key, 12), encode(digest(v_key, 'sha256'), 'hex'), auth.uid());
  return v_key;
end $$;

create or replace function public.delete_customer_data(p_org uuid, p_customer uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.has_org_role(p_org, array['owner', 'admin']) then raise exception 'forbidden'; end if;
  delete from public.customers where id = p_customer and org_id = p_org;
end $$;

-- Deletes messages older than each organization's retention window (settings.retention_days).
create or replace function public.apply_retention() returns int
language plpgsql security definer set search_path = public as $$
declare v_total int := 0; v_count int; o record;
begin
  for o in select id, (settings ->> 'retention_days')::int as days from public.organizations
            where (settings ->> 'retention_days') ~ '^[0-9]+$' and (settings ->> 'retention_days')::int > 0 loop
    delete from public.messages where org_id = o.id and sent_at < now() - make_interval(days => o.days);
    get diagnostics v_count = row_count;
    v_total := v_total + v_count;
  end loop;
  return v_total;
end $$;
revoke execute on function public.apply_retention() from public, anon, authenticated;
grant execute on function public.apply_retention() to service_role;

-- ---------------------------------------------------------------------------
-- Platform admin console
-- ---------------------------------------------------------------------------
create or replace function public.admin_tenants()
returns table (id uuid, name text, status text, plan_id text, subscription_status text, parent_name text, is_agency boolean, created_at timestamptz,
               members bigint, conversations int, ai_messages int, ai_cost_usd numeric, wa_cost_usd numeric, revenue_usd numeric, last_activity_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_platform_admin() then raise exception 'forbidden'; end if;
  return query
    select o.id, o.name, o.status, s.plan_id, s.status, parent.name, o.is_agency, o.created_at,
           (select count(*) from public.org_members m where m.org_id = o.id),
           coalesce(u.conversations, 0), coalesce(u.ai_messages, 0), coalesce(u.ai_cost_usd, 0), coalesce(u.wa_cost_usd, 0),
           case when s.status = 'active' then coalesce(p.price_monthly, 0) else 0 end,
           (select max(c.last_message_at) from public.conversations c where c.org_id = o.id)
      from public.organizations o
      left join public.subscriptions s on s.org_id = o.id
      left join public.plans p on p.id = s.plan_id
      left join public.organizations parent on parent.id = o.parent_org_id
      left join public.usage_counters u on u.org_id = o.id and u.period = date_trunc('month', now())::date
     order by o.created_at desc;
end $$;

create or replace function public.admin_update_org(p_org uuid, p_status text default null, p_plan text default null, p_is_agency boolean default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_platform_admin() then raise exception 'forbidden'; end if;
  update public.organizations set status = coalesce(p_status, status), plan = coalesce(p_plan, plan), is_agency = coalesce(p_is_agency, is_agency) where id = p_org;
  if p_plan is not null then
    update public.subscriptions set plan_id = p_plan, status = case when p_plan = 'trial' then 'trialing' else 'active' end, updated_at = now() where org_id = p_org;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Realtime
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then return; end if;
  foreach t in array array['messages', 'conversations', 'human_handoffs', 'broadcasts'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Storage: media/{org_id}/..., knowledge/{org_id}/..., branding/{org_id}/...
-- ---------------------------------------------------------------------------
create or replace function public.try_uuid(p text) returns uuid language plpgsql immutable as $$
begin return p::uuid; exception when others then return null; end $$;

insert into storage.buckets (id, name, public) values
  ('media', 'media', false), ('knowledge', 'knowledge', false), ('branding', 'branding', true)
on conflict (id) do nothing;

drop policy if exists autexa_storage_select on storage.objects;
create policy autexa_storage_select on storage.objects for select to authenticated
  using (bucket_id in ('media', 'knowledge', 'branding') and public.is_org_member(public.try_uuid((storage.foldername(name))[1])));
drop policy if exists autexa_storage_insert on storage.objects;
create policy autexa_storage_insert on storage.objects for insert to authenticated
  with check (bucket_id in ('media', 'knowledge', 'branding') and public.has_org_role(public.try_uuid((storage.foldername(name))[1]), array['owner', 'admin', 'agent']));
drop policy if exists autexa_storage_delete on storage.objects;
create policy autexa_storage_delete on storage.objects for delete to authenticated
  using (bucket_id in ('media', 'knowledge', 'branding') and public.has_org_role(public.try_uuid((storage.foldername(name))[1]), array['owner', 'admin']));
