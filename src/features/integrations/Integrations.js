import { esc } from '../../lib/html.js';
import { href } from '../../lib/router.js';
import { formatDateTime, timeAgo } from '../../lib/format.js';
import { confirmDialog, emptyRow, field, loadingRow, openModal, toast, toastError } from '../../lib/ui.js';
import {
  WHATSAPP_PROVIDERS, connectWhatsAppProvider, disconnectWhatsAppProvider, whatsappInboundUrl,
  connectIntegration, connectWhatsAppManual, disconnectIntegration, disconnectWhatsAppAccount, listIntegrations, listWhatsAppAccounts,
  publicApiUrl, runEmbeddedSignup, sendTestEvent, setDefaultPayment, startGoogleOAuth, whatsappConfig,
} from '../../services/integrations.js';

const EVENTS = ['message.received', 'message.sent', 'conversation.resolved', 'handoff.requested', 'customer.created', 'booking.created', 'order.created', 'order.paid', 'csat.received', 'automation.fired'];
const PAYMENTS = ['stripe', 'paymob', 'tap'];

const providers = (t) => ({
  shopify: {
    group: 'commerce', icon: 'S',
    fields: [
      { name: 'shop_domain', label: t.shopDomain, placeholder: 'mystore.myshopify.com', required: true, target: 'config' },
      { name: 'access_token', label: t.adminApiToken, type: 'password', required: true, target: 'secret', hint: t.shopifyTokenHint },
    ],
  },
  woocommerce: {
    group: 'commerce', icon: 'W',
    fields: [
      { name: 'site_url', label: t.siteUrl, type: 'url', placeholder: 'https://shop.example.com', required: true, target: 'config' },
      { name: 'consumer_key', label: t.consumerKey, required: true, target: 'secret' },
      { name: 'consumer_secret', label: t.consumerSecret, type: 'password', required: true, target: 'secret' },
    ],
  },
  google_sheets: {
    group: 'data', icon: '▦',
    fields: [{ name: 'url', label: t.appsScriptUrl, type: 'url', required: true, target: 'config', hint: t.sheetsHint }],
    events: true,
  },
  webhook: {
    group: 'data', icon: '⚡',
    fields: [{ name: 'url', label: t.webhookUrl, type: 'url', required: true, target: 'config', hint: t.webhookHint }],
    events: true,
  },
  stripe: {
    group: 'payments', icon: '$',
    fields: [{ name: 'secret_key', label: t.secretKey, type: 'password', required: true, target: 'secret', placeholder: 'sk_live_…', hint: t.stripeKeyHint }],
  },
  paymob: {
    group: 'payments', icon: 'P',
    fields: [
      { name: 'api_key', label: t.apiKey, type: 'password', required: true, target: 'secret' },
      { name: 'secret_key', label: t.secretKey, type: 'password', required: true, target: 'secret' },
      { name: 'public_key', label: t.publicKey, required: true, target: 'secret' },
      { name: 'integration_id', label: t.integrationIds, required: true, target: 'secret', hint: t.paymobIntegrationHint },
      { name: 'base_url', label: t.region, type: 'select', target: 'secret', options: [['https://accept.paymob.com', 'Egypt'], ['https://ksa.paymob.com', 'Saudi Arabia'], ['https://uae.paymob.com', 'UAE'], ['https://oman.paymob.com', 'Oman']] },
    ],
  },
  tap: {
    group: 'payments', icon: 'T',
    fields: [{ name: 'secret_key', label: t.secretKey, type: 'password', required: true, target: 'secret', placeholder: 'sk_live_…' }],
  },
});

export function render({ t }) {
  return `
    <div class="page-heading">
      <div><p class="eyebrow">${esc(t.connectEyebrow)}</p><h1>${esc(t.integrations)}</h1><p>${esc(t.integrationsSubtitle)}</p></div>
    </div>
    <div id="integrations-body">${loadingRow(t.loading)}</div>`;
}

export async function mount(root, ctx) {
  const { t } = ctx;
  const body = root.querySelector('#integrations-body');
  const status = new URLSearchParams(location.hash.split('?')[1] || '').get('google');
  if (status) {
    toast(t[`google_${status}`] || status, status === 'connected' ? 'success' : 'error');
    history.replaceState(null, '', href('integrations'));
  }
  let integrations = [];
  let accounts = [];
  try { [integrations, accounts] = await Promise.all([listIntegrations(), listWhatsAppAccounts()]); } catch (error) { body.innerHTML = emptyRow(error.message); return; }
  const byProvider = Object.fromEntries(integrations.map((row) => [row.provider, row]));
  const connected = (provider) => byProvider[provider]?.status === 'connected';
  const specs = providers(t);
  const card = (provider, extra = '') => {
    const row = byProvider[provider];
    const isOn = connected(provider);
    return `
      <article class="integration-card ${isOn ? 'connected' : ''}">
        <div class="integration-head"><span class="integration-icon">${esc(specs[provider]?.icon || '•')}</span><div><strong>${esc(t[`provider_${provider}`])}</strong><small>${esc(t[`provider_${provider}_desc`])}</small></div></div>
        ${isOn ? `<p class="integration-meta"><span class="status resolved">${esc(t.connected)}</span>${row.config?.default ? ` <span class="tag">${esc(t.defaultProvider)}</span>` : ''}${row.config?.shop_name ? ` · ${esc(row.config.shop_name)}` : ''}${row.config?.mode === 'test' ? ` · <span class="tag tag-warn">${esc(t.testMode)}</span>` : ''}${row.last_sync_at ? ` · ${esc(t.lastSync)} ${esc(timeAgo(row.last_sync_at))}` : ''}</p>` : ''}
        ${row?.error ? `<p class="danger-text small-text">${esc(row.error)}</p>` : ''}
        ${extra}
        <div class="row-actions">
          ${isOn
    ? `${PAYMENTS.includes(provider) && !row.config?.default ? `<button class="ghost-btn" data-default="${provider}">${esc(t.makeDefault)}</button>` : ''}
               ${['webhook', 'google_sheets'].includes(provider) ? `<button class="ghost-btn" data-test="${provider}">${esc(t.sendTest)}</button>` : ''}
               <button class="ghost-btn" data-configure="${provider}">${esc(t.edit)}</button>
               <button class="ghost-btn danger-text" data-disconnect="${provider}">${esc(t.disconnect)}</button>`
    : `<button class="create small" data-configure="${provider}">${esc(t.connect)}</button>`}
        </div>
      </article>`;
  };
  const activeAccounts = accounts.filter((account) => account.status === 'connected');
  const wahaAccounts = accounts.filter((account) => account.provider === 'waha');

  body.innerHTML = `
    ${wahaAccounts.length ? wahaPanel(wahaAccounts, t) : `
    <section class="panel whatsapp-panel">
      <div class="panel-head"><div><h2>${esc(t.provider_whatsapp)}</h2><p>${esc(t.whatsappConnectHelp)}</p></div>
        <div class="heading-actions"><button class="ghost-btn" id="wa-manual">${esc(t.manualSetup)}</button><button class="create" id="wa-embedded">${esc(activeAccounts.length ? t.addNumber : t.connectWhatsApp)}</button></div>
      </div>
      <div class="simple-list">${activeAccounts.length ? activeAccounts.map((account) => `
        <div class="list-row">
          <div><strong>${esc(account.display_phone || account.phone_number_id)} ${account.verified_name ? `· ${esc(account.verified_name)}` : ''}</strong>
          <small>${esc(t.phoneNumberId)}: ${esc(account.phone_number_id)}${account.waba_id ? ` · WABA ${esc(account.waba_id)}` : ''} · ${esc(account.last_webhook_at ? `${t.lastMessage} ${timeAgo(account.last_webhook_at)}` : t.noWebhookYet)}</small></div>
          <div class="row-actions"><span class="status resolved">${esc(t.connected)}</span><button class="ghost-btn danger-text" data-wa-disconnect="${account.id}">${esc(t.disconnect)}</button></div>
        </div>`).join('') : emptyRow(t.noWhatsAppNumber)}</div>
      <details class="webhook-details"><summary>${esc(t.webhookSetup)}</summary><div id="wa-config">${loadingRow(t.loading)}</div></details>
    </section>`}
    ${providerPanel(accounts.filter((account) => account.provider !== 'meta' && account.status === 'connected' && !(account.provider === 'waha' && account.config?.base_url === 'http://waha:3000')), t)}
    ${['scheduling', 'commerce', 'payments', 'data'].map((group) => `
      <h2 class="section-title">${esc(t[`integrationGroup_${group}`])}</h2>
      <section class="integration-grid">
        ${group === 'scheduling' ? card('google_calendar') : ''}
        ${Object.entries(specs).filter(([, spec]) => spec.group === group).map(([provider]) => card(provider)).join('')}
        ${group === 'data' ? `<article class="integration-card"><div class="integration-head"><span class="integration-icon">{ }</span><div><strong>${esc(t.publicApi)}</strong><small>${esc(t.publicApiDesc)}</small></div></div><code class="mono small-text">${esc(publicApiUrl())}</code><div class="row-actions"><a class="ghost-btn" href="${href('settings', 'api')}">${esc(t.manageApiKeys)}</a></div></article>` : ''}
      </section>`).join('')}`;

  body.querySelector('details.webhook-details')?.addEventListener('toggle', async (event) => {
    if (!event.target.open || event.target.dataset.loaded) return;
    event.target.dataset.loaded = '1';
    try {
      const config = await whatsappConfig();
      body.querySelector('#wa-config').innerHTML = `<dl class="details"><dt>${esc(t.callbackUrl)}</dt><dd><code class="mono">${esc(config.webhook_url)}</code></dd><dt>${esc(t.verifyToken)}</dt><dd>${esc(config.verify_token_set ? t.verifyTokenSet : t.verifyTokenMissing)}</dd><dt>${esc(t.subscribeFields)}</dt><dd><code>messages</code></dd></dl>`;
    } catch (error) { body.querySelector('#wa-config').innerHTML = emptyRow(error.message); }
  });

  body.querySelector('#wa-embedded')?.addEventListener('click', async (event) => {
    event.target.disabled = true;
    try {
      await runEmbeddedSignup(await whatsappConfig());
      toast(t.whatsappConnected, 'success');
      ctx.refresh();
    } catch (error) { toastError(error); event.target.disabled = false; }
  });
  body.querySelector('#wa-manual')?.addEventListener('click', () => openModal({
    title: t.manualSetup,
    html: `<p class="muted-text">${esc(t.manualSetupHelp)}</p>`,
    fields: [
      { name: 'phone_number_id', label: t.phoneNumberId, required: true },
      { name: 'waba_id', label: t.wabaId, hint: t.wabaIdHint },
      { name: 'access_token', label: t.permanentToken, type: 'password', required: true, full: true, hint: t.permanentTokenHint },
    ],
    submitLabel: t.connect,
    onSubmit: async (values) => { await connectWhatsAppManual(values); toast(t.whatsappConnected, 'success'); ctx.refresh(); },
  }));

  body.querySelector('#wa-provider')?.addEventListener('click', () => openProviderConnect(t, () => ctx.refresh()));

  body.addEventListener('click', async (event) => {
    const target = event.target.closest('[data-configure],[data-disconnect],[data-default],[data-test],[data-wa-disconnect],[data-wa-webhook],[data-wa-remove]');
    if (!target) return;
    try {
      if (target.dataset.waWebhook) showInboundUrl(t, await whatsappInboundUrl(target.dataset.waWebhook));
      if (target.dataset.waRemove && await confirmDialog(t.disconnectWhatsAppConfirm)) {
        await disconnectWhatsAppProvider(target.dataset.waRemove);
        ctx.refresh();
      }
      if (target.dataset.waDisconnect && await confirmDialog(t.disconnectWhatsAppConfirm)) {
        await disconnectWhatsAppAccount(target.dataset.waDisconnect);
        ctx.refresh();
      }
      if (target.dataset.configure) {
        const provider = target.dataset.configure;
        if (provider === 'google_calendar') openGoogleForm(t, byProvider.google_calendar);
        else openProviderForm(t, provider, specs[provider], byProvider[provider], () => ctx.refresh());
      }
      if (target.dataset.disconnect && await confirmDialog(t.disconnectConfirm.replace('{name}', t[`provider_${target.dataset.disconnect}`]))) {
        await disconnectIntegration(target.dataset.disconnect);
        ctx.refresh();
      }
      if (target.dataset.default) { await setDefaultPayment(target.dataset.default); ctx.refresh(); }
      if (target.dataset.test) { target.disabled = true; await sendTestEvent(target.dataset.test); toast(t.testEventSent, 'success'); target.disabled = false; }
    } catch (error) { toastError(error); target.disabled = false; }
  });

  // n8n refreshes the WAHA session status (and QR code) every minute; poll while a number needs attention.
  if (!wahaAccounts.some((account) => account.status !== 'connected')) return undefined;
  const poll = setInterval(async () => {
    const latest = await listWhatsAppAccounts().catch(() => null);
    if (latest?.some((account) => account.provider === 'waha' && account.status === 'connected')) ctx.refresh();
    else if (latest) body.querySelector('.whatsapp-panel').outerHTML = wahaPanel(latest.filter((account) => account.provider === 'waha'), t);
  }, 15000);
  return () => clearInterval(poll);
}

function providerPanel(accounts, t) {
  return `
    <section class="panel">
      <div class="panel-head"><div><h2>${esc(t.otherWhatsAppProviders)}</h2><p>${esc(t.otherWhatsAppProvidersHelp)}</p></div>
        <div class="heading-actions"><button class="ghost-btn" id="wa-provider">＋ ${esc(t.connectProvider)}</button></div></div>
      <div class="simple-list">${accounts.map((account) => `
        <div class="list-row">
          <div><strong>${esc(account.display_phone || account.phone_number_id)}${account.verified_name ? ` · ${esc(account.verified_name)}` : ''} <span class="tag">${esc(t[`waProvider_${account.provider}`] || account.provider)}</span></strong>
            <small>${esc(account.last_webhook_at ? `${t.lastMessage} ${timeAgo(account.last_webhook_at)}` : t.noWebhookYet)}</small></div>
          <div class="row-actions"><button class="ghost-btn" data-wa-webhook="${account.id}">${esc(t.inboundWebhookUrl)}</button><button class="ghost-btn danger-text" data-wa-remove="${account.id}">${esc(t.disconnect)}</button></div>
        </div>`).join('') || emptyRow(t.noOtherProviders)}</div>
    </section>`;
}

const PROVIDER_FIELDS = {
  '360dialog': (t) => [{ name: 'api_key', label: t.apiKey, type: 'password', required: true, full: true }],
  twilio: (t) => [
    { name: 'account_sid', label: 'Account SID', required: true },
    { name: 'auth_token', label: 'Auth token', type: 'password', required: true },
    { name: 'from', label: t.twilioFrom, required: true, placeholder: '+14155238886' },
  ],
  ultramsg: (t) => [
    { name: 'instance_id', label: t.instanceId, required: true, placeholder: 'instance12345' },
    { name: 'token', label: t.apiToken, type: 'password', required: true },
  ],
  waha: (t) => [
    { name: 'base_url', label: t.serverUrl, type: 'url', required: true, placeholder: 'https://waha.example.com' },
    { name: 'session', label: t.sessionName, required: true, value: 'default' },
    { name: 'api_key', label: t.apiKey, type: 'password', required: true },
  ],
};

function openProviderConnect(t, onSaved) {
  openModal({
    title: t.connectProvider,
    wide: true,
    html: `<p class="muted-text">${esc(t.connectProviderHelp)}</p><div class="form-grid" id="provider-fields"></div>`,
    fields: [
      { name: 'provider', label: t.provider, type: 'select', value: '360dialog', options: WHATSAPP_PROVIDERS.map((provider) => [provider, t[`waProvider_${provider}`] || provider]) },
      { name: 'display_phone', label: t.whatsappNumber, required: true, placeholder: '+201001234567' },
      { name: 'name', label: t.businessName },
    ],
    submitLabel: t.connect,
    onMount: (form) => {
      const draw = () => { form.querySelector('#provider-fields').innerHTML = PROVIDER_FIELDS[form.querySelector('[name="provider"]').value](t).map(field).join(''); };
      form.querySelector('[name="provider"]').addEventListener('change', draw);
      draw();
    },
    onSubmit: async (values) => {
      const accountId = await connectWhatsAppProvider(values);
      toast(t.whatsappConnected, 'success');
      onSaved();
      showInboundUrl(t, await whatsappInboundUrl(accountId));
    },
  });
}

function showInboundUrl(t, url) {
  openModal({
    title: t.inboundWebhookUrl,
    hideSubmit: true,
    html: `<p class="muted-text">${esc(t.inboundWebhookHelp)}</p><code class="mono small-text block">${esc(url)}</code><p class="muted-text small-text">${esc(t.inboundWebhookDeployNote)}</p>`,
  });
}

function wahaPanel(accounts, t) {
  return `
    <section class="panel whatsapp-panel">
      <div class="panel-head"><div><h2>${esc(t.provider_whatsapp)}</h2><p>${esc(t.wahaHelp)}</p></div></div>
      <div class="simple-list">${accounts.map((account) => `
        <div class="list-row">
          <div><strong>${esc(account.display_phone || account.session)}${account.verified_name ? ` · ${esc(account.verified_name)}` : ''}</strong>
            <small>${esc(account.last_webhook_at ? `${t.lastMessage} ${timeAgo(account.last_webhook_at)}` : t.noWebhookYet)}${account.status_detail && account.status !== 'connected' ? ` · ${esc(account.status_detail)}` : ''}</small></div>
          <div class="row-actions"><span class="status ${account.status === 'connected' ? 'resolved' : 'pending'}">${esc(account.status === 'connected' ? t.connected : t.whatsappDisconnected)}</span></div>
        </div>
        ${account.status !== 'connected' && account.qr_code ? `<div class="qr-box"><img src="${esc(account.qr_code)}" alt="" width="240" height="240" /><p class="muted-text">${esc(t.scanQrHelp)}</p></div>` : ''}`).join('')}
      </div>
    </section>`;
}

function openGoogleForm(t, existing) {
  openModal({
    title: t.provider_google_calendar,
    html: `<p class="muted-text">${esc(t.googleCalendarHelp)}</p>${existing?.connected_at ? `<p class="small-text">${esc(t.connectedSince)} ${esc(formatDateTime(existing.connected_at))}</p>` : ''}`,
    fields: [{ name: 'calendar_id', label: t.calendarId, value: existing?.config?.calendar_id || 'primary', hint: t.calendarIdHint }],
    submitLabel: t.continueWithGoogle,
    onSubmit: async (values) => {
      const { url } = await startGoogleOAuth(values.calendar_id || 'primary');
      location.href = url;
      return false;
    },
  });
}

function openProviderForm(t, provider, spec, existing, onSaved) {
  const config = existing?.config || {};
  openModal({
    title: `${t.connect} ${t[`provider_${provider}`]}`,
    html: `${existing?.status === 'connected' ? `<p class="muted-text">${esc(t.secretsHiddenHint)}</p>` : ''}${spec.events ? `
      <div class="form-field full"><label>${esc(t.eventsToSend)}</label><div class="chip-picker">${EVENTS.map((event) => `<label class="chip"><input type="checkbox" data-event value="${event}" ${!config.events?.length || config.events.includes(event) ? 'checked' : ''} /><span>${esc(event)}</span></label>`).join('')}</div></div>` : ''}`,
    fields: spec.fields.map((item) => ({
      ...item,
      value: item.target === 'config' ? config[item.name] ?? '' : item.type === 'select' ? config[item.name] ?? item.options?.[0]?.[0] : '',
      required: item.target === 'secret' && existing?.status === 'connected' ? false : item.required,
      full: true,
    })),
    submitLabel: existing?.status === 'connected' ? t.save : t.connect,
    onSubmit: async (values, form) => {
      const payload = { config: {}, secret: {} };
      spec.fields.forEach((item) => { if (values[item.name] !== '') payload[item.target][item.name] = values[item.name]; });
      if (spec.events) {
        const selected = [...form.querySelectorAll('[data-event]:checked')].map((input) => input.value);
        payload.config.events = selected.length === EVENTS.length ? [] : selected;
      }
      const result = await connectIntegration(provider, payload);
      if (result.signing_secret && !existing) {
        openModal({ title: t.signingSecret, hideSubmit: true, html: `<p>${esc(t.signingSecretHelp)}</p><code class="mono secret-box">${esc(result.signing_secret)}</code>` });
      }
      toast(t.integrationConnected, 'success');
      onSaved?.();
    },
  });
}
