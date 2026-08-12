import { admin, userFromRequest } from '../../../lib/oauth';

export const runtime = 'nodejs';

/**
 * GET /api/healthkit-steps -> { byDate }
 * Lê o cache de passos do HealthKit (gravado pelo POST, chamado sempre que o
 * app iOS lê dados novos do Apple Health). É assim que a versão desktop/web
 * — sem acesso nenhum ao HealthKit, que só existe no app nativo — enxerga os
 * mesmos passos que aparecem no iPhone.
 */
export async function GET(req) {
  const user = await userFromRequest(req);
  if (!user) return Response.json({ error: 'Sem sessão.' }, { status: 401 });
  const { data } = await admin().from('healthkit_steps_cache').select('by_date').eq('user_id', user.id).maybeSingle();
  return Response.json({ byDate: (data && data.by_date) || {} });
}

/**
 * POST /api/healthkit-steps { byDate: { 'YYYY-MM-DD': number } } -> grava o cache.
 * Chamado só pelo app iOS nativo (ver syncHealthKitSteps em app/page.js), que
 * é o único lugar com acesso de verdade ao HealthKit.
 */
export async function POST(req) {
  const user = await userFromRequest(req);
  if (!user) return Response.json({ error: 'Sem sessão.' }, { status: 401 });
  let body;
  try { body = await req.json(); } catch (e) { return Response.json({ error: 'JSON inválido.' }, { status: 400 }); }
  const byDate = body && body.byDate;
  if (!byDate || typeof byDate !== 'object' || Array.isArray(byDate)) {
    return Response.json({ error: 'byDate obrigatório.' }, { status: 400 });
  }
  await admin().from('healthkit_steps_cache').upsert({
    user_id: user.id,
    by_date: byDate,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'user_id' });
  return Response.json({ ok: true });
}
