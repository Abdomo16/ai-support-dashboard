import { admin } from './supabase.ts';

// Returns false once the workspace used up its monthly AI message or conversation allowance.
export async function withinPlanLimits(orgId: string) {
  const period = new Date();
  const month = `${period.getUTCFullYear()}-${String(period.getUTCMonth() + 1).padStart(2, '0')}-01`;
  const [{ data: subscription }, { data: usage }] = await Promise.all([
    admin.from('subscriptions').select('status, plan_id, trial_ends_at, plans(limits)').eq('org_id', orgId).maybeSingle(),
    admin.from('usage_counters').select('conversations, ai_messages').eq('org_id', orgId).eq('period', month).maybeSingle(),
  ]);
  if (!subscription) return true;
  if (subscription.status === 'canceled') return false;
  if (subscription.status === 'trialing' && subscription.trial_ends_at && new Date(subscription.trial_ends_at) < new Date()) return false;
  const limits = (subscription.plans as { limits?: Record<string, number> } | null)?.limits || {};
  if (limits.ai_messages && (usage?.ai_messages || 0) >= limits.ai_messages) return false;
  if (limits.conversations && (usage?.conversations || 0) > limits.conversations) return false;
  return true;
}
