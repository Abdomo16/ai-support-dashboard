import { createClient } from 'npm:@supabase/supabase-js@2';
import { HttpError, requireEnv } from './http.ts';

export const admin = createClient(requireEnv('SUPABASE_URL'), requireEnv('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { persistSession: false, autoRefreshToken: false },
});

const RANK: Record<string, number> = { viewer: 0, agent: 1, admin: 2, owner: 3 };

export async function requireUser(request: Request) {
  const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) throw new HttpError(401, 'Not authenticated');
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) throw new HttpError(401, 'Not authenticated');
  return { user: data.user, token };
}

// Resolves the caller's role through the same org_role() used by RLS (covers agencies and platform admins).
export async function requireRole(request: Request, orgId: unknown, minimum: 'viewer' | 'agent' | 'admin' | 'owner' = 'agent') {
  if (typeof orgId !== 'string' || !orgId) throw new HttpError(400, 'org_id is required');
  const { user, token } = await requireUser(request);
  const client = createClient(requireEnv('SUPABASE_URL'), requireEnv('SUPABASE_ANON_KEY'), {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false },
  });
  const { data: role } = await client.rpc('org_role', { p_org: orgId });
  if (!role || RANK[role] < RANK[minimum]) throw new HttpError(403, 'You do not have permission for this action');
  const { data: org } = await admin.from('organizations').select('status').eq('id', orgId).single();
  if (org?.status === 'suspended' && minimum !== 'viewer') throw new HttpError(403, 'This workspace is suspended');
  return { user, role: role as string };
}

export function must<T>(result: { data: T | null; error: { message: string } | null }, notFoundMessage?: string): T {
  if (result.error) throw new HttpError(500, result.error.message);
  if (result.data === null && notFoundMessage) throw new HttpError(404, notFoundMessage);
  return result.data as T;
}

export async function getSecret<T = Record<string, string>>(orgId: string, provider: string): Promise<T | null> {
  const { data } = await admin.from('integration_secrets').select('secret').eq('org_id', orgId).eq('provider', provider).maybeSingle();
  return (data?.secret as T) ?? null;
}

export async function setSecret(orgId: string, provider: string, secret: Record<string, unknown>) {
  const existing = (await getSecret(orgId, provider)) || {};
  must(await admin.from('integration_secrets').upsert({ org_id: orgId, provider, secret: { ...existing, ...secret }, updated_at: new Date().toISOString() }));
}

export async function getIntegration(orgId: string, provider: string) {
  const { data } = await admin.from('integrations').select('*').eq('org_id', orgId).eq('provider', provider).eq('status', 'connected').maybeSingle();
  return data;
}

export async function upsertIntegration(orgId: string, provider: string, config: Record<string, unknown> = {}, status = 'connected') {
  must(await admin.from('integrations').upsert({ org_id: orgId, provider, config, status, error: null, connected_at: new Date().toISOString() }, { onConflict: 'org_id,provider' }));
}
