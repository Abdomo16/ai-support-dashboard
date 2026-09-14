// Static Supabase configuration — works on any static host, Cloudflare, or a
// plain clone without .env. The publishable key is a public client-side key;
// data access is protected by RLS. server.mjs overrides these values from
// .env when running locally.
globalThis.__SUPABASE_CONFIG__ = {
  url: 'https://qngjfrscdvjkoczdkqqq.supabase.co',
  publishableKey: 'sb_publishable_4JtAoeGjpUr1kOnHP-2loA_pHkFfZzh',
};
