# Autexa — AI WhatsApp customer service

Autexa is a multi-tenant SaaS: each business gets a workspace with its own WhatsApp number, AI agent, knowledge base, team, bookings, orders, broadcasts and automations. The dashboard is bilingual (English / Arabic, RTL) and has no build step — it is plain ES modules served as static assets.

- **Frontend:** `index.html` + `src/` (vanilla JS, hash routing), hosted as Cloudflare Worker static assets. `worker.js` serves `/runtime-config.js` with the public Supabase settings.
- **Backend:** Supabase — Postgres with row-level security per workspace, Auth, Storage, Realtime and Deno Edge Functions in `supabase/functions`.

See `docs/architecture.md` for the code map and conventions.

## Run locally

```powershell
node server.mjs        # http://127.0.0.1:4173
```

`server.mjs` reads `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` from `.env` (excluded from Git) and exposes only these public values at `/runtime-config.js`.

## Deploy the frontend

```powershell
npm run build          # copies index.html and src/ into dist/
npx wrangler deploy
```

Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` as Worker variables.

## Set up Supabase

1. **Database.** Apply the migrations in order (`supabase db push`, or paste them into the SQL editor):
   - `20261007000100_tenancy.sql` — organizations, members, roles, invitations, plans, subscriptions, usage, audit log, RLS helpers.
   - `20261007000200_features.sql` — conversations, handoffs, bookings, knowledge base (pgvector), broadcasts, templates, automations, integrations, orders, CSAT, API keys.
   - `20261007000300_functions.sql` — RPCs (analytics, search, admin), triggers, the Realtime publication and Storage buckets (`media`, `knowledge`, `branding`).
2. **Auth.** Enable Email (and Google, if you want "Continue with Google"). Add your app URL to the redirect allow-list.
3. **Edge Functions.** Deploy all functions:

   ```powershell
   supabase functions deploy ai-playground billing broadcast-send conversation-insights integrations invite-member kb-ingest payments send-message whatsapp-connect whatsapp-templates
   supabase functions deploy whatsapp-webhook stripe-webhook payment-webhook google-oauth public-api scheduler --no-verify-jwt
   ```

   The second group is called by WhatsApp, Stripe, payment providers, Google, API clients and the scheduler, so they skip JWT verification and authenticate with signatures, API keys or `CRON_SECRET` instead.
4. **Secrets.** Run `supabase secrets set NAME=value` for each of these:

   | Secret | Purpose |
   | --- | --- |
   | `AI_API_KEY` (or `OPENAI_API_KEY`), `AI_BASE_URL` | Any OpenAI-compatible API. `EMBEDDING_MODEL` and `TRANSCRIPTION_MODEL` are optional. |
   | `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`, `WHATSAPP_GRAPH_VERSION` | Webhook verification and signature check (Graph version defaults to `v21.0`). |
   | `META_APP_ID`, `META_APP_SECRET`, `META_CONFIG_ID` | WhatsApp Embedded Signup. |
   | `WA_TEMPLATE_COST_USD` | Estimated cost per template message, used for usage and margins (default `0.03`). |
   | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google Calendar sync. The redirect URI is `https://<project>.supabase.co/functions/v1/google-oauth`. |
   | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Platform subscriptions. Set `stripe_price_id` on each row of `plans`. |
   | `RESEND_API_KEY`, `EMAIL_FROM` | Weekly reports, usage alerts and invitation emails. |
   | `APP_URL` | Public dashboard URL, used in emails and redirects. |
   | `PAYMENT_RETURN_URL` | Optional customer-facing page after paying an order (defaults to `APP_URL`). |
   | `CRON_SECRET` | Shared secret for the `scheduler` function. |

5. **Webhooks.**
   - **WhatsApp:** set the callback URL to `https://<project>.supabase.co/functions/v1/whatsapp-webhook` with your `WHATSAPP_VERIFY_TOKEN`, and subscribe to `messages`. Embedded Signup subscribes each workspace's WABA automatically.
   - **Stripe (platform billing):** send `checkout.session.completed`, `customer.subscription.*` and `invoice.payment_failed` events to `/functions/v1/stripe-webhook`.
   - **Workspace payment providers** (Stripe, Paymob, Tap) call `/functions/v1/payment-webhook`. The URL is attached to each payment link automatically.
6. **Scheduled jobs.** With `pg_cron` and `pg_net` enabled, schedule the `scheduler` function:

   ```sql
   select cron.schedule('autexa-frequent', '*/5 * * * *', $$
     select net.http_post('https://<project>.supabase.co/functions/v1/scheduler',
       headers => '{"Content-Type":"application/json","x-cron-secret":"<CRON_SECRET>"}'::jsonb, body => '{}'::jsonb) $$);
   select cron.schedule('autexa-retention', '15 2 * * *', $$
     select net.http_post('https://<project>.supabase.co/functions/v1/scheduler',
       headers => '{"Content-Type":"application/json","x-cron-secret":"<CRON_SECRET>"}'::jsonb, body => '{"jobs":["retention"]}'::jsonb) $$);
   select cron.schedule('autexa-weekly', '0 6 * * 1', $$
     select net.http_post('https://<project>.supabase.co/functions/v1/scheduler',
       headers => '{"Content-Type":"application/json","x-cron-secret":"<CRON_SECRET>"}'::jsonb, body => '{"jobs":["weekly_report"]}'::jsonb) $$);
   ```

   The default (5-minute) run covers booking reminders, scheduled broadcasts, automations, CSAT requests, conversation summaries, Google Calendar sync, usage alerts and stale handoffs.
7. **Platform admins.** To grant someone the admin console (every workspace, plans, suspension, impersonation), run:

   ```sql
   insert into public.platform_admins (user_id) select id from auth.users where email = 'you@example.com';
   ```

   If you have data from before multi-tenancy, use **Admin console → Claim legacy data** to move it into a workspace.

## Public API

Workspace admins create API keys in **Settings → API**. Requests are `POST https://<project>.supabase.co/functions/v1/public-api` with the `x-api-key` header and a JSON body such as `{"action":"send_message","phone":"+9665…","text":"Hi"}`. The actions are `send_message`, `send_template`, `upsert_customer`, `get_customer`, `create_booking` and `list_conversations`.
