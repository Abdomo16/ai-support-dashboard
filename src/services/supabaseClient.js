export const supabaseConfig = globalThis.__SUPABASE_CONFIG__ || { url: '', publishableKey: '' };

const SESSION_KEY = 'autexa-session';
const authListeners = new Set();
let session = readStoredSession();
let refreshing = null;

export const isConfigured = () => Boolean(supabaseConfig.url && supabaseConfig.publishableKey);

function readStoredSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY)) || null; } catch { return null; }
}

function setSession(next) {
  session = next ? { ...next, expires_at: next.expires_at || Math.floor(Date.now() / 1000) + (next.expires_in || 3600) } : null;
  if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  else localStorage.removeItem(SESSION_KEY);
  authListeners.forEach((listener) => listener(session));
}

export const getSession = () => session;
export const onAuthChange = (listener) => { authListeners.add(listener); return () => authListeners.delete(listener); };

async function parseResponse(response) {
  const text = await response.text();
  const body = text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null;
  if (!response.ok) {
    const message = body?.msg || body?.message || body?.error_description || body?.error || `Request failed (${response.status})`;
    const error = new Error(message);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

async function authFetch(path, { method = 'POST', body, token } = {}) {
  if (!isConfigured()) throw new Error('Supabase is not configured.');
  const response = await fetch(`${supabaseConfig.url}/auth/v1/${path}`, {
    method,
    headers: { apikey: supabaseConfig.publishableKey, 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return parseResponse(response);
}

const redirectUrl = () => `${location.origin}${location.pathname}`;

export async function signInWithPassword(email, password) {
  setSession(await authFetch('token?grant_type=password', { body: { email, password } }));
  return session;
}

export async function signUp(email, password, fullName) {
  const result = await authFetch(`signup?redirect_to=${encodeURIComponent(redirectUrl())}`, { body: { email, password, data: { full_name: fullName } } });
  if (result?.access_token) setSession(result);
  return result;
}

export const signInWithMagicLink = (email) => authFetch(`otp?redirect_to=${encodeURIComponent(redirectUrl())}`, { body: { email, create_user: true } });

export const resetPassword = (email) => authFetch(`recover?redirect_to=${encodeURIComponent(redirectUrl())}`, { body: { email } });

export const updatePassword = async (password) => authFetch('user', { method: 'PUT', body: { password }, token: await accessToken() });

export function signInWithGoogle() {
  location.href = `${supabaseConfig.url}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(redirectUrl())}`;
}

// Magic links, OAuth and password recovery come back with tokens in the URL fragment.
export async function consumeAuthRedirect() {
  const hashParams = new URLSearchParams(location.hash.replace(/^#\/?/, ''));
  const queryParams = new URLSearchParams(location.search);
  const errorText = hashParams.get('error_description') || queryParams.get('error_description');
  if (errorText) {
    history.replaceState(null, '', `${location.pathname}#/signin`);
    throw new Error(errorText.replace(/\+/g, ' '));
  }
  const tokenHash = queryParams.get('token_hash');
  if (tokenHash) {
    const type = queryParams.get('type') || 'magiclink';
    const result = await authFetch('verify', { body: { token_hash: tokenHash, type } });
    setSession(result);
    history.replaceState(null, '', `${location.pathname}#/${type === 'recovery' ? 'reset-password' : 'overview'}`);
    return type;
  }
  if (!hashParams.get('access_token')) return null;
  const accessTokenValue = hashParams.get('access_token');
  const user = await authFetch('user', { method: 'GET', token: accessTokenValue });
  setSession({
    access_token: accessTokenValue,
    refresh_token: hashParams.get('refresh_token'),
    expires_in: Number(hashParams.get('expires_in') || 3600),
    user,
  });
  const type = hashParams.get('type');
  history.replaceState(null, '', `${location.pathname}#/${type === 'recovery' ? 'reset-password' : 'overview'}`);
  return type;
}

export async function refreshSession() {
  if (!session?.refresh_token) return null;
  refreshing ||= authFetch('token?grant_type=refresh_token', { body: { refresh_token: session.refresh_token } })
    .then((next) => { setSession(next); return next; })
    .catch((error) => { if (error.status === 400 || error.status === 401) setSession(null); throw error; })
    .finally(() => { refreshing = null; });
  return refreshing;
}

export async function signOut() {
  const token = session?.access_token;
  setSession(null);
  if (token) await authFetch('logout', { token }).catch(() => {});
}

async function accessToken() {
  if (session && session.expires_at - 60 < Date.now() / 1000) await refreshSession().catch(() => {});
  return session?.access_token || supabaseConfig.publishableKey;
}

async function request(path, { method = 'GET', body, headers = {}, raw = false } = {}) {
  if (!isConfigured()) throw new Error('Supabase is not configured.');
  const send = async () => fetch(`${supabaseConfig.url}${path}`, {
    method,
    headers: {
      apikey: supabaseConfig.publishableKey,
      Authorization: `Bearer ${await accessToken()}`,
      ...(raw ? {} : { 'Content-Type': 'application/json', Accept: 'application/json' }),
      ...headers,
    },
    body: raw ? body : body === undefined ? undefined : JSON.stringify(body),
  });
  let response = await send();
  if (response.status === 401 && session?.refresh_token) {
    await refreshSession().catch(() => {});
    response = await send();
  }
  return parseResponse(response);
}

export const query = (table, queryString = '') => request(`/rest/v1/${table}?${queryString}`);

export const db = {
  select: query,
  insert: (table, rows, { upsert = false, onConflict } = {}) => request(`/rest/v1/${table}${onConflict ? `?on_conflict=${onConflict}` : ''}`, {
    method: 'POST',
    body: rows,
    headers: { Prefer: `return=representation${upsert ? ',resolution=merge-duplicates' : ''}` },
  }),
  update: (table, filter, patch) => request(`/rest/v1/${table}?${filter}`, { method: 'PATCH', body: patch, headers: { Prefer: 'return=representation' } }),
  remove: (table, filter) => request(`/rest/v1/${table}?${filter}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } }),
  rpc: (fn, args = {}) => request(`/rest/v1/rpc/${fn}`, { method: 'POST', body: args }),
};

export const invokeFunction = (name, body = {}) => request(`/functions/v1/${name}`, { method: 'POST', body });

export async function uploadFile(bucket, path, file) {
  await request(`/storage/v1/object/${bucket}/${path}`, { method: 'POST', body: file, raw: true, headers: { 'Content-Type': file.type || 'application/octet-stream', 'x-upsert': 'true' } });
  return path;
}

export const removeFile = (bucket, path) => request(`/storage/v1/object/${bucket}/${path}`, { method: 'DELETE' });

export const publicFileUrl = (bucket, path) => `${supabaseConfig.url}/storage/v1/object/public/${bucket}/${path}`;

export async function signedUrls(bucket, paths, expiresIn = 3600) {
  if (!paths.length) return {};
  const rows = await request(`/storage/v1/object/sign/${bucket}`, { method: 'POST', body: { expiresIn, paths } });
  return Object.fromEntries(rows.filter((row) => row.signedURL).map((row) => [row.path, `${supabaseConfig.url}/storage/v1${row.signedURL}`]));
}

// Minimal Supabase Realtime (Phoenix protocol) client for postgres_changes.
const channels = new Map();
let socket = null;
let socketRef = 0;
let heartbeat = null;

function socketSend(message) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ ...message, ref: String(++socketRef) }));
}

function joinChannel(channel) {
  socketSend({
    topic: channel.topic,
    event: 'phx_join',
    payload: {
      config: { broadcast: { self: false }, presence: { key: '' }, postgres_changes: [{ event: channel.event, schema: 'public', table: channel.table, ...(channel.filter ? { filter: channel.filter } : {}) }] },
      access_token: session?.access_token,
    },
  });
}

function ensureSocket() {
  if (socket && socket.readyState <= WebSocket.OPEN) return;
  socket = new WebSocket(`${supabaseConfig.url.replace(/^http/, 'ws')}/realtime/v1/websocket?apikey=${supabaseConfig.publishableKey}&vsn=1.0.0`);
  socket.onopen = () => {
    channels.forEach(joinChannel);
    heartbeat = setInterval(() => socketSend({ topic: 'phoenix', event: 'heartbeat', payload: {} }), 25000);
  };
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.event !== 'postgres_changes') return;
    channels.get(message.topic)?.callback(message.payload.data);
  };
  socket.onclose = () => {
    clearInterval(heartbeat);
    socket = null;
    if (channels.size) setTimeout(ensureSocket, 3000);
  };
}

export function subscribe({ table, filter, event = '*' }, callback) {
  if (!isConfigured() || typeof WebSocket === 'undefined') return () => {};
  const channel = { topic: `realtime:autexa-${table}-${++socketRef}`, table, filter, event, callback };
  channels.set(channel.topic, channel);
  ensureSocket();
  if (socket.readyState === WebSocket.OPEN) joinChannel(channel);
  return () => {
    socketSend({ topic: channel.topic, event: 'phx_leave', payload: {} });
    channels.delete(channel.topic);
  };
}

onAuthChange((next) => {
  if (next?.access_token) channels.forEach((channel) => socketSend({ topic: channel.topic, event: 'access_token', payload: { access_token: next.access_token } }));
});
