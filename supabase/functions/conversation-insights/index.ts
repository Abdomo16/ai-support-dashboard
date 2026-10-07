import { json, readJson, serve } from '../_shared/http.ts';
import { admin, must, requireRole } from '../_shared/supabase.ts';
import { generateInsights } from '../_shared/insights.ts';

serve(async (request) => {
  const body = await readJson<{ org_id: string; conversation_id: string }>(request);
  await requireRole(request, body.org_id, 'agent');
  must(await admin.from('conversations').select('id').eq('id', body.conversation_id).eq('org_id', body.org_id).maybeSingle(), 'Conversation not found');
  return json(await generateInsights(body.org_id, body.conversation_id));
});
