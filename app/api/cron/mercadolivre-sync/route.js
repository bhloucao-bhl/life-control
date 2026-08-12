import { admin, validToken } from '../../../../lib/oauth';
import { refreshMlCache } from '../../../../lib/mercadolivre';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * GET /api/cron/mercadolivre-sync
 *
 * Roda de hora em hora (ver vercel.json) e atualiza o cache de compras
 * (ml_purchases_cache) de todo mundo que tem o Mercado Livre conectado —
 * assim a aba Compras mostra pedidos recentes sem precisar desconectar e
 * reconectar a conta pra forçar um refetch.
 *
 * Protegida por Authorization: Bearer <CRON_SECRET>, igual /api/health/supabase.
 */
export async function GET(req) {
  const auth = req.headers.get('authorization') || '';
  const expected = `Bearer ${process.env.CRON_SECRET || ''}`;
  if (!process.env.CRON_SECRET || auth !== expected) {
    console.warn('[cron/mercadolivre-sync] chamada não autorizada (Authorization header ausente ou incorreto)');
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const db = admin();
  const { data: conns, error } = await db.from('connections').select('user_id').eq('provider', 'mercadolivre');
  if (error) {
    console.error('[cron/mercadolivre-sync] falha ao listar conexões:', error.message || error);
    return Response.json({ ok: false, error: 'failed to list connections' }, { status: 500 });
  }

  const results = await Promise.allSettled((conns || []).map(async (c) => {
    const token = await validToken(c.user_id, 'mercadolivre');
    if (!token) throw new Error('sem token válido');
    await refreshMlCache(db, c.user_id, token);
  }));

  const ok = results.filter((r) => r.status === 'fulfilled').length;
  const failed = results.length - ok;
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.error(`[cron/mercadolivre-sync] falhou para user_id ${conns[i].user_id}:`, r.reason && r.reason.message ? r.reason.message : r.reason);
    }
  });

  console.log(`[cron/mercadolivre-sync] ${ok} ok, ${failed} falharam, de ${results.length} conectados`);
  return Response.json({ ok: true, synced: ok, failed, total: results.length });
}
