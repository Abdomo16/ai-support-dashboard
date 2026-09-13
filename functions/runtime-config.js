export function onRequestGet(context) {
  const config = {
    url: context.env.VITE_SUPABASE_URL || '',
    publishableKey: context.env.VITE_SUPABASE_PUBLISHABLE_KEY || '',
  };

  return new Response(`export const supabaseConfig = ${JSON.stringify(config)};`, {
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'text/javascript; charset=utf-8',
    },
  });
}