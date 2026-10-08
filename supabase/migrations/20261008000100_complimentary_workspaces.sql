-- Free, unlimited workspaces for the Autexa team and the customers it onboards by hand.

insert into public.plans (id, name, price_monthly, limits, is_public, sort)
values ('unlimited', 'Unlimited (free)', 0, '{}', false, 99)
on conflict (id) do update set name = excluded.name, price_monthly = 0, limits = '{}', is_public = false;

-- Workspaces owned by a platform admin never pay.
update public.subscriptions s
   set plan_id = 'unlimited', status = 'active', trial_ends_at = null, updated_at = now()
 where exists (select 1 from public.org_members m join public.platform_admins a on a.user_id = m.user_id
                where m.org_id = s.org_id and m.role = 'owner');
update public.organizations o set plan = 'unlimited'
 where exists (select 1 from public.subscriptions s where s.org_id = o.id and s.plan_id = 'unlimited');

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
  if public.is_platform_admin() then
    insert into public.subscriptions (org_id, plan_id, status, trial_ends_at) values (v_id, 'unlimited', 'active', null);
    update public.organizations set plan = 'unlimited' where id = v_id;
  else
    insert into public.subscriptions (org_id) values (v_id);
  end if;
  return v_id;
end $$;

-- Creates a customer workspace without making the calling admin a member; the
-- admin reaches it through "Open workspace" and the owner is invited separately.
create or replace function public.admin_create_workspace(p_name text, p_plan text default 'unlimited', p_industry text default null,
  p_timezone text default 'Africa/Cairo', p_locale text default 'ar')
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_plan text := coalesce(nullif(p_plan, ''), 'unlimited');
begin
  if not public.is_platform_admin() then raise exception 'forbidden'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'workspace name is required'; end if;
  if not exists (select 1 from public.plans where id = v_plan) then raise exception 'unknown plan %', v_plan; end if;
  insert into public.organizations (name, industry, timezone, locale, plan)
  values (trim(p_name), p_industry, coalesce(p_timezone, 'Africa/Cairo'), coalesce(p_locale, 'ar'), v_plan) returning id into v_id;
  insert into public.ai_settings (org_id) values (v_id);
  insert into public.subscriptions (org_id, plan_id, status, trial_ends_at)
  values (v_id, v_plan, case when v_plan = 'trial' then 'trialing' else 'active' end,
          case when v_plan = 'trial' then now() + interval '14 days' end);
  return v_id;
end $$;
revoke execute on function public.admin_create_workspace(text, text, text, text, text) from public, anon;
grant execute on function public.admin_create_workspace(text, text, text, text, text) to authenticated;

create or replace function public.admin_update_org(p_org uuid, p_status text default null, p_plan text default null, p_is_agency boolean default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_platform_admin() then raise exception 'forbidden'; end if;
  update public.organizations set status = coalesce(p_status, status), plan = coalesce(p_plan, plan), is_agency = coalesce(p_is_agency, is_agency) where id = p_org;
  if p_plan is not null then
    update public.subscriptions
       set plan_id = p_plan,
           status = case when p_plan = 'trial' then 'trialing' else 'active' end,
           trial_ends_at = case when p_plan = 'trial' then coalesce(trial_ends_at, now() + interval '14 days') end,
           updated_at = now()
     where org_id = p_org;
  end if;
end $$;
