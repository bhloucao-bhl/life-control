import { admin, validToken } from '../../../../lib/oauth';
import { refreshOuraCache } from '../../../../lib/oura';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * GET /api/cron/oura-snapshot
 *
 * Rede de segurança pro histórico permanente de saúde (health_daily — ver
 * schema8.sql): o webhook da Oura já dispara um refresh a cada sincronização
 * do anel, mas se um evento se perder (assinatura expirada, instabilidade,
 * etc.) aquele dia podia nunca ser gravado no histórico. Rodando de hora em
 * hora pra todo mundo conectado, garante que nenhum dia fique sem registro
 * só porque o app não foi aberto e o webhook falhou.
 *
 * Agendado via GitHub Actions (.github/workflows/oura-health-snapshot.yml),
 * mesmo esquema do mercadolivre-sync.yml — contas Hobby da Vercel só
 * permitem cron nativo diário.
 *
 * Protegida por Authorization: Bearer <CRON_SECRET>, igual aos outros crons.
 */
export async function GET(req) {
  const auth = req.headers.get('authorization') || '';
  const expected = `Bearer ${process.env.CRON_SECRET || ''}`;
  if (!process.env.CRON_SECRET || auth !== expected) {
    console.warn('[cron/oura-snapshot] chamada não autorizada (Authorization header ausente ou incorreto)');
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const db = admin();
  const { data: conns, error } = await db.from('connections').select('user_id').eq('provider', 'oura');
  if (error) {
    console.error('[cron/oura-snapshot] falha ao listar conexões:', error.message || error);
    return Response.json({ ok: false, error: 'failed to list connections' }, { status: 500 });
  }

  const results = await Promise.allSettled((conns || []).map(async (c) => {
    const token = await validToken(c.user_id, 'oura');
    if (!token) throw new Error('sem token válido');
    await refreshOuraCache(db, c.user_id, token);
  }));

  const ok = results.filter((r) => r.status === 'fulfilled').length;
  const failed = results.length - ok;
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.error(`[cron/oura-snapshot] falhou para user_id ${conns[i].user_id}:`, r.reason && r.reason.message ? r.reason.message : r.reason);
    }
  });

  console.log(`[cron/oura-snapshot] ${ok} ok, ${failed} falharam, de ${results.length} conectados`);
  return Response.json({ ok: true, synced: ok, failed, total: results.length });
}
