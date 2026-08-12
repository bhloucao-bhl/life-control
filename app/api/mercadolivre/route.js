import { admin, userFromRequest, validToken } from '../../../lib/oauth';
import { fetchMlPurchases, refreshMlCache, CACHE_DAYS } from '../../../lib/mercadolivre';

export const runtime = 'nodejs';
export const maxDuration = 30;

// Se o cache (mantido fresco pelo cron horário) ficar mais velho que isso,
// busca ao vivo mesmo sem o cron ter rodado — rede de segurança caso o cron
// pare de rodar (deploy quebrado, CRON_SECRET errado, etc).
const STALE_MS = 2 * 60 * 60 * 1000; // 2h

/**
 * GET /api/mercadolivre?days=N -> { connected, purchases }
 * Lê do cache (populado pelo cron a cada hora, ver /api/cron/mercadolivre-sync).
 * Se ainda não houver cache, se o cache estiver velho, ou se ?refresh=1,
 * busca ao vivo no Mercado Livre.
 */
export async function GET(req) {
  const user = await userFromRequest(req);
  if (!user) return Response.json({ error: 'Sem sessão.' }, { status: 401 });

  const token = await validToken(user.id, 'mercadolivre');
  if (!token) return Response.json({ connected: false, purchases: [] });

  const url = new URL(req.url);
  const days = Number(url.searchParams.get('days')) || 30;
  const force = url.searchParams.get('refresh') === '1';
  const db = admin();

  try {
    if (!force) {
      const { data: cached } = await db.from('ml_purchases_cache').select('*').eq('user_id', user.id).maybeSingle();
      const fresh = cached && (Date.now() - new Date(cached.updated_at).getTime()) < STALE_MS;
      if (fresh) {
        const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
        const purchases = (cached.purchases || []).filter((p) => !p.date || p.date >= cutoff);
        return Response.json({ connected: true, purchases, cachedAt: cached.updated_at });
      }
    }

    const purchases = days > CACHE_DAYS
      ? await fetchMlPurchases(token, days)
      : await refreshMlCache(db, user.id, token);
    const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    const filtered = days > CACHE_DAYS ? purchases : purchases.filter((p) => !p.date || p.date >= cutoff);
    return Response.json({ connected: true, purchases: filtered });
  } catch (e) {
    return Response.json({ connected: true, purchases: [], error: String(e.message || e) });
  }
}
