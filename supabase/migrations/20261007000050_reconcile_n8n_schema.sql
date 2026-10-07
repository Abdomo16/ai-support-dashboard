-- Brings the original n8n-era schema (organization_id, organization_members, enum-typed columns)
-- in line with the dashboard schema before the tenancy migration runs. Safe on a fresh database.

-- organization_id -> org_id everywhere. Views and policies follow renamed columns automatically.
do $$
declare r record;
begin
  for r in select c.table_name
             from information_schema.columns c
             join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
            where c.table_schema = 'public' and c.column_name = 'organization_id' and t.table_type = 'BASE TABLE'
              and not exists (select 1 from information_schema.columns o
                               where o.table_schema = 'public' and o.table_name = c.table_name and o.column_name = 'org_id')
  loop
    execute format('alter table public.%I rename column organization_id to org_id', r.table_name);
  end loop;
end $$;

-- The old helpers take a parameter named org_id, so they cannot be replaced in place; dropping them
-- also drops the policies built on them. Every table gets tenant policies again further on.
drop function if exists public.is_org_admin(uuid) cascade;
drop function if exists public.is_org_member(uuid) cascade;
do $$
declare p record;
begin
  for p in select policyname, tablename from pg_policies where schemaname = 'public' loop
    execute format('drop policy %I on public.%I', p.policyname, p.tablename);
  end loop;
end $$;

-- Unused n8n-era tables whose names the dashboard needs with a different shape.
do $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'integrations' and column_name = 'type') then
    alter table public.integrations rename to legacy_integrations;
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'products' and column_name = 'is_upsell_candidate') then
    alter table public.products rename to legacy_products;
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'orders' and column_name = 'order_number') then
    alter table public.orders rename to legacy_orders;
    alter table if exists public.order_items rename to legacy_order_items;
  end if;
end $$;

-- The dashboard writes values the old enums do not have ('agent' senders, 'claimed' handoffs, free-text reasons).
create or replace function pg_temp.enum_to_text(p_table text, p_column text, p_default text) returns void language plpgsql as $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = p_table and column_name = p_column and data_type = 'USER-DEFINED') then
    execute format('alter table public.%I alter column %I drop default', p_table, p_column);
    execute format('alter table public.%I alter column %I type text using %I::text', p_table, p_column, p_column);
    if p_default is not null then execute format('alter table public.%I alter column %I set default %L', p_table, p_column, p_default); end if;
  end if;
end $$;
select pg_temp.enum_to_text('human_handoffs', 'reason', 'other');
select pg_temp.enum_to_text('human_handoffs', 'status', 'pending');
select pg_temp.enum_to_text('messages', 'sender_type', null);

-- Columns the dashboard leaves empty when it creates rows.
do $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'human_handoffs' and column_name = 'customer_id') then
    alter table public.human_handoffs alter column customer_id drop not null;
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'conversations' and column_name = 'channel_id') then
    alter table public.conversations alter column channel_id drop not null;
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'organizations' and column_name = 'slug') then
    alter table public.organizations alter column slug set default ('org-' || substr(md5(random()::text), 1, 10));
  end if;
end $$;
