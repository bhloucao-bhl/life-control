import { admin, userFromRequest, validToken } from '../../../lib/oauth';
import { fetchOuraData } from '../../../lib/oura';

export const runtime = 'nodejs';

/**
 * GET /api/oura -> { byDate: { 'YYYY-MM-DD': { readiness, sleep } } }
 * Le do cache (populado pelo webhook assim que o anel sincroniza com o app).
 * Se ainda nao houver cache, ou se ?refresh=1, busca ao vivo na Oura.
 */
export async function GET(req) {
  const user = await userFromRequest(req);
  if (!user) return Response.json({ error: 'Sem sessão.' }, { status: 401 });

  const token = await validToken(user.id, 'oura');
  if (!token) return Response.json({ connected: false, byDate: {} });

  const db = admin();
  const force = new URL(req.url).searchParams.get('refresh') === '1';

  if (!force) {
    const { data: cached } = await db.from('oura_cache').select('*').eq('user_id', user.id).maybeSingle();
    if (cached) {
      return Response.json({
        connected: true,
        byDate: cached.by_date || {},
        lastSleep: cached.last_sleep || null,
        cachedAt: cached.updated_at,
      }, { headers: { 'Cache-Control': 'private, s-maxage=900' } });
    }
  }

  const { byDate, lastSleep, errors } = await fetchOuraData(token);
  await db.from('oura_cache').upsert({
    user_id: user.id,
    by_date: byDate,
    last_sleep: lastSleep,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'user_id' });

  return Response.json({ connected: true, byDate, lastSleep, errors }, {
    headers: { 'Cache-Control': 'private, s-maxage=900' },
  });
}
