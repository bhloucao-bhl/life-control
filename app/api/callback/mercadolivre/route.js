import { admin, exchangeCode, siteUrl } from '../../../../lib/oauth';

export const runtime = 'nodejs';

export async function GET(req) {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const base = siteUrl(req);

  if (!code || !state) return Response.redirect(`${base}/?conn=mercadolivre&erro=faltou_code`, 302);

  const db = admin();
  const { data: st } = await db.from('oauth_states').select('*').eq('state', state).eq('provider', 'mercadolivre').maybeSingle();
  if (!st) return Response.redirect(`${base}/?conn=mercadolivre&erro=state_invalido`, 302);
  await db.from('oauth_states').delete().eq('state', state);

  try {
    await exchangeCode(req, 'mercadolivre', code, st.user_id);
    return Response.redirect(`${base}/?conn=mercadolivre&ok=1`, 302);
  } catch (e) {
    return Response.redirect(`${base}/?conn=mercadolivre&erro=${encodeURIComponent(String(e.message || e).slice(0, 120))}`, 302);
  }
}
