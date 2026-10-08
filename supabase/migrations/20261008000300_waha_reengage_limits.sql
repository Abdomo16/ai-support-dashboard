-- Manual WAHA messages from the dashboard (queued for the n8n outbox):
--   * the customer must have messaged this workspace at least once;
--   * within 24 hours of their last message, replies are unlimited;
--   * after that, at most 2 messages per customer until they reply,
--     and at most 20 such messages per workspace in any 24 hours.

create or replace function public.messages_reply_only_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_org uuid;
  v_customer uuid;
  v_last_inbound timestamptz;
begin
  if new.delivery_status is distinct from 'queued' or new.direction <> 'outbound' or coalesce(new.is_internal_note, false) then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.delivery_status is not distinct from 'queued' then return new; end if;

  select c.org_id, c.customer_id into v_org, v_customer from public.conversations c where c.id = new.conversation_id;
  select max(m.sent_at) into v_last_inbound
    from public.messages m join public.conversations c on c.id = m.conversation_id
   where c.org_id = v_org and c.customer_id = v_customer and m.direction = 'inbound';

  if v_last_inbound is null then
    raise exception 'WAHA_RULE:never_messaged This customer has never messaged this number.' using errcode = 'P0001';
  end if;
  if v_last_inbound > now() - interval '24 hours' then return new; end if;

  if (select count(*) from public.messages m join public.conversations c on c.id = m.conversation_id
       where c.org_id = v_org and c.customer_id = v_customer and m.metadata ->> 'reengage' = 'true'
         and m.sent_at > v_last_inbound) >= 2 then
    raise exception 'WAHA_RULE:wait_reply Wait for this customer to reply before sending more.' using errcode = 'P0001';
  end if;
  if (select count(*) from public.messages m
       where m.org_id = v_org and m.metadata ->> 'reengage' = 'true' and m.sent_at > now() - interval '24 hours') >= 20 then
    raise exception 'WAHA_RULE:daily_limit Daily limit of 20 messages to older customers reached.' using errcode = 'P0001';
  end if;

  new.metadata := coalesce(new.metadata, '{}'::jsonb) || '{"reengage": true}'::jsonb;
  return new;
end $$;

drop trigger if exists messages_reply_only_guard on public.messages;
create trigger messages_reply_only_guard before insert or update of delivery_status on public.messages
  for each row execute function public.messages_reply_only_guard();
