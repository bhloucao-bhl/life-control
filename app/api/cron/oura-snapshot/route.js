import { admin, validToken } from '../../../../lib/oauth';
import { refreshOuraCache } from '../../../../lib/oura';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * GET /api/cron/oura-snapshot
 *
 * Atualização agendada dos dados da Oura (cache + histórico permanente health_daily — ver
 * schema8.sql) e da bateria do anel, 2x por dia: 6h e 20h de Brasília. O webhook da Oura já
 * dispara um refresh a cada sincronização do anel; isto é a rede de segurança caso um evento se
 * perca (assinatura expirada, instabilidade...) e a única leitura agendada da bateria.
 * (Antes rodava de hora em hora — 24 rodadas de ~15 chamadas à Oura por dia, por conta.)
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
    await refreshOuraCache(db, c.user_id, token, { battery: true }); // única rodada agendada que lê a bateria
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
