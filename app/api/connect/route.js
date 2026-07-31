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
  });
}

/** POST { provider } -> devolve a URL de autorizacao */
export async function POST(req) {
  const user = await userFromRequest(req);
  if (!user) return Response.json({ error: 'Sem sessão.' }, { status: 401 });

  const { provider } = await req.json();
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
