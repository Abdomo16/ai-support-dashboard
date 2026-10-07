import { db } from './supabaseClient.js';
import { orgId } from './workspace.js';

export const globalSearch = (term) => db.rpc('global_search', { p_org: orgId(), p_term: term });
