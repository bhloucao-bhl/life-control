import { createClient } from '@supabase/supabase-js';
import { fetchOuraUserId } from './oura';

/** Cliente com service_role: usado SO no servidor. */
export function admin() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
}

/** Descobre a URL publica do app (para montar o redirect_uri). */
export function siteUrl(req) {
  if (process.env.NEXT_PUBLIC_SITE_URL) return process.env.NEXT_PUBLIC_SITE_URL.replace(/\/$/, '');
  try { return new URL(req.url).origin; } catch (e) { return ''; }
}

/** Valida o usuario a partir do token de sessao do Supabase. */
export async function userFromRequest(req) {
  const token = (req.headers.get('authorization') || '').replace('Bearer ', '');
  if (!token) return null;
  const { data, error } = await admin().auth.getUser(token);
  if (error || !data || !data.user) return null;
  return data.user;
}

export const PROVIDERS = {
  oura: {
    authorize: 'https://cloud.ouraring.com/oauth/authorize',
    token: 'https://api.ouraring.com/oauth/token',
    scope: 'daily personal',
    clientId: () => process.env.OURA_CLIENT_ID,
    clientSecret: () => process.env.OURA_CLIENT_SECRET,
    extraAuth: {},
  },
  ticktick: {
    authorize: 'https://ticktick.com/oauth/authorize',
    token: 'https://ticktick.com/oauth/token',
    scope: 'tasks:read tasks:write',
    clientId: () => process.env.TICKTICK_CLIENT_ID,
    clientSecret: () => process.env.TICKTICK_CLIENT_SECRET,
    extraAuth: {},
  },
  google: {
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    scope: [
      // calendar.events dá leitura+escrita de eventos — precisa pra criar convites de
      // verdade na Agenda (com convidado, que o Google notifica por e-mail). Mas calendar.events
      // sozinho NÃO cobre o endpoint calendarList.list (é um recurso separado do Calendar API);
      // sem calendar.readonly aqui, a busca pelo calendário "Moura" em /api/google sempre
      // devolve 403 e cai silenciosamente pra só o calendário primary. Quem já conectou antes
      // do calendar.readonly existir precisa reconectar em Ajustes.
      'https://www.googleapis.com/auth/calendar.events',
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/userinfo.email',
    ].join(' '),
    clientId: () => process.env.GOOGLE_CLIENT_ID,
    clientSecret: () => process.env.GOOGLE_CLIENT_SECRET,
    extraAuth: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' },
  },
  mercadolivre: {
    authorize: 'https://auth.mercadolivre.com.br/authorization',
    token: 'https://api.mercadolibre.com/oauth/token',
    // sem "offline_access" o Mercado Livre não devolve refresh_token — o access_token
    // (válido por 6h) fica sem como renovar sozinho, e só volta a funcionar depois de
    // desconectar e reconectar manualmente.
    scope: 'offline_access read',
    clientId: () => process.env.MERCADOLIVRE_CLIENT_ID,
    clientSecret: () => process.env.MERCADOLIVRE_CLIENT_SECRET,
    extraAuth: {},
  },
};

export function redirectUri(req, provider) {
  return `${siteUrl(req)}/api/callback/${provider}`;
}

/** Troca "code" por tokens e grava. */
export async function exchangeCode(req, provider, code, user_id) {
  const p = PROVIDERS[provider];
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(req, provider),
    client_id: p.clientId(),
    client_secret: p.clientSecret(),
  });
  const r = await fetch(p.token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const j = await r.json();
  if (!r.ok || !j.access_token) throw new Error('token: ' + JSON.stringify(j).slice(0, 300));

  const expires_at = j.expires_in ? new Date(Date.now() + (j.expires_in - 60) * 1000).toISOString() : null;
  const row = {
    user_id, provider,
    access_token: j.access_token,
    refresh_token: j.refresh_token || null,
    expires_at,
    scope: j.scope || p.scope,
    updated_at: new Date().toISOString(),
  };
  // guarda o id de usuario da Oura (diferente do nosso uuid) pra casar com os eventos de webhook
  if (provider === 'oura') row.oura_user_id = await fetchOuraUserId(j.access_token);

  await admin().from('connections').upsert(row, { onConflict: 'user_id,provider' });
  return true;
}

/** Devolve um access_token valido, renovando se preciso. */
export async function validToken(user_id, provider) {
  const db = admin();
  const { data } = await db.from('connections').select('*').eq('user_id', user_id).eq('provider', provider).maybeSingle();
  if (!data || !data.access_token) return null;

  const stillGood = !data.expires_at || new Date(data.expires_at) > new Date();
  if (stillGood) return data.access_token;
  if (!data.refresh_token) return null;

  const p = PROVIDERS[provider];
  const r = await fetch(p.token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: data.refresh_token,
      client_id: p.clientId(),
      client_secret: p.clientSecret(),
    }),
  });
  const j = await r.json();
  if (!r.ok || !j.access_token) return null;

  await db.from('connections').update({
    access_token: j.access_token,
    refresh_token: j.refresh_token || data.refresh_token,
    expires_at: j.expires_in ? new Date(Date.now() + (j.expires_in - 60) * 1000).toISOString() : null,
    updated_at: new Date().toISOString(),
  }).eq('user_id', user_id).eq('provider', provider);

  return j.access_token;
}
