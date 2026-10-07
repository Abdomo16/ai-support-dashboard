import { db, query } from './supabaseClient.js';
import { orgId, workspace } from './workspace.js';

const PERIOD_KEY = 'autexa-period';

export const getPeriodDays = () => Number(localStorage.getItem(PERIOD_KEY)) || 7;
export const setPeriodDays = (days) => localStorage.setItem(PERIOD_KEY, String(days));

const range = ({ from, to }) => ({ p_org: orgId(), p_from: from, p_to: to });
const tz = () => workspace.org?.timezone || 'UTC';

export const getMetrics = (period) => db.rpc('dashboard_metrics', range(period));
export const getTrend = (period) => db.rpc('conversation_trend', { ...range(period), p_tz: tz() });
export const getPeakHours = (period) => db.rpc('peak_hours', { ...range(period), p_tz: tz() });
export const getTopIntents = (period) => db.rpc('top_intents', range(period));
export const getAgentPerformance = (period) => db.rpc('agent_performance', range(period));
export const getActivityFeed = (limit = 8) => db.rpc('activity_feed', { p_org: orgId(), p_limit: limit });
export const getAiHealth = () => db.rpc('ai_health', { p_org: orgId() });

export const getCsatBreakdown = ({ from, to }) => query('csat_responses', `select=score,created_at&org_id=eq.${orgId()}&created_at=gte.${from}&created_at=lt.${to}&limit=5000`);
export const getUnansweredTop = () => query('unanswered_questions', `select=id,question,occurrences,last_asked_at&org_id=eq.${orgId()}&status=eq.open&order=occurrences.desc&limit=10`);
export const getPaidOrders = ({ from, to }) => query('orders', `select=total,currency,created_by_ai,paid_at&org_id=eq.${orgId()}&status=in.(paid,fulfilled)&paid_at=gte.${from}&paid_at=lt.${to}&limit=5000`);
