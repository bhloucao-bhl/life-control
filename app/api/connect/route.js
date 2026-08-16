import { admin, userFromRequest, PROVIDERS, redirectUri } from '../../../lib/oauth';

export const runtime = 'nodejs';

/** GET -> status das conexoes */
export async function GET(req) {
  const user = await userFromRequest(req);
  if (!user) return Response.json({ error: 'Sem sessão.' }, { status: 401 });
  const { data } = await admin().from('connections').select('provider, updated_at, scope').eq('user_id', user.id);
  const map = {};
  (data || []).forEach((c) => { map[c.provider] = { connected: true, since: c.updated_at }; });
  return Response.json({
    oura: map.oura || { connected: false, configured: !!process.env.OURA_CLIENT_ID },
    google: map.google || { connected: false, configured: !!process.env.GOOGLE_CLIENT_ID },
    ticktick: map.ticktick || { connected: false, configured: !!process.env.TICKTICK_CLIENT_ID },
    mercadolivre: map.mercadolivre || { connected: false, configured: !!process.env.MERCADOLIVRE_CLIENT_ID },
    tuya: map.tuya || { connected: false, configured: !!process.env.TUYA_AUTH_CLIENT_ID },
  });
}

/**
 * Login OAuth2 da Tuya (Link App Account > Configure OAuth 2.0
 * Authorization no painel iot.tuya.com) — não usa client_secret trocado
 * direto por POST como os outros provedores, então fica fora do PROVIDERS
 * genérico. TUYA_AUTH_URL é a URL da tela de autorização que o painel
 * mostra ao habilitar o OAuth2 (varia por data center); os parâmetros
 * abaixo seguem o padrão de authorization code do próprio painel — ajuste
 * os nomes se o painel pedir algo diferente.
 */
function tuyaAuthorizeUrl(req, state) {
  const base = process.env.TUYA_AUTH_URL;
  const id = process.env.TUYA_AUTH_CLIENT_ID;
  if (!base || !id) return null;
  const qs = new URLSearchParams({
    client_id: id,
    redirect_uri: redirectUri(req, 'tuya'),
    response_type: 'code',
    state,
  });
  return `${base}${base.includes('?') ? '&' : '?'}${qs.toString()}`;
}

/** POST { provider } -> devolve a URL de autorizacao */
export async function POST(req) {
  const user = await userFromRequest(req);
  if (!user) return Response.json({ error: 'Sem sessão.' }, { status: 401 });

  const { provider } = await req.json();

  if (provider === 'tuya') {
    if (!process.env.TUYA_AUTH_URL || !process.env.TUYA_AUTH_CLIENT_ID) {
      return Response.json({ error: 'Faltam TUYA_AUTH_URL/TUYA_AUTH_CLIENT_ID na Vercel.' }, { status: 400 });
    }
    const state = crypto.randomUUID() + '.' + Math.random().toString(36).slice(2);
    await admin().from('oauth_states').insert({ state, user_id: user.id, provider });
    return Response.json({ url: tuyaAuthorizeUrl(req, state) });
  }

  const p = PROVIDERS[provider];
  if (!p) return Response.json({ error: 'Provedor inválido.' }, { status: 400 });
  if (!p.clientId() || !p.clientSecret()) {
    return Response.json({ error: `Faltam as variáveis do ${provider} na Vercel.` }, { status: 400 });
  }

  const state = crypto.randomUUID() + '.' + Math.random().toString(36).slice(2);
  await admin().from('oauth_states').insert({ state, user_id: user.id, provider });

  const qs = new URLSearchParams({
    client_id: p.clientId(),
    redirect_uri: redirectUri(req, provider),
    response_type: 'code',
    scope: p.scope,
    state,
    ...p.extraAuth,
  });
  return Response.json({ url: `${p.authorize}?${qs.toString()}` });
}

/** DELETE ?provider=... -> desconecta */
export async function DELETE(req) {
  const user = await userFromRequest(req);
  if (!user) return Response.json({ error: 'Sem sessão.' }, { status: 401 });
  const provider = new URL(req.url).searchParams.get('provider');
  await admin().from('connections').delete().eq('user_id', user.id).eq('provider', provider);
  return Response.json({ ok: true });
}
