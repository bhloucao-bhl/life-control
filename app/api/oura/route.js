import { admin, userFromRequest, validToken } from '../../../lib/oauth';
import { refreshOuraCache } from '../../../lib/oura';

export const runtime = 'nodejs';

// Rede de segurança: o cache é mantido fresco pelo cron das 6h e das 20h (BRT) e pelo webhook a
// cada sincronização do anel. Só busca ao vivo se o cache sumir ou ficar mais velho que isso —
// ou seja, se o cron e o webhook pararem por mais de um dia. (Era 3h, o que fazia qualquer tela
// aberta no desktop, atualizando a cada 10 min, ir à Oura várias vezes por dia.)
const STALE_MS = 26 * 60 * 60 * 1000;

/**
 * GET /api/oura -> { byDate: { 'YYYY-MM-DD': { readiness, sleep, spo2, ... } }, lastSleep, extra, battery }
 * (campos: ver fetchOuraData em lib/oura.js)
 * Lê SEMPRE do cache (oura_cache, mantido pelo cron 2x/dia + webhook) — a bateria também, que
 * vem da última leitura agendada. Só vai ao vivo na Oura se não houver cache, se ele estiver
 * velho demais, ou se ?refresh=1 (botão "Atualizar agora" dos Ajustes).
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
    const fresh = cached && (Date.now() - new Date(cached.updated_at).getTime()) < STALE_MS;
    if (fresh) {
      const extra = cached.extra || null;
      return Response.json({
        connected: true,
        byDate: cached.by_date || {},
        lastSleep: cached.last_sleep || null,
        extra,
        battery: (extra && extra.battery) || null,
        batteryError: (extra && extra.batteryError) || null,
        cachedAt: cached.updated_at,
      }, { headers: { 'Cache-Control': 'private, s-maxage=900' } });
    }
  }

  // refresh manual / cache ausente: busca tudo ao vivo (inclui a bateria) e grava no cache + histórico
  const data = await refreshOuraCache(db, user.id, token, { battery: true });
  const { data: saved } = await db.from('oura_cache').select('extra').eq('user_id', user.id).maybeSingle();
  const extra = (saved && saved.extra) || { ...data.extra, sources: data.sources };

  return Response.json({
    connected: true,
    byDate: data.byDate,
    lastSleep: data.lastSleep,
    extra,
    errors: data.errors,
    battery: extra.battery || null,
    batteryError: extra.batteryError || null,
  }, { headers: { 'Cache-Control': 'private, s-maxage=900' } });
}
