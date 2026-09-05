import { supabaseConfig } from '/runtime-config.js';

export async function query(table, query = '') {
  if (!supabaseConfig.url || !supabaseConfig.publishableKey) throw new Error('Supabase is not configured.');
  const response = await fetch(`${supabaseConfig.url}/rest/v1/${table}?${query}`, {
    headers: {
      apikey: supabaseConfig.publishableKey,
      Authorization: `Bearer ${supabaseConfig.publishableKey}`,
      Accept: 'application/json',
    },
  });
  if (!response.ok) throw new Error(`Supabase request failed (${response.status}).`);
  return response.json();
}
