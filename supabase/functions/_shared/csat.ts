import { admin } from './supabase.ts';
import { deliver, isWindowOpen } from './messaging.ts';
import { listMessage } from './whatsapp.ts';
import { generateInsights } from './insights.ts';
import { logAiEvent } from './ai.ts';

const copy = {
  en: { body: 'How satisfied were you with our service today?', button: 'Rate us', rows: ['Excellent', 'Good', 'Okay', 'Poor', 'Very poor'] },
  ar: { body: 'ما مدى رضاك عن خدمتنا اليوم؟', button: 'قيّمنا', rows: ['ممتاز', 'جيد', 'مقبول', 'ضعيف', 'سيئ جداً'] },
};

// Asks for a 1-5 rating shortly after a conversation is resolved, while the 24h window is still open.
export async function requestCsat() {
  const now = Date.now();
  const { data: conversations } = await admin.from('conversations')
    .select('id, org_id, last_inbound_at, customers(phone), organizations(locale, status)')
    .eq('status', 'resolved').is('csat_requested_at', null)
    .lte('resolved_at', new Date(now - 5 * 60_000).toISOString()).gte('resolved_at', new Date(now - 20 * 3600_000).toISOString())
    .limit(200);
  const orgIds = [...new Set((conversations || []).map((row) => row.org_id))];
  if (!orgIds.length) return { sent: 0 };
  const { data: settings } = await admin.from('ai_settings').select('org_id, csat_enabled').in('org_id', orgIds);
  const enabled = new Set((settings || []).filter((row) => row.csat_enabled !== false).map((row) => row.org_id));
  let sent = 0;
  for (const conversation of conversations || []) {
    const org = conversation.organizations as { locale?: string; status?: string } | null;
    const phone = (conversation.customers as { phone?: string } | null)?.phone;
    if (!enabled.has(conversation.org_id) || org?.status === 'suspended' || !phone || !isWindowOpen(conversation)) continue;
    const { data: claimed } = await admin.from('conversations').update({ csat_requested_at: new Date().toISOString() })
      .eq('id', conversation.id).is('csat_requested_at', null).select('id');
    if (!claimed?.length) continue;
    const text = copy[org?.locale === 'ar' ? 'ar' : 'en'];
    try {
      await deliver(conversation.org_id, conversation.id, phone, {
        text: text.body,
        interactive: listMessage(text.body, text.button, text.rows.map((title, index) => ({ id: `csat_${5 - index}`, title: `${'★'.repeat(5 - index)} ${title}` }))),
      }, { senderType: 'system' });
      sent += 1;
    } catch (error) {
      await logAiEvent(conversation.org_id, 'send_error', { conversationId: conversation.id, error: `CSAT: ${(error as Error).message}` });
    }
  }
  return { sent };
}

export async function summarizeResolved(limit = 25) {
  const { data } = await admin.from('conversations').select('id, org_id').eq('status', 'resolved').is('summary', null)
    .gte('resolved_at', new Date(Date.now() - 2 * 86400_000).toISOString()).limit(limit);
  let done = 0;
  for (const conversation of data || []) {
    try { await generateInsights(conversation.org_id, conversation.id); done += 1; } catch (error) {
      await logAiEvent(conversation.org_id, 'ai_error', { conversationId: conversation.id, error: `Insights: ${(error as Error).message}` });
      // Mark it so a failing conversation is not retried forever.
      await admin.from('conversations').update({ summary: '' }).eq('id', conversation.id);
    }
  }
  return { summarized: done };
}
