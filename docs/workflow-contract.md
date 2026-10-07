# AI workflow contract

Every subscriber is answered by **one shared n8n workflow** (`Autexa Subscribers AI`). A subscriber only gets a
dedicated workflow when they need logic the shared one cannot express. Both follow the same contract, so the
dashboard, database and Edge Functions never change per subscriber.

## Flow

```
WhatsApp provider ──► Edge Function (whatsapp-webhook = Meta, whatsapp-inbound = WAHA/360dialog/Twilio/UltraMsg)
                        │ stores customer + message, opt-out, CSAT, business hours, handoff keywords
                        ▼
                  public.ai_jobs  (workflow_key = ai_settings.workflow_key, default 'shared')
                        │ claim_ai_job(workflow_key) every 5 s — merges bursts, one job per conversation at a time
                        ▼
              n8n AI workflow ──► build_ai_prompt(org) ──► AI Agent + tools ──► Send WhatsApp sub-workflow
                        │
                        ▼
              messages (ai reply, delivery_status) · ai_events · finish_ai_jobs(...)
```

## What a (dedicated) AI workflow must do

| Step | SQL / call |
|------|-----------|
| Claim | `select * from public.claim_ai_job('<workflow_key>', 2)` → `job_ids, org_id, conversation_id, customer_id, account_id, customer_phone, customer_name, incoming_text` (0 rows = nothing to do) |
| Context | `public.build_ai_prompt(org_id)` → `system_prompt, model, temperature, fallback_message, is_live, org_status, tools_enabled, custom_actions, live_data_workflow_id, timezone` |
| Skip | if not `is_live`, `org_status <> 'active'`, conversation `ai_paused`, or no connected number → `finish_ai_jobs(job_ids, 'done', '<reason>')` |
| Data | always filter by `org_id`; business data via `search_org_records(org_id, query, limit)` |
| Reply | insert `messages` (`sender_type='ai'`, `direction='outbound'`, `delivery_status='sending'`), then run **Autexa Send WhatsApp** (`AutexaSendWa0001`) with `{ provider, config, phone_number_id, secret, to, text, ref }` |
| Result | update the message to `sent`/`failed`, insert `ai_events` (`ai_reply`, `ai_error`, `send_error`), then `finish_ai_jobs(job_ids, 'done' | 'error', error)` |

Never reply with an empty text: fall back to `fallback_message`.

## Routing a subscriber to a dedicated workflow

1. In n8n duplicate **TEMPLATE Dedicated AI** and replace `CHANGE_ME` in *Claim Job* with a new key, e.g. `acme`.
2. Add the custom logic (extra tools, other model, different flow) and publish it.
3. Admin Console → workspace → **Extras** → Workflow key = `acme`.

New jobs for that workspace are then claimed only by the dedicated workflow; everything else stays the same.

## Extending without forking

| Need | Use |
|------|-----|
| Different tone / rules | Workspace AI settings (business instructions) or Admin → Extras → full prompt override |
| Their products / prices / records | Business data page (Excel, Google Sheet) or a DB-sync connector |
| Live lookups (order status, stock) | Copy **TEMPLATE Live API Lookup**, publish, set the data source `mode = live` + workflow id |
| A special action (book a callback, create an invoice…) | Copy **TEMPLATE Custom Action**, publish, add it under Admin → Extras → Custom AI actions |
| Scheduled jobs (daily reports, reminders) | Build an n8n workflow, add it under Admin → Extras → Scheduled tasks (shown read-only to the client) |
| Hide / show pages | Admin → Extras → Pages enabled (`organizations.features`) |

Connector sub-workflows **must be published** in n8n, otherwise they fail with "Workflow is not active".
