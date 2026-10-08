-- Queued messages are sent by the n8n outbox through WAHA (an unofficial client).
-- To keep numbers from being banned, only reply to customers who wrote in the last 24 hours.

create or replace function public.messages_reply_only_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.delivery_status is distinct from 'queued' or new.direction <> 'outbound' or coalesce(new.is_internal_note, false) then
    return new;
  end if;
  if not exists (
    select 1
      from public.conversations target
      join public.conversations any_conv on any_conv.customer_id = target.customer_id and any_conv.org_id = target.org_id
      join public.messages m on m.conversation_id = any_conv.id
     where target.id = new.conversation_id
       and m.direction = 'inbound'
       and m.sent_at > now() - interval '24 hours'
  ) then
    raise exception 'REPLY_ONLY: This customer has not messaged in the last 24 hours. To protect the number from bans, WhatsApp (WAHA) only replies to customers who wrote first.'
      using errcode = 'P0001';
  end if;
  return new;
end $$;

drop trigger if exists messages_reply_only_guard on public.messages;
create trigger messages_reply_only_guard before insert or update of delivery_status on public.messages
  for each row execute function public.messages_reply_only_guard();

-- Anything already waiting that breaks the rule is cancelled instead of sent.
update public.messages m set delivery_status = 'failed'
 where m.delivery_status = 'queued' and m.direction = 'outbound'
   and not exists (
     select 1 from public.conversations target
       join public.conversations any_conv on any_conv.customer_id = target.customer_id and any_conv.org_id = target.org_id
       join public.messages i on i.conversation_id = any_conv.id
      where target.id = m.conversation_id and i.direction = 'inbound' and i.sent_at > now() - interval '24 hours');
