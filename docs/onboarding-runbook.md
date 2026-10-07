# Onboarding a new subscriber

Everything runs on one dashboard, one Supabase project and one shared n8n AI workflow.
A new subscriber is a new **workspace** — no new workflow, no new dashboard.

## 1. Workspace

1. The client signs up on the dashboard (or you create the workspace and invite them from Settings → Team).
2. Admin Console → set their **plan**.
3. Admin Console → **Extras** (optional): hide pages they did not buy, set a prompt override, add custom actions.

## 2. WhatsApp number

| Provider | What to do |
|----------|-----------|
| WhatsApp Cloud API (Meta) | Integrations → Connect WhatsApp (Embedded Signup) or Manual setup |
| 360dialog / Twilio / UltraMsg / own WAHA | Integrations → Other WhatsApp providers → Connect provider, then paste the shown **Webhook URL** into the provider dashboard |

Inbound messages for these providers arrive through the Supabase Edge Functions `whatsapp-webhook` and
`whatsapp-inbound` (see "Deploying Edge Functions" below).

## 3. AI settings

AI agent page: persona name, tone, business instructions, model, fallback message, then switch **Live** on.
The final prompt = platform base prompt (Admin → Base AI prompt) + business details + their instructions + their data list.

## 4. Business data

* **Excel / CSV**: Business data → Upload Excel / CSV → choose columns → Import. Re-upload with "Replace file".
* **Google Sheet**: share it as "Anyone with the link (Viewer)", Business data → Google Sheet. Synced by n8n *Autexa Sheets Sync* every 5–60 minutes.
* **Their database**: they send a request from Business data → Connect your system. You:
  1. In n8n duplicate **TEMPLATE Database Sync**, set a *read-only* credential and query, replace `SOURCE_ID` with the data source id, publish.
  2. Put the new workflow id on the data source (Edit → n8n workflow ID, visible to platform admins) and set status to Active.
* **Their API (live lookups)**: duplicate **TEMPLATE Live API Lookup**, point it at their API, publish, set the data source to mode *Ask live* with the workflow id.

Test with **Test what the AI finds** on the Business data page.

## 5. Custom actions and scheduled tasks

* Custom action: duplicate **TEMPLATE Custom Action**, implement, **publish**, then Admin → Extras → Custom AI actions (name, description for the AI, inputs JSON, workflow id).
* Scheduled task: build the n8n workflow (Schedule trigger, filter by the workspace `org_id`), publish, then add it under Admin → Extras → Scheduled tasks so the client sees it on Automations.

## 6. Dedicated workflow (rare)

Only when the shared workflow cannot do it — see `docs/workflow-contract.md`.

## Deploying changes

| Part | How |
|------|-----|
| Dashboard | `git push` to the `ai-support-dashboard` branch (Cloudflare deploys automatically) |
| Database | add a file to `supabase/migrations/`, dry-run it in a rolled-back transaction, then apply |
| n8n shared workflows | `node n8n/build-workflows.mjs <live AUTEXA export> <out dir> [outbox export]` with the same `ROUTER_KEY`, then `n8n import:workflow` + `n8n publish:workflow` + restart |
| Edge Functions | `npx supabase login` with the account that owns project `qngjfrscdvjkoczdkqqq`, then `npx supabase functions deploy whatsapp-webhook whatsapp-inbound --project-ref qngjfrscdvjkoczdkqqq --no-verify-jwt` |

## n8n workflows on the VM

| ID | Name | Role |
|----|------|------|
| `xM3b7LHVPpPBwO74` | 5-fixed last | AUTEXA's own number (WAHA session `autexa`) |
| `AutexaSubsAI0001` | Autexa Subscribers AI | answers every subscriber with `workflow_key = 'shared'` |
| `AutexaSendWa0001` | Autexa Send WhatsApp | sends text through Meta, WAHA, 360dialog, Twilio or UltraMsg |
| `AutexaConnRtr001` | Autexa Connector Router | runs live-data / custom-action connector workflows for the AI |
| `AutexaSheetSync1` | Autexa Sheets Sync | re-imports Google Sheets |
| `AutexaOutbox0001` | Autexa Outbox & WhatsApp Status | sends dashboard replies for non-Meta numbers, WAHA QR/status |
| `AutexaTpl*` | TEMPLATE … | copy per subscriber |
