// Builds the shared n8n workflows from the live AUTEXA workflow export.
// usage: ROUTER_KEY=<keep existing> node n8n/build-workflows.mjs <live-export.json> <out-dir> [outbox-export.json]
// Output: subscribers-ai.json, send-whatsapp.json, connector-router.json, sheets-sync.json, outbox.json,
//         template-db-sync.json, template-live-api.json, template-custom-action.json, template-dedicated-ai.json
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const [livePath, outDir] = process.argv.slice(2);
const live = JSON.parse(fs.readFileSync(livePath, 'utf8'));
const source = Array.isArray(live) ? live[0] : live;
const byName = Object.fromEntries(source.nodes.map((node) => [node.name, node]));
const PG = { postgres: { id: 'q8I2fKrXXS84GXn9', name: 'Postgres account' } };
const ROUTER_KEY = process.env.ROUTER_KEY || crypto.randomBytes(16).toString('hex');

export const IDS = {
  ai: 'AutexaSubsAI0001',
  send: 'AutexaSendWa0001',
  router: 'AutexaConnRtr001',
  sheets: 'AutexaSheetSync1',
  tplDb: 'AutexaTplDbSync1',
  tplApi: 'AutexaTplLiveApi',
  tplAction: 'AutexaTplAction1',
  tplDedicated: 'AutexaTplDedic01',
};

const sq = (expr) => `{{ String((${expr}) ?? '').replace(/'/g, "''") }}`;
const JOB = (field) => `$('Claim Job').first().json.${field}`;
const CTX = (field) => `$('Load Context').first().json.${field}`;
const JOB_IDS = `string_to_array('{{ ($('Claim Job').first().json.job_ids || []).join(',') }}', ',')::bigint[]`;
const id = () => crypto.randomUUID();
const pg = (name, query, position, extra = {}) => ({
  id: id(), name, type: 'n8n-nodes-base.postgres', typeVersion: 2.6, position, credentials: PG,
  parameters: { operation: 'executeQuery', query, options: {} }, ...extra,
});
const code = (name, jsCode, position, extra = {}) => ({
  id: id(), name, type: 'n8n-nodes-base.code', typeVersion: 2, position, parameters: { jsCode }, ...extra,
});
const link = (connections, from, to, output = 0, type = 'main') => {
  connections[from] ??= {};
  connections[from][type] ??= [];
  while (connections[from][type].length <= output) connections[from][type].push([]);
  connections[from][type][output].push({ node: to, type, index: 0 });
};
const workflow = (wfId, name, nodes, connections, settings = {}) => ({
  id: wfId, name, active: false, nodes, connections, pinData: {},
  settings: { executionOrder: 'v1', saveDataSuccessExecution: 'none', saveManualExecutions: false, callerPolicy: 'workflowsFromSameOwner', ...settings },
});
const write = (file, wf) => fs.writeFileSync(path.join(outDir, file), JSON.stringify(wf, null, 1));

// Tool SQL in the AUTEXA workflow reads ids from its Config/Prepare nodes; the shared workflow reads them from the claimed job.
function retarget(query) {
  return query
    .replaceAll("$('Config').first().json.organization_id", JOB('org_id'))
    .replaceAll("$('Prepare CRM Context').first().json.customer_id", JOB('customer_id'))
    .replaceAll("$('Prepare CRM Context').first().json.conversation_id", JOB('conversation_id'));
}
function cloneTool(name, position, edit = (p) => p) {
  const node = structuredClone(byName[name]);
  if (!node) throw new Error(`Live workflow has no node "${name}"`);
  node.id = id();
  node.position = position;
  node.parameters.query = retarget(node.parameters.query);
  node.parameters = edit(node.parameters);
  return node;
}

// ---------------------------------------------------------------------------
// Send WhatsApp (sub-workflow): { provider, config, phone_number_id, secret, to, text } -> { ok, wa_message_id, error }
// ---------------------------------------------------------------------------
{
  const nodes = [
    { id: id(), name: 'Start', type: 'n8n-nodes-base.executeWorkflowTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
    code('Build Request', String.raw`const i = $json;
const to = String(i.to || '').replace(/\D/g, '');
const c = i.config || {};
const s = i.secret || {};
const token = s.access_token || s.api_key || s.token || s.auth_token || '';
const text = String(i.text || '').slice(0, 4096);
const form = (o) => Object.entries(o).map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');
let r;
switch (i.provider) {
  case 'waha':
    r = { url: String(c.base_url || 'http://waha:3000').replace(/\/$/, '') + '/api/sendText', headers: { 'X-Api-Key': token }, content_type: 'application/json',
          body: JSON.stringify({ session: c.session || 'default', chatId: to + '@c.us', text }) };
    break;
  case '360dialog':
    r = { url: 'https://waba-v2.360dialog.io/messages', headers: { 'D360-API-KEY': token }, content_type: 'application/json',
          body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { body: text } }) };
    break;
  case 'twilio': {
    const sid = s.account_sid || c.account_sid || '';
    r = { url: 'https://api.twilio.com/2010-04-01/Accounts/' + sid + '/Messages.json', headers: { Authorization: 'Basic ' + Buffer.from(sid + ':' + token).toString('base64') },
          content_type: 'application/x-www-form-urlencoded', body: form({ From: 'whatsapp:+' + String(c.from || '').replace(/\D/g, ''), To: 'whatsapp:+' + to, Body: text }) };
    break;
  }
  case 'ultramsg':
    r = { url: 'https://api.ultramsg.com/' + (c.instance_id || '') + '/messages/chat', headers: {}, content_type: 'application/x-www-form-urlencoded',
          body: form({ token, to: '+' + to, body: text }) };
    break;
  default:
    r = { url: 'https://graph.facebook.com/v21.0/' + i.phone_number_id + '/messages', headers: { Authorization: 'Bearer ' + token }, content_type: 'application/json',
          body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { body: text, preview_url: true } }) };
}
const missing = !token || !to || !text ? (!token ? 'WhatsApp credentials are missing' : !to ? 'Recipient phone is missing' : 'Message is empty') : '';
return { json: { ...r, headers: { ...r.headers, 'Content-Type': r.content_type }, provider: i.provider || 'meta', missing, ref: i.ref ?? null } };`, [220, 0]),
    {
      id: id(), name: 'Can Send?', type: 'n8n-nodes-base.if', typeVersion: 2.2, position: [440, 0],
      parameters: {
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
          conditions: [{ id: id(), leftValue: '={{ $json.missing }}', rightValue: '', operator: { type: 'string', operation: 'empty', singleValue: true } }],
          combinator: 'and',
        },
        options: {},
      },
    },
    {
      id: id(), name: 'Send', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [660, -100],
      parameters: {
        method: 'POST', url: '={{ $json.url }}',
        sendHeaders: true, specifyHeaders: 'json', jsonHeaders: '={{ JSON.stringify($json.headers) }}',
        sendBody: true, contentType: 'raw', rawContentType: '={{ $json.content_type }}', body: '={{ $json.body }}',
        options: { timeout: 20000, response: { response: { fullResponse: true, neverError: true, responseFormat: 'json' } } },
      },
      onError: 'continueRegularOutput',
    },
    code('Result', String.raw`const req = $('Build Request').item.json;
const res = $json || {};
const status = Number(res.statusCode || 0);
let body = res.body ?? res;
if (typeof body === 'string') { try { body = JSON.parse(body); } catch {} }
const ok = status >= 200 && status < 300 && !(body && body.error);
const id = body?.messages?.[0]?.id || body?.id?._serialized || (typeof body?.id === 'string' ? body.id : '') || body?.sid || (body?.id ? String(body.id) : '') || '';
const error = ok ? '' : String(body?.error?.message || body?.message || body?.error || res.error?.message || ('HTTP ' + status)).slice(0, 500);
return { json: { ok, wa_message_id: id, error, provider: req.provider, ref: req.ref } };`, [880, -100]),
    code('Not Sent', `return { json: { ok: false, wa_message_id: '', error: $json.missing, ref: $json.ref } };`, [660, 100]),
  ];
  for (const node of nodes) if (['Build Request', 'Result', 'Not Sent'].includes(node.name)) node.parameters.mode = 'runOnceForEachItem';
  const c = {};
  link(c, 'Start', 'Build Request');
  link(c, 'Build Request', 'Can Send?');
  link(c, 'Can Send?', 'Send', 0);
  link(c, 'Can Send?', 'Not Sent', 1);
  link(c, 'Send', 'Result');
  write('send-whatsapp.json', workflow(IDS.send, 'Autexa Send WhatsApp', nodes, c));
}

// ---------------------------------------------------------------------------
// Connector router: AI tools call it over HTTP; it runs the subscriber's live-data or custom-action workflow.
// ---------------------------------------------------------------------------
{
  const nodes = [
    { id: id(), name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2.1, position: [0, 0], webhookId: id(),
      parameters: { httpMethod: 'POST', path: 'autexa-connector', responseMode: 'responseNode', options: {} } },
    pg('Resolve Target', `SELECT
  CASE WHEN '{{ $json.headers['x-autexa-key'] === '${ROUTER_KEY}' ? 'ok' : 'denied' }}' <> 'ok' THEN NULL
       WHEN '${sq("$json.body.kind")}' = 'custom_action' THEN (
         SELECT a.n8n_workflow_id FROM public.custom_actions a
          WHERE a.org_id = NULLIF('${sq('$json.body.org_id')}', '')::uuid AND a.enabled AND lower(a.name) = lower('${sq('$json.body.action')}') LIMIT 1)
       ELSE (
         SELECT d.n8n_workflow_id FROM public.data_sources d
          WHERE d.org_id = NULLIF('${sq('$json.body.org_id')}', '')::uuid AND d.kind IN ('api', 'database') AND d.config ->> 'mode' = 'live'
            AND d.status = 'active' AND d.n8n_workflow_id IS NOT NULL ORDER BY d.created_at LIMIT 1)
  END AS workflow_id,
  (SELECT d.config FROM public.data_sources d
    WHERE d.org_id = NULLIF('${sq('$json.body.org_id')}', '')::uuid AND d.kind IN ('api', 'database') AND d.config ->> 'mode' = 'live'
      AND d.status = 'active' ORDER BY d.created_at LIMIT 1) AS source_config;`, [220, 0], { alwaysOutputData: true }),
    {
      id: id(), name: 'Has Target?', type: 'n8n-nodes-base.if', typeVersion: 2.2, position: [440, 0],
      parameters: {
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
          conditions: [{ id: id(), leftValue: '={{ $json.workflow_id || "" }}', rightValue: '', operator: { type: 'string', operation: 'notEmpty', singleValue: true } }],
          combinator: 'and',
        },
        options: {},
      },
    },
    code('Build Input', `const b = $('Webhook').first().json.body || {};
let inputs = b.inputs;
if (typeof inputs === 'string') { try { inputs = JSON.parse(inputs); } catch { inputs = { text: inputs }; } }
return [{ json: { org_id: b.org_id, conversation_id: b.conversation_id, customer_id: b.customer_id, customer_phone: b.customer_phone,
  kind: b.kind, action: b.action || '', query: b.query || '', inputs: inputs || {}, source_config: $('Resolve Target').first().json.source_config || {} } }];`, [660, -100]),
    { id: id(), name: 'Run Connector', type: 'n8n-nodes-base.executeWorkflow', typeVersion: 1, position: [880, -100],
      parameters: { source: 'database', workflowId: "={{ $('Resolve Target').first().json.workflow_id }}", options: {} }, onError: 'continueRegularOutput' },
    { id: id(), name: 'Respond', type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1.1, position: [1100, -100],
      parameters: { respondWith: 'json', responseBody: '={{ JSON.stringify({ result: $input.all().map(i => i.json).slice(0, 20) }) }}', options: {} } },
    { id: id(), name: 'Respond Not Available', type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1.1, position: [660, 100],
      parameters: { respondWith: 'json', responseBody: '={{ JSON.stringify({ result: [], note: "This action or live data source is not available for this business." }) }}', options: {} } },
  ];
  const c = {};
  link(c, 'Webhook', 'Resolve Target');
  link(c, 'Resolve Target', 'Has Target?');
  link(c, 'Has Target?', 'Build Input', 0);
  link(c, 'Has Target?', 'Respond Not Available', 1);
  link(c, 'Build Input', 'Run Connector');
  link(c, 'Run Connector', 'Respond');
  write('connector-router.json', workflow(IDS.router, 'Autexa Connector Router', nodes, c));
}

// ---------------------------------------------------------------------------
// Autexa Subscribers AI: one workflow answers every subscriber whose ai_settings.workflow_key = 'shared'.
// ---------------------------------------------------------------------------
function buildAiWorkflow(wfId, name, workflowKey) {
  const historyQuery = `WITH j AS (
  SELECT '${sq(JOB('org_id'))}'::uuid AS org_id,
         '${sq(JOB('conversation_id'))}'::uuid AS conversation_id,
         NULLIF('${sq(JOB('account_id'))}', '')::uuid AS account_id,
         ${JOB_IDS} AS job_ids
),
first_new AS (
  SELECT min(m.sent_at) AS at FROM public.messages m
   WHERE m.id IN (SELECT x.message_id FROM public.ai_jobs x, j WHERE x.id = ANY (j.job_ids))
),
hist AS (
  SELECT string_agg(CASE WHEN h.direction = 'inbound' THEN 'Customer: ' ELSE 'You: ' END || left(h.content, 600), E'\\n' ORDER BY h.sent_at) AS text
    FROM (SELECT m.direction, m.content, m.sent_at FROM public.messages m, j
           WHERE m.conversation_id = j.conversation_id AND NOT m.is_internal_note AND coalesce(m.content, '') <> ''
             AND m.sent_at < coalesce((SELECT at FROM first_new), now())
           ORDER BY m.sent_at DESC LIMIT 16) h
),
acct AS (
  SELECT a.id, a.provider, a.config, a.phone_number_id, coalesce(s.secret, '{}'::jsonb) AS secret
    FROM public.whatsapp_accounts a
    CROSS JOIN j
    LEFT JOIN public.integration_secrets s ON s.org_id = a.org_id
         AND s.provider = CASE WHEN a.provider = 'meta' THEN 'whatsapp' ELSE 'whatsapp:' || a.id END
   WHERE a.org_id = j.org_id AND a.status = 'connected' AND (j.account_id IS NULL OR a.id = j.account_id)
   ORDER BY a.created_at LIMIT 1
)
SELECT public.build_ai_prompt(j.org_id) AS cfg,
       c.ai_paused, c.status AS conversation_status,
       coalesce((SELECT text FROM hist), '(no earlier messages)') AS history,
       (SELECT id FROM acct) AS account_id,
       (SELECT provider FROM acct) AS provider,
       (SELECT config FROM acct) AS wa_config,
       (SELECT phone_number_id FROM acct) AS phone_number_id,
       (SELECT secret FROM acct) AS wa_secret
  FROM j JOIN public.conversations c ON c.id = j.conversation_id;`;

  const agentSource = byName['AI Agent'];
  const agent = structuredClone(agentSource);
  agent.id = id();
  agent.position = [1100, -100];
  agent.onError = 'continueRegularOutput';
  agent.parameters.text = `=Current local time for the business: {{ $now.setZone(${CTX('cfg.timezone')} || 'UTC').toFormat('cccc yyyy-MM-dd HH:mm') }}.
Customer WhatsApp phone: {{ ${JOB('customer_phone')} }}
Customer name: {{ ${JOB('customer_name')} || 'unknown' }}

Recent conversation (oldest first):
{{ ${CTX('history')} }}

Customer Message: {{ ${JOB('incoming_text')} }}
(Reply in the same language as the Customer Message above.)`;
  agent.parameters.options = { ...(agent.parameters.options || {}), systemMessage: `={{ ${CTX('cfg.system_prompt')} }}` };

  const model = structuredClone(byName['OpenRouter Chat Model']);
  model.id = id();
  model.position = [900, 200];
  model.parameters = {
    model: `={{ ${CTX('cfg.model')} || 'deepseek/deepseek-v4-flash' }}`,
    options: { temperature: `={{ Number(${CTX('cfg.temperature')} ?? 0.3) }}` },
  };

  const enabled = (tool) => `EXISTS (SELECT 1 FROM public.ai_settings s WHERE s.org_id = '${sq(JOB('org_id'))}'::uuid AND '${tool}' = ANY (s.tools_enabled))`;
  const tools = [
    cloneTool('Search Knowledge Base', [1000, 400]),
    cloneTool('Find Service', [1120, 400]),
    cloneTool('Check Appointment Availability', [1240, 400]),
    cloneTool('Create Appointment', [1360, 400], (p) => ({ ...p, query: p.query.replace('WHERE i.starts_at > now()', `WHERE i.starts_at > now()\n  AND ${enabled('bookings')}`) })),
    cloneTool('Create Lead', [1480, 400], (p) => ({ ...p, toolDescription: p.toolDescription.replace('an AUTEXA service', 'a product or service of this business') })),
    cloneTool('Create Human Handoff', [1600, 400]),
    {
      id: id(), name: 'Search Business Data', type: 'n8n-nodes-base.postgresTool', typeVersion: 2.7, position: [1720, 400], credentials: PG,
      parameters: {
        descriptionType: 'manual',
        toolDescription: 'Search this business\'s own data (products, prices, stock, catalogues, branches, records imported from their Excel, Google Sheets or systems). Pass a short search query with the key words (product names, codes, categories). Returns matching rows as JSON. Only use values that appear in the results.',
        operation: 'executeQuery',
        query: `SELECT source, data FROM public.search_org_records('${sq(JOB('org_id'))}'::uuid, '${sq("$fromAI('query', 'Short search query: product names, codes or keywords', 'string')")}', 8);`,
        options: {},
      },
    },
    {
      id: id(), name: 'Lookup Live Data', type: 'n8n-nodes-base.httpRequestTool', typeVersion: 4.2, position: [1840, 400],
      parameters: {
        descriptionType: 'manual',
        toolDescription: 'Look up real-time information in this business\'s own system (order status, live stock, account details). Only available when the business prompt says Lookup Live Data is available. Pass what to look up, e.g. an order number or product name.',
        method: 'POST', url: 'http://127.0.0.1:5678/webhook/autexa-connector',
        sendHeaders: true, headerParameters: { parameters: [{ name: 'x-autexa-key', value: ROUTER_KEY }] },
        sendBody: true, specifyBody: 'json',
        jsonBody: `={{ JSON.stringify({ kind: 'live_data', org_id: ${JOB('org_id')}, conversation_id: ${JOB('conversation_id')}, customer_id: ${JOB('customer_id')}, customer_phone: ${JOB('customer_phone')}, query: $fromAI('query', 'What to look up, e.g. order number or product name', 'string') }) }}`,
        options: { timeout: 20000 },
      },
    },
    {
      id: id(), name: 'Run Custom Action', type: 'n8n-nodes-base.httpRequestTool', typeVersion: 4.2, position: [1960, 400],
      parameters: {
        descriptionType: 'manual',
        toolDescription: 'Run one of this business\'s custom actions listed in the prompt under CUSTOM ACTIONS AVAILABLE. Pass the exact action name and a JSON object string with the inputs it needs.',
        method: 'POST', url: 'http://127.0.0.1:5678/webhook/autexa-connector',
        sendHeaders: true, headerParameters: { parameters: [{ name: 'x-autexa-key', value: ROUTER_KEY }] },
        sendBody: true, specifyBody: 'json',
        jsonBody: `={{ JSON.stringify({ kind: 'custom_action', org_id: ${JOB('org_id')}, conversation_id: ${JOB('conversation_id')}, customer_id: ${JOB('customer_id')}, customer_phone: ${JOB('customer_phone')}, action: $fromAI('action_name', 'Exact custom action name', 'string'), inputs: $fromAI('inputs_json', 'JSON object string with the action inputs', 'string') }) }}`,
        options: { timeout: 30000 },
      },
    },
  ];

  const reply = `(String($('AI Agent').first().json.output || '').trim() || ${CTX('cfg.fallback_message')})`;
  const nodes = [
    { id: id(), name: 'Every 5 Seconds', type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2, position: [0, 0],
      parameters: { rule: { interval: [{ field: 'seconds', secondsInterval: 5 }] } } },
    pg('Claim Job', `SELECT job_ids, org_id, conversation_id, customer_id, account_id, customer_phone, customer_name, coalesce(incoming_text, '') AS incoming_text
  FROM public.claim_ai_job('${workflowKey}', 2);`, [220, 0]),
    pg('Load Context', historyQuery, [440, 0], { onError: 'continueErrorOutput' }),
    {
      id: id(), name: 'Should Answer?', type: 'n8n-nodes-base.if', typeVersion: 2.2, position: [660, -100],
      parameters: {
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
          conditions: [
            { id: id(), leftValue: '={{ $json.cfg.is_live === true && $json.cfg.org_status === "active" && $json.ai_paused !== true && !!$json.account_id }}', rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } },
          ],
          combinator: 'and',
        },
        options: {},
      },
    },
    pg('Skip Jobs', `SELECT public.finish_ai_jobs(${JOB_IDS}, 'done',
  '{{ $('Load Context').first().json.ai_paused ? 'conversation handled by a human' : !$('Load Context').first().json.account_id ? 'no connected WhatsApp number' : 'AI is not live' }}');`, [880, 100]),
    pg('Job Failed', `SELECT public.finish_ai_jobs(${JOB_IDS}, 'error', left('${sq("$json.error?.message || $json.error || 'Load Context failed'")}', 500));`, [660, 200]),
    agent,
    model,
    ...tools,
    pg('Log AI Reply', `WITH logged AS (
  INSERT INTO public.messages (org_id, conversation_id, sender_type, direction, content, is_ai_generated, ai_model, delivery_status, sent_at)
  VALUES ('${sq(JOB('org_id'))}'::uuid, '${sq(JOB('conversation_id'))}'::uuid, 'ai', 'outbound', '${sq(reply)}', true, '${sq(CTX('cfg.model'))}', 'sending', now())
  RETURNING id
),
event AS (
  INSERT INTO public.ai_events (org_id, conversation_id, kind, error)
  VALUES ('${sq(JOB('org_id'))}'::uuid, '${sq(JOB('conversation_id'))}'::uuid,
          '{{ String($('AI Agent').first().json.output || '').trim() ? 'ai_reply' : 'ai_error' }}',
          NULLIF(left('${sq("String($('AI Agent').first().json.output || '').trim() ? '' : ($('AI Agent').first().json.error?.message || $('AI Agent').first().json.error || 'AI returned no reply')")}', 500), ''))
  RETURNING id
)
SELECT id FROM logged;`, [1500, -100]),
    code('Send Payload', `const ctx = $('Load Context').first().json;
return [{ json: { provider: ctx.provider, config: ctx.wa_config || {}, phone_number_id: ctx.phone_number_id, secret: ctx.wa_secret || {},
  to: $('Claim Job').first().json.customer_phone, text: ${reply} } }];`, [1720, -100]),
    { id: id(), name: 'Send WhatsApp', type: 'n8n-nodes-base.executeWorkflow', typeVersion: 1, position: [1940, -100],
      parameters: { source: 'database', workflowId: IDS.send, options: {} }, onError: 'continueRegularOutput' },
    pg('Record Result', `WITH upd AS (
  UPDATE public.messages
     SET delivery_status = CASE WHEN {{ $json.ok === true }} THEN 'sent' ELSE 'failed' END,
         wa_message_id = COALESCE(NULLIF('${sq('$json.wa_message_id')}', ''), wa_message_id)
   WHERE id = '${sq("$('Log AI Reply').first().json.id")}'::uuid
  RETURNING org_id, conversation_id
),
err AS (
  INSERT INTO public.ai_events (org_id, conversation_id, kind, error)
  SELECT org_id, conversation_id, 'send_error', left('${sq("$json.error || 'send failed'")}', 500) FROM upd WHERE NOT {{ $json.ok === true }}
  RETURNING id
)
SELECT public.finish_ai_jobs(${JOB_IDS},
  CASE WHEN {{ $json.ok === true }} THEN 'done' ELSE 'error' END, NULLIF(left('${sq('$json.error')}', 500), ''));`, [2160, -100]),
  ];
  const c = {};
  link(c, 'Every 5 Seconds', 'Claim Job');
  link(c, 'Claim Job', 'Load Context');
  link(c, 'Load Context', 'Should Answer?', 0);
  link(c, 'Load Context', 'Job Failed', 1);
  link(c, 'Should Answer?', 'AI Agent', 0);
  link(c, 'Should Answer?', 'Skip Jobs', 1);
  link(c, 'AI Agent', 'Log AI Reply');
  link(c, 'Log AI Reply', 'Send Payload');
  link(c, 'Send Payload', 'Send WhatsApp');
  link(c, 'Send WhatsApp', 'Record Result');
  link(c, 'OpenRouter Chat Model', 'AI Agent', 0, 'ai_languageModel');
  for (const tool of tools) link(c, tool.name, 'AI Agent', 0, 'ai_tool');
  return workflow(wfId, name, nodes, c);
}
write('subscribers-ai.json', buildAiWorkflow(IDS.ai, 'Autexa Subscribers AI', 'shared'));
// Dedicated copy for a subscriber that needs its own logic: change the key, set ai_settings.workflow_key to match, then customise.
write('template-dedicated-ai.json', buildAiWorkflow(IDS.tplDedicated, 'TEMPLATE Dedicated AI (copy, set workflow key)', 'CHANGE_ME'));

// ---------------------------------------------------------------------------
// Autexa Sheets Sync: every minute, re-imports Google Sheets that are due (sheet must be shared "Anyone with the link").
// ---------------------------------------------------------------------------
const PARSE_CSV = String.raw`function parseCsv(text) {
  const rows = []; let row = []; let field = ''; let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((v) => String(v).trim() !== ''));
}`;
{
  const nodes = [
    { id: id(), name: 'Every Minute', type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2, position: [0, 0],
      parameters: { rule: { interval: [{ field: 'minutes', minutesInterval: 1 }] } } },
    pg('Due Sheets', `UPDATE public.data_sources d SET status = 'syncing', updated_at = now()
 WHERE d.id IN (
   SELECT id FROM public.data_sources
    WHERE kind = 'google_sheet' AND status IN ('active', 'error', 'syncing') AND coalesce(config ->> 'sheet_url', '') <> ''
      AND (last_sync_at IS NULL OR last_sync_at < now() - make_interval(mins => greatest(sync_interval_minutes, 5)))
    ORDER BY last_sync_at NULLS FIRST LIMIT 10)
RETURNING d.id, d.org_id, d.config;`, [220, 0]),
    code('Build URL', String.raw`const url = String($json.config?.sheet_url || '');
const id = (url.match(/\/spreadsheets\/d\/([\w-]+)/) || [])[1] || '';
const gid = (url.match(/[#&?]gid=(\d+)/) || [])[1] || '0';
return { json: { source_id: $json.id, key_column: $json.config?.key_column || '', header_row: Number($json.config?.header_row || 1),
  csv_url: id ? 'https://docs.google.com/spreadsheets/d/' + id + '/export?format=csv&gid=' + gid : '' } };`, [440, 0]),
    { id: id(), name: 'Download CSV', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [660, 0], onError: 'continueRegularOutput',
      parameters: { url: '={{ $json.csv_url }}', options: { timeout: 30000, redirect: { redirect: { followRedirects: true } },
        response: { response: { fullResponse: true, neverError: true, responseFormat: 'text' } } } } },
    code('Parse Rows', `${PARSE_CSV}
const src = $('Build URL').item.json;
const res = $json;
const status = Number(res.statusCode || 0);
const body = String(res.body ?? res.data ?? '');
if (!src.csv_url || status >= 300 || /<html/i.test(body.slice(0, 200))) {
  return { json: { source_id: src.source_id, ok: false, error: !src.csv_url ? 'Invalid Google Sheet link' : 'Could not read the sheet. Share it as "Anyone with the link can view".', rows: '[]', key_column: '' } };
}
const table = parseCsv(body);
const headerIndex = Math.max(0, src.header_row - 1);
const headers = (table[headerIndex] || []).map((h, i) => String(h).trim() || 'column_' + (i + 1));
const rows = table.slice(headerIndex + 1, headerIndex + 1 + 20000).map((r) => Object.fromEntries(headers.map((h, i) => [h, String(r[i] ?? '').trim()])));
return { json: { source_id: src.source_id, ok: true, error: '', rows: JSON.stringify(rows), key_column: src.key_column } };`, [880, 0]),
    pg('Save Rows', `UPDATE public.data_sources SET status = 'error', error = '${sq('$json.error')}', last_sync_at = now(), updated_at = now()
 WHERE id = '${sq('$json.source_id')}'::uuid AND NOT {{ $json.ok === true }};
SELECT CASE WHEN {{ $json.ok === true }}
  THEN public.replace_source_records('${sq('$json.source_id')}'::uuid, '${sq('$json.rows')}'::jsonb, NULLIF('${sq('$json.key_column')}', ''))
  ELSE 0 END AS row_count;`, [1100, 0], { onError: 'continueRegularOutput' }),
  ];
  for (const node of nodes) if (['Build URL', 'Parse Rows'].includes(node.name)) node.parameters.mode = 'runOnceForEachItem';
  const c = {};
  link(c, 'Every Minute', 'Due Sheets');
  link(c, 'Due Sheets', 'Build URL');
  link(c, 'Build URL', 'Download CSV');
  link(c, 'Download CSV', 'Parse Rows');
  link(c, 'Parse Rows', 'Save Rows');
  write('sheets-sync.json', workflow(IDS.sheets, 'Autexa Sheets Sync', nodes, c));
}

// ---------------------------------------------------------------------------
// Templates: copy per subscriber, set credentials and the SOURCE_ID, publish, then put the new workflow id
// into data_sources.n8n_workflow_id (or custom_actions.n8n_workflow_id) from the Admin Console.
// ---------------------------------------------------------------------------
{
  const note = (text, position) => ({ id: id(), name: 'How to use', type: 'n8n-nodes-base.stickyNote', typeVersion: 1, position, parameters: { content: text, width: 420, height: 260 } });

  const dbNodes = [
    note('## Database sync template\n1. Duplicate this workflow for the subscriber.\n2. Set **Read Subscriber DB** to their database credential and query (read-only user!).\n3. Replace `SOURCE_ID` in **Save Rows** with the data source id from the dashboard.\n4. Set the key column (unique id column) and publish.', [-80, -360]),
    { id: id(), name: 'Every 15 Minutes', type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2, position: [0, 0], parameters: { rule: { interval: [{ field: 'minutes', minutesInterval: 15 }] } } },
    { id: id(), name: 'Read Subscriber DB', type: 'n8n-nodes-base.postgres', typeVersion: 2.6, position: [220, 0],
      parameters: { operation: 'executeQuery', query: 'SELECT id, name, price, stock FROM products LIMIT 20000;', options: {} } },
    code('Collect Rows', `return [{ json: { rows: JSON.stringify($input.all().map((i) => i.json)) } }];`, [440, 0]),
    pg('Save Rows', `SELECT public.replace_source_records('SOURCE_ID'::uuid, '${sq('$json.rows')}'::jsonb, 'id') AS row_count;`, [660, 0]),
  ];
  const dbC = {};
  link(dbC, 'Every 15 Minutes', 'Read Subscriber DB');
  link(dbC, 'Read Subscriber DB', 'Collect Rows');
  link(dbC, 'Collect Rows', 'Save Rows');
  write('template-db-sync.json', workflow(IDS.tplDb, 'TEMPLATE Database Sync (copy per subscriber)', dbNodes, dbC));

  const apiNodes = [
    note('## Live API template\nCalled by the AI tool **Lookup Live Data** through the Connector Router.\nInput: `query`, `org_id`, `customer_phone`, `source_config`.\n1. Duplicate per subscriber, point **Call Subscriber API** at their API (add auth as a credential).\n2. Publish, then save the workflow id on the data source (mode = live).', [-80, -360]),
    { id: id(), name: 'Start', type: 'n8n-nodes-base.executeWorkflowTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
    { id: id(), name: 'Call Subscriber API', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [220, 0], onError: 'continueRegularOutput',
      parameters: { url: "={{ ($json.source_config.base_url || 'https://api.example.com') + '/search' }}", sendQuery: true,
        queryParameters: { parameters: [{ name: 'q', value: '={{ $json.query }}' }] }, options: { timeout: 15000 } } },
    code('Shape Result', `return $input.all().slice(0, 10).map((i) => ({ json: i.json }));`, [440, 0]),
  ];
  const apiC = {};
  link(apiC, 'Start', 'Call Subscriber API');
  link(apiC, 'Call Subscriber API', 'Shape Result');
  write('template-live-api.json', workflow(IDS.tplApi, 'TEMPLATE Live API Lookup (copy per subscriber)', apiNodes, apiC));

  const actionNodes = [
    note('## Custom action template\nCalled by the AI tool **Run Custom Action**.\nInput: `action`, `inputs` (object), `org_id`, `conversation_id`, `customer_id`, `customer_phone`.\nReturn one item describing the result; the AI tells the customer.\nAfter publishing, add the action (name, AI description, workflow id) in Admin Console > Workspace extras.', [-80, -360]),
    { id: id(), name: 'Start', type: 'n8n-nodes-base.executeWorkflowTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
    code('Do The Work', `const input = $json;
// Replace with the real work: call an API, write to a sheet, send an email, create an invoice...
return [{ json: { ok: true, message: 'Request received: ' + JSON.stringify(input.inputs || {}) } }];`, [220, 0]),
  ];
  const actionC = {};
  link(actionC, 'Start', 'Do The Work');
  write('template-custom-action.json', workflow(IDS.tplAction, 'TEMPLATE Custom Action (copy per subscriber)', actionNodes, actionC));
}

// ---------------------------------------------------------------------------
// Outbox: dashboard replies queued for non-Meta numbers are sent through Send WhatsApp (any provider).
// ---------------------------------------------------------------------------
const outboxPath = process.argv[4];
if (outboxPath) {
  const parsed = JSON.parse(fs.readFileSync(outboxPath, 'utf8'));
  const outbox = structuredClone(Array.isArray(parsed) ? parsed[0] : parsed);
  const keep = outbox.nodes.filter((node) => !['Send via WAHA', 'Mark Sent', 'Mark Failed'].includes(node.name));
  const claim = keep.find((node) => node.name === 'Claim Queued Messages');
  claim.parameters.query = `WITH next AS (
  SELECT m.id
  FROM public.messages m
  WHERE m.delivery_status = 'queued' AND m.direction = 'outbound' AND NOT m.is_internal_note
    AND m.sent_at > now() - interval '1 day'
    AND EXISTS (SELECT 1 FROM public.whatsapp_accounts wa WHERE wa.org_id = m.org_id AND wa.provider <> 'meta' AND wa.status = 'connected')
  ORDER BY m.sent_at
  LIMIT 10
  FOR UPDATE OF m SKIP LOCKED
),
claimed AS (
  UPDATE public.messages m SET delivery_status = 'sending'
  FROM next WHERE m.id = next.id
  RETURNING m.id, m.org_id, m.conversation_id, m.content
)
SELECT c.id, c.content, a.provider, a.config, a.phone_number_id, coalesce(s.secret, '{}'::jsonb) AS secret,
  regexp_replace(coalesce(
    (SELECT i.external_user_id FROM public.customer_channel_identities i
      WHERE i.customer_id = cv.customer_id AND i.external_user_id ~ '@(c\\.us|s\\.whatsapp\\.net)$' ORDER BY i.created_at LIMIT 1),
    cu.phone), '@.*$|\\D', '', 'g') AS to_phone
FROM claimed c
JOIN public.conversations cv ON cv.id = c.conversation_id
JOIN public.customers cu ON cu.id = cv.customer_id
LEFT JOIN LATERAL (
  SELECT wa.id, wa.provider, wa.config, wa.phone_number_id FROM public.whatsapp_accounts wa
   WHERE wa.org_id = c.org_id AND wa.provider <> 'meta' AND wa.status = 'connected' ORDER BY wa.created_at LIMIT 1
) a ON true
LEFT JOIN public.integration_secrets s ON s.org_id = c.org_id AND s.provider = 'whatsapp:' || a.id;`;
  const unreachable = keep.find((node) => node.name === 'Mark WAHA Unreachable');
  if (unreachable) unreachable.parameters.query = unreachable.parameters.query.replace("WHERE provider = 'waha'", "WHERE provider = 'waha' AND coalesce(config ->> 'base_url', 'http://waha:3000') = 'http://waha:3000'");
  const hasMessage = keep.find((node) => node.name === 'Has Message?');
  const [x, y] = hasMessage.position;
  keep.push(
    code('Send Payload', `return $input.all().map((item) => ({ json: { ref: item.json.id, provider: item.json.provider, config: item.json.config || {},
  phone_number_id: item.json.phone_number_id, secret: item.json.secret || {}, to: item.json.to_phone, text: item.json.content } }));`, [x + 220, y]),
    { id: id(), name: 'Send WhatsApp', type: 'n8n-nodes-base.executeWorkflow', typeVersion: 1, position: [x + 440, y],
      parameters: { source: 'database', workflowId: IDS.send, options: {} }, onError: 'continueRegularOutput' },
    pg('Mark Result', `UPDATE public.messages
SET delivery_status = CASE WHEN {{ $json.ok === true }} THEN 'sent' ELSE 'failed' END,
    wa_message_id = COALESCE(NULLIF('${sq('$json.wa_message_id')}', ''), wa_message_id)
WHERE id = NULLIF('${sq('$json.ref')}', '')::uuid
RETURNING id;`, [x + 660, y]),
  );
  outbox.nodes = keep;
  delete outbox.connections['Send via WAHA'];
  outbox.connections['Has Message?'] = { main: [[{ node: 'Send Payload', type: 'main', index: 0 }], []] };
  link(outbox.connections, 'Send Payload', 'Send WhatsApp');
  link(outbox.connections, 'Send WhatsApp', 'Mark Result');
  write('outbox.json', outbox);
}

fs.writeFileSync(path.join(outDir, 'router-key.txt'), ROUTER_KEY);
console.log('built workflows in', outDir);
