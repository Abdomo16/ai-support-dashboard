# Architecture

## Frontend (`src/`)

```text
src/
  main.js              # Entry: boots App
  app/                 # App.js (auth gate, workspace boot, shell, banners, search, notifications), routes.js
  components/layout/   # AppShell: sidebar nav groups, workspace switcher, top bar dropdowns
  components/          # Shared widgets (businessHours editor)
  config/              # supabase.example.js (runtime config comes from /runtime-config.js)
  features/<domain>/   # One module per page: dashboard, conversations (+Thread), handoffs, customers
                       # (+CustomerProfile), bookings, orders, ai-agent, knowledge-base, broadcasts,
                       # automations, analytics, integrations, billing, settings, onboarding, admin, auth
  i18n/                # translations.js (Proxy: ar → en → key) and locales/en.js, locales/ar.js
  lib/                 # html (esc, options), ui (modal, toast, forms), router, format, charts, csv, notify
  services/            # Data access only: PostgREST queries, RPCs, Storage and Edge Function calls
  styles/              # tokens.css (design tokens) and global.css
```

### Conventions

- **Pages.** A route maps to a feature module exporting `render(ctx)` (HTML string), `mount(root, ctx)` (wires events; may return a cleanup function) and optional `create(ctx)` for the global "+ Create" menu. `ctx` is `{ t, locale, id, rest, route, navigate, refresh, rebootShell }`.
- **Routing.** Hash routes `#/route/id/rest`. `routes.js` declares the icon, nav group, `minRole`, `platformAdmin` and badge for each route.
- **Escaping.** Every dynamic value goes through `esc()` before it reaches `innerHTML`.
- **Strings.** All visible text lives in `i18n/locales/*.js`. Dynamic keys use prefixes (`status_`, `role_`, `trigger_`, `provider_`, …). Keep `en.js` and `ar.js` key-for-key identical and keep `{placeholders}` intact.
- **Permissions.** The UI uses `can(role)` from `services/workspace.js` only to hide controls. Postgres RLS (`is_org_member`, `has_org_role`) and the Edge Functions (`requireRole`) are the real enforcement.
- **Data.** Services never render; features never call `fetch` directly. Realtime updates use `subscribe({ table, filter }, callback)`.
- **Secrets.** Provider tokens and API keys are written and read only by Edge Functions or security-definer RPCs. The browser never receives them.

## Backend (`supabase/`)

### Database (`migrations/`)

Every business table has `org_id` and RLS policies based on the caller's role in that workspace (`owner > admin > agent > viewer`). Platform admins and the service role resolve as `owner`. Analytics, search and admin pages use RPCs so aggregation happens in Postgres. Triggers write the audit log and keep usage counters.

### Edge Functions (`functions/`)

| Function | Auth | Purpose |
| --- | --- | --- |
| `whatsapp-webhook` | Meta signature | Inbound messages and statuses, AI agent replies, opt-out, CSAT answers, broadcast stats |
| `send-message` | agent | Manual replies, templates, media |
| `ai-playground` | agent | Dry-run the agent with unsaved settings |
| `conversation-insights` | agent | Summary, intent and sentiment |
| `kb-ingest` | agent | Parse, chunk and embed files, URLs and text |
| `whatsapp-connect`, `whatsapp-templates` | admin | Embedded Signup or manual number setup; template submission and sync |
| `broadcast-send` | admin | Audience estimate and send |
| `integrations`, `google-oauth` | admin / OAuth state | Verify and store provider credentials; Google Calendar OAuth |
| `payments`, `payment-webhook` | agent / provider re-fetch | Payment links; mark orders paid |
| `billing`, `stripe-webhook` | owner / Stripe signature | Platform subscriptions (Checkout, portal, sync) |
| `invite-member` | admin | Seat-limited invitations |
| `public-api` | `x-api-key` | REST API for customers' own systems |
| `scheduler` | `CRON_SECRET` | Reminders, broadcasts, automations, CSAT, insights, calendar sync, usage alerts, stale handoffs, retention, weekly reports |

The shared modules in `functions/_shared/` are:

- `agent.ts`: the AI agent loop — RAG, tools, handoff rules and PII masking.
- `whatsapp.ts` and `messaging.ts`: Graph API calls and outbound delivery, with usage and limits applied.
- `automations.ts`, `broadcasts.ts`, `csat.ts`, `reports.ts` and `reminders.ts`: scheduled work.
- `payments.ts`, `commerce.ts`, `google.ts` and `stripe.ts`: provider adapters.
- `http.ts` and `supabase.ts`: request helpers, `requireRole` and secret storage.
