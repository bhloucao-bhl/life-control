import { admin, siteUrl } from '../../../../lib/oauth';
import { exchangeTuyaUserCode } from '../../../../lib/tuya';

export const runtime = 'nodejs';

export async function GET(req) {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const base = siteUrl(req);

  if (!code || !state) return Response.redirect(`${base}/?conn=tuya&erro=faltou_code`, 302);

  const db = admin();
  const { data: st } = await db.from('oauth_states').select('*').eq('state', state).eq('provider', 'tuya').maybeSingle();
  if (!st) return Response.redirect(`${base}/?conn=tuya&erro=state_invalido`, 302);
  await db.from('oauth_states').delete().eq('state', state);

  try {
    const result = await exchangeTuyaUserCode(code);
    const expires_at = result.expire_time ? new Date(Date.now() + (result.expire_time - 60) * 1000).toISOString() : null;
    await db.from('connections').upsert({
      user_id: st.user_id,
      provider: 'tuya',
      tuya_uid: result.uid,
      access_token: result.access_token || null,
      refresh_token: result.refresh_token || null,
      expires_at,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id,provider' });
    return Response.redirect(`${base}/?conn=tuya&ok=1`, 302);
  } catch (e) {
    return Response.redirect(`${base}/?conn=tuya&erro=${encodeURIComponent(String(e.message || e).slice(0, 120))}`, 302);
  }
}
