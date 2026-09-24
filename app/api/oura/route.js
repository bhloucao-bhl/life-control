import { admin, userFromRequest, validToken } from '../../../lib/oauth';
import { fetchOuraData, fetchOuraBattery, saveOuraCache } from '../../../lib/oura';
import { mergeHealthDaily } from '../../../lib/healthDaily';

export const runtime = 'nodejs';

// Se o cache (normalmente mantido fresco pelo webhook) ficar mais velho que
// isso, busca ao vivo mesmo sem ninguem ter pedido — rede de seguranca caso
// o webhook pare de chegar (assinatura expirada, evento perdido, etc).
const STALE_MS = 3 * 60 * 60 * 1000; // 3h

/**
 * GET /api/oura -> { byDate: { 'YYYY-MM-DD': { readiness, sleep, spo2, ... } }, lastSleep, extra }
 * (campos: ver fetchOuraData em lib/oura.js)
 * Le do cache (populado pelo webhook assim que o anel sincroniza com o app).
 * Se ainda nao houver cache, se o cache estiver velho, ou se ?refresh=1,
 * busca ao vivo na Oura.
 */
export async function GET(req) {
  const user = await userFromRequest(req);
  if (!user) return Response.json({ error: 'Sem sessão.' }, { status: 401 });

  const token = await validToken(user.id, 'oura');
  if (!token) return Response.json({ connected: false, byDate: {} });

  const db = admin();
  const force = new URL(req.url).searchParams.get('refresh') === '1';

  // bateria do anel: sempre ao vivo (não fica no cache), em paralelo com o resto
  const batteryP = fetchOuraBattery(token).then(({ battery, error }) => ({ battery, batteryError: error }));

  if (!force) {
    const { data: cached } = await db.from('oura_cache').select('*').eq('user_id', user.id).maybeSingle();
    const fresh = cached && (Date.now() - new Date(cached.updated_at).getTime()) < STALE_MS;
    if (fresh) {
      return Response.json({
        connected: true,
        byDate: cached.by_date || {},
        lastSleep: cached.last_sleep || null,
        extra: cached.extra || null,
        cachedAt: cached.updated_at,
        ...(await batteryP), // battery + batteryError (ver fetchOuraBattery)
      }, { headers: { 'Cache-Control': 'private, s-maxage=900' } });
    }
  }

  const data = await fetchOuraData(token);
  const { byDate, lastSleep, errors } = data;
  await saveOuraCache(db, user.id, data);
  // histórico permanente (ver lib/healthDaily.js) — não perde dias fora da janela do cache acima
  await mergeHealthDaily(db, user.id, byDate);

  return Response.json({ connected: true, byDate, lastSleep, extra: { ...data.extra, sources: data.sources }, errors, ...(await batteryP) }, {
    headers: { 'Cache-Control': 'private, s-maxage=900' },
  });
}
