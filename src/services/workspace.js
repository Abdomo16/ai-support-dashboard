import { db, getSession, query } from './supabaseClient.js';

const ORG_KEY = 'autexa-org';
const ROLE_RANK = { viewer: 0, agent: 1, admin: 2, owner: 3 };

export const workspace = {
  user: null,
  profile: null,
  organizations: [],
  org: null,
  role: null,
  memberPrefs: {},
  isPlatformAdmin: false,
};

export const orgId = () => workspace.org?.id;

// True when the current role is at least `minimum` (viewer < agent < admin < owner).
export const can = (minimum) => (ROLE_RANK[workspace.role] ?? -1) >= ROLE_RANK[minimum];

export async function loadWorkspace() {
  const session = getSession();
  workspace.user = session?.user || null;
  if (!workspace.user) return workspace;
  await db.rpc('accept_pending_invitations').catch(() => 0);
  const [profiles, organizations, isPlatformAdmin] = await Promise.all([
    query('profiles', `select=id,full_name,email,avatar_url&id=eq.${workspace.user.id}`),
    db.rpc('my_organizations'),
    db.rpc('is_platform_admin').catch(() => false),
  ]);
  workspace.profile = profiles[0] || { id: workspace.user.id, email: workspace.user.email, full_name: workspace.user.user_metadata?.full_name };
  workspace.organizations = organizations || [];
  workspace.isPlatformAdmin = Boolean(isPlatformAdmin);
  const preferred = localStorage.getItem(ORG_KEY);
  const pick = workspace.organizations.find((org) => org.id === preferred) || workspace.organizations[0];
  if (pick) await selectOrganization(pick.id);
  else if (preferred && workspace.isPlatformAdmin) await selectOrganization(preferred).catch(() => { workspace.org = null; });
  else { workspace.org = null; workspace.role = null; }
  return workspace;
}

export async function selectOrganization(id) {
  const [org] = await query('organizations', `select=*&id=eq.${id}`);
  if (!org) throw new Error('Workspace not found');
  const role = await db.rpc('org_role', { p_org: id });
  const membership = await query('org_members', `select=notification_prefs&org_id=eq.${id}&user_id=eq.${workspace.user.id}`).catch(() => []);
  workspace.org = org;
  workspace.role = role;
  workspace.memberPrefs = membership[0]?.notification_prefs || { sound: true, browser: true, handoffs: true };
  localStorage.setItem(ORG_KEY, id);
  applyBranding(org);
  return org;
}

export async function refreshOrganization() {
  if (!orgId()) return null;
  return selectOrganization(orgId());
}

export async function createOrganization({ name, industry, timezone, locale, parentOrgId = null }) {
  const id = await db.rpc('create_organization', { p_name: name, p_industry: industry || null, p_timezone: timezone || 'UTC', p_locale: locale || 'en', p_parent: parentOrgId });
  workspace.organizations = await db.rpc('my_organizations');
  await selectOrganization(id);
  return id;
}

export const isImpersonating = () => Boolean(workspace.org && workspace.isPlatformAdmin && !workspace.organizations.some((org) => org.id === workspace.org.id));

export function applyBranding(org) {
  const root = document.documentElement;
  if (org?.brand_color && /^#[0-9a-f]{6}$/i.test(org.brand_color)) root.style.setProperty('--purple', org.brand_color);
  else root.style.removeProperty('--purple');
  document.title = `${org?.brand_name || 'Autexa'} — AI Support`;
}

export async function updateMemberPrefs(prefs) {
  workspace.memberPrefs = { ...workspace.memberPrefs, ...prefs };
  await db.update('org_members', `org_id=eq.${orgId()}&user_id=eq.${workspace.user.id}`, { notification_prefs: workspace.memberPrefs });
}
