import { db, invokeFunction, query } from './supabaseClient.js';
import { orgId } from './workspace.js';

export const getUsageSummary = () => db.rpc('usage_summary', { p_org: orgId() });
export const getPlans = () => query('plans', 'select=*&is_public=eq.true&order=sort');
export const startCheckout = (planId) => invokeFunction('billing', { org_id: orgId(), action: 'checkout', plan_id: planId, return_url: `${location.origin}${location.pathname}#/billing` });
export const openBillingPortal = () => invokeFunction('billing', { org_id: orgId(), action: 'portal', return_url: `${location.origin}${location.pathname}#/billing` });

// Returns [{ key, used, limit, ratio }] for every metered limit of the current plan.
export function usageMeters(summary) {
  const limits = summary?.plan?.limits || {};
  const usage = summary?.usage || {};
  return ['conversations', 'ai_messages', 'seats', 'numbers'].map((key) => {
    const limit = Number(limits[key] || 0);
    const used = Number(usage[key] || 0);
    return { key, used, limit, ratio: limit ? used / limit : 0 };
  });
}
