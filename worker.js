// Cloudflare Worker entry: serves the public Supabase config, everything else comes from static assets.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/runtime-config.js' && env.VITE_SUPABASE_URL && env.VITE_SUPABASE_PUBLISHABLE_KEY) {
      const config = { url: env.VITE_SUPABASE_URL, publishableKey: env.VITE_SUPABASE_PUBLISHABLE_KEY };
      return new Response(`globalThis.__SUPABASE_CONFIG__ = ${JSON.stringify(config)};`, {
        headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/javascript; charset=utf-8' },
      });
    }
    return env.ASSETS.fetch(request);
  },
};
