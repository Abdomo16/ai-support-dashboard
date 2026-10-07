import { HttpError, background, json, readJson, serve } from '../_shared/http.ts';
import { admin, must, requireRole } from '../_shared/supabase.ts';
import { segmentCustomers, sendBroadcast } from '../_shared/broadcasts.ts';

type Body = { org_id: string; broadcast_id?: string; action?: 'send' | 'estimate'; segment?: { tags?: string[]; opted_in_only?: boolean } };

serve(async (request) => {
  const body = await readJson<Body>(request);
  await requireRole(request, body.org_id, 'admin');

  if (body.action === 'estimate') {
    return json({ count: (await segmentCustomers(body.org_id, body.segment || {})).length });
  }

  const broadcast = must(await admin.from('broadcasts').select('id, status').eq('id', body.broadcast_id).eq('org_id', body.org_id).maybeSingle(), 'Broadcast not found');
  if (!['draft', 'scheduled'].includes(broadcast.status)) throw new HttpError(409, 'This broadcast was already sent');
  // Large audiences take a while; sending continues after the response and stats update live.
  background(sendBroadcast(body.org_id, broadcast.id));
  return json({ started: true });
});
