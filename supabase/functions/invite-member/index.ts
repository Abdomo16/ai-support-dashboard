import { HttpError, env, json, readJson, serve } from '../_shared/http.ts';
import { admin, must, requireRole } from '../_shared/supabase.ts';
import { sendEmail } from '../_shared/reports.ts';

type Body = { org_id: string; email: string; role: 'owner' | 'admin' | 'agent' | 'viewer'; redirect_to?: string };

serve(async (request) => {
  const body = await readJson<Body>(request);
  const { user, role: myRole } = await requireRole(request, body.org_id, 'admin');
  const email = String(body.email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'A valid email is required');
  if (!['owner', 'admin', 'agent', 'viewer'].includes(body.role)) throw new HttpError(400, 'Invalid role');
  if (body.role === 'owner' && myRole !== 'owner') throw new HttpError(403, 'Only owners can invite owners');

  const [{ count: members }, { count: pending }, { data: sub }, { data: org }] = await Promise.all([
    admin.from('org_members').select('user_id', { count: 'exact', head: true }).eq('org_id', body.org_id),
    admin.from('org_invitations').select('id', { count: 'exact', head: true }).eq('org_id', body.org_id).is('accepted_at', null).neq('email', email),
    admin.from('subscriptions').select('plans(limits)').eq('org_id', body.org_id).maybeSingle(),
    admin.from('organizations').select('name, brand_name').eq('id', body.org_id).single(),
  ]);
  const seats = Number((sub?.plans as { limits?: { seats?: number } } | null)?.limits?.seats ?? 2);
  if ((members || 0) + (pending || 0) >= seats) throw new HttpError(402, `Your plan includes ${seats} seats. Upgrade to invite more teammates.`);

  must(await admin.from('org_invitations').upsert({ org_id: body.org_id, email, role: body.role, invited_by: user.id, accepted_at: null }, { onConflict: 'org_id,email' }));

  const appUrl = env('APP_URL');
  const redirectTo = body.redirect_to && (!appUrl || body.redirect_to.startsWith(appUrl) || /^http:\/\/localhost(:\d+)?\//.test(body.redirect_to)) ? body.redirect_to : appUrl || undefined;
  const { data: existing } = await admin.from('profiles').select('id').ilike('email', email).maybeSingle();
  const workspaceName = org?.brand_name || org?.name || 'a workspace';

  if (existing) {
    // Existing users join right away; the invitation row records who invited them.
    must(await admin.from('org_members').upsert({ org_id: body.org_id, user_id: existing.id, role: body.role }, { onConflict: 'org_id,user_id', ignoreDuplicates: true }));
    await admin.from('org_invitations').update({ accepted_at: new Date().toISOString() }).eq('org_id', body.org_id).eq('email', email);
    await sendEmail([email], `You were added to ${workspaceName}`, `<p>You now have access to <b>${workspaceName.replace(/</g, '&lt;')}</b> on Autexa.</p>${redirectTo ? `<p><a href="${redirectTo}">Open the dashboard</a></p>` : ''}`);
    return json({ added: true });
  }

  const { error } = await admin.auth.admin.inviteUserByEmail(email, { redirectTo, data: { invited_to: body.org_id } });
  if (error && !/already/i.test(error.message)) throw new HttpError(400, error.message);
  return json({ invited: true });
});
