import { admin, userFromRequest } from '../../../../lib/oauth';

export const runtime = 'nodejs';

/**
 * GET /api/health/history?days=400 -> { byDate: { 'YYYY-MM-DD': { readiness, sleep, activity, steps, tempDeviation, ... } } }
 *
 * Histórico permanente de saúde (tabela health_daily — ver schema8.sql e
 * lib/healthDaily.js), diferente de /api/oura e /api/healthkit-steps: aqueles
 * são caches de janela curta (~13-14 dias) que ficam sobrescritos a cada
 * atualização; aqui é o registro que cresce pra sempre, dia a dia, e é a
 * fonte usada tanto pra visão histórica no app quanto pro contexto que o
 * Dr. Claude enxerga em qualquer conversa.
 */
export async function GET(req) {
  const user = await userFromRequest(req);
  if (!user) return Response.json({ error: 'Sem sessão.' }, { status: 401 });

  const days = Math.min(Math.max(Number(new URL(req.url).searchParams.get('days')) || 400, 1), 1500);
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

  const { data, error } = await admin()
    .from('health_daily')
    .select('date, metrics')
    .eq('user_id', user.id)
    .gte('date', since)
    .order('date', { ascending: true });

  if (error) return Response.json({ error: String(error.message || error), byDate: {} }, { status: 500 });

  const byDate = {};
  (data || []).forEach((r) => { byDate[r.date] = r.metrics || {}; });
  return Response.json({ byDate }, { headers: { 'Cache-Control': 'private, s-maxage=900' } });
}
