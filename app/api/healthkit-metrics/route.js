import { admin, userFromRequest } from '../../../lib/oauth';
import { mergeHealthDaily } from '../../../lib/healthDaily';

export const runtime = 'nodejs';

// campos que o app iOS pode mandar (ver ios/App/App/HealthKitPlugin.swift getDailyMetrics/
// getDailyWorkouts e syncHealthKitExtras em app/page.js) — qualquer outra chave é ignorada,
// pra esta rota nunca virar um jeito de gravar campo arbitrário no histórico permanente.
const ALLOWED_KEYS = ['restingHR', 'hrv', 'activeEnergyKcal', 'weightKg', 'appleSleepMin', 'workoutMinutes', 'workoutCount'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * POST /api/healthkit-metrics { byDate: { 'YYYY-MM-DD': { restingHR, hrv, activeEnergyKcal,
 * weightKg, appleSleepMin, workoutMinutes, workoutCount } } }
 *
 * Complemento de /api/healthkit-steps: aquela rota só cuida de passos (porque também mantém um
 * cache de leitura rápida pro desktop/web mostrar hoje); esta aqui só grava no histórico
 * permanente (health_daily — ver lib/healthDaily.js), já que sono/frequência cardíaca/HRV/
 * calorias ativas/peso/treinos do Apple Health hoje só existem pra alimentar o contexto do
 * Dr. Claude, sem card nenhum que precise de leitura rápida cross-plataforma.
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

  const clean = {};
  Object.entries(byDate).forEach(([date, values]) => {
    if (!DATE_RE.test(date) || !values || typeof values !== 'object') return;
    const day = {};
    ALLOWED_KEYS.forEach((k) => { if (typeof values[k] === 'number' && !isNaN(values[k])) day[k] = values[k]; });
    if (Object.keys(day).length) clean[date] = day;
  });

  await mergeHealthDaily(admin(), user.id, clean);
  return Response.json({ ok: true });
}
