import { db, invokeFunction, query } from './supabaseClient.js';
import { orgId } from './workspace.js';

export const getMembers = () => query('org_members', `select=user_id,role,created_at,profiles(full_name,email)&org_id=eq.${orgId()}&order=created_at`);
export const getInvitations = () => query('org_invitations', `select=*&org_id=eq.${orgId()}&accepted_at=is.null&order=created_at.desc`);
export const inviteMember = (email, role) => invokeFunction('invite-member', { org_id: orgId(), email, role, redirect_to: `${location.origin}${location.pathname}` });
export const revokeInvitation = (id) => db.remove('org_invitations', `id=eq.${id}`);
export const setMemberRole = (userId, role) => db.rpc('set_member_role', { p_org: orgId(), p_user: userId, p_role: role });
export const removeMember = (userId) => db.rpc('remove_member', { p_org: orgId(), p_user: userId });

export const memberName = (member) => member?.profiles?.full_name || member?.profiles?.email || '';
