import * as overview from '../features/dashboard/Overview.js';
import * as conversations from '../features/conversations/Conversations.js';
import * as handoffs from '../features/handoffs/Handoffs.js';
import * as customers from '../features/customers/Customers.js';
import * as bookings from '../features/bookings/Bookings.js';
import * as orders from '../features/orders/Orders.js';
import * as aiAgent from '../features/ai-agent/AiAgent.js';
import * as knowledge from '../features/knowledge-base/KnowledgeBase.js';
import * as dataSources from '../features/data-sources/DataSources.js';
import * as broadcasts from '../features/broadcasts/Broadcasts.js';
import * as automations from '../features/automations/Automations.js';
import * as analytics from '../features/analytics/Analytics.js';
import * as integrations from '../features/integrations/Integrations.js';
import * as billing from '../features/billing/Billing.js';
import * as settings from '../features/settings/Settings.js';
import * as onboarding from '../features/onboarding/Onboarding.js';
import * as admin from '../features/admin/AdminConsole.js';

export const navGroups = ['support', 'aiGroup', 'growth', 'workspaceGroup', 'platform'];

export const routes = {
  overview: { module: overview, icon: '⌂', group: 'support' },
  conversations: { module: conversations, icon: '◫', group: 'support' },
  handoffs: { module: handoffs, icon: '⇄', group: 'support', badge: 'handoffs' },
  customers: { module: customers, icon: '◉', group: 'support' },
  bookings: { module: bookings, icon: '◷', group: 'support' },
  orders: { module: orders, icon: '▣', group: 'support' },
  ai: { module: aiAgent, icon: '✦', group: 'aiGroup', label: 'aiAgent' },
  knowledge: { module: knowledge, icon: '▤', group: 'aiGroup' },
  data: { module: dataSources, icon: '⛁', group: 'aiGroup', label: 'dataSources' },
  broadcasts: { module: broadcasts, icon: '➚', group: 'growth' },
  automations: { module: automations, icon: '↻', group: 'growth' },
  analytics: { module: analytics, icon: '◔', group: 'growth' },
  integrations: { module: integrations, icon: '⌘', group: 'workspaceGroup', minRole: 'admin' },
  billing: { module: billing, icon: '◈', group: 'workspaceGroup', minRole: 'admin' },
  settings: { module: settings, icon: '⚙', group: 'workspaceGroup' },
  onboarding: { module: onboarding, hidden: true },
  admin: { module: admin, icon: '♛', group: 'platform', platformAdmin: true, label: 'adminConsole' },
};

// Platform admins switch pages per workspace with organizations.features: { "<route>": false } hides a page,
// and routes declaring `feature` only appear when features[feature] === true.
export const TOGGLEABLE_ROUTES = ['bookings', 'orders', 'knowledge', 'data', 'broadcasts', 'automations', 'analytics'];
export function routeEnabled(key, definition, features = {}) {
  if (features?.[key] === false) return false;
  return !definition.feature || features?.[definition.feature] === true;
}
