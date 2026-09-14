// Static fallback configuration so the dashboard works on any static host
// (Cloudflare Pages, GitHub clone without .env) with real Supabase data.
// The publishable key is a public client-side key; data access is protected by RLS.
// server.mjs overrides these values from .env when running locally.
export const supabaseConfig = {
  url: 'https://qngjfrscdvjkoczdkqqq.supabase.co',
  publishableKey: 'sb_publishable_4JtAoeGjpUr1kOnHP-2loA_pHkFfZzh',
};
