import { admin } from '../../../../lib/oauth';
import { sendPush } from '../../../../lib/push';
import { loadUserState, buildEveningReview, shouldFireNow, markNotifSent } from '../../../../lib/brief';
import { brDate } from '../../../../lib/tz';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * GET /api/cron/evening-review
 *
 * Roda a cada poucos minutos, o dia inteiro, e manda uma push perguntando se as tarefas
 * de hoje foram feitas de verdade, e convidando a revisar/repriorizar a agenda de amanhã —
 * pra cada usuário no horário que ele mesmo escolheu em Ajustes (settings.notifPrefs.evening.time,
 * 17:30 por padrão). shouldFireNow() garante que só dispara uma vez por dia por usuário.
 *
 * Agendado via GitHub Actions (.github/workflows/evening-review.yml), mesmo esquema do
 * morning-brief e do sync do Mercado Livre.
 *
 * Protegida por Authorization: Bearer <CRON_SECRET>, igual /api/health/supabase.
 */
export async function GET(req) {
  const auth = req.headers.get('authorization') || '';
  const expected = `Bearer ${process.env.CRON_SECRET || ''}`;
  if (!process.env.CRON_SECRET || auth !== expected) {
    console.warn('[cron/evening-review] chamada não autorizada (Authorization header ausente ou incorreto)');
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const db = admin();
  const { data: devices, error } = await db.from('push_tokens').select('user_id');
  if (error) {
    console.error('[cron/evening-review] falha ao listar devices:', error.message || error);
    return Response.json({ ok: false, error: 'failed to list devices' }, { status: 500 });
  }
  const userIds = [...new Set((devices || []).map((d) => d.user_id))];
  const now = new Date();
  const today = brDate(now);

  const results = await Promise.allSettled(userIds.map(async (userId) => {
    const { items, settings } = await loadUserState(db, userId);
    const notifPrefs = settings.notifPrefs || {};
    const eveningPrefs = { on: true, time: '17:30', ...notifPrefs.evening };
    const weekendsOn = notifPrefs.weekends !== false;
    if (!shouldFireNow(eveningPrefs, weekendsOn, now, '17:30')) return { userId, sent: false };

    await markNotifSent(db, userId, settings, 'evening', today);
    const review = buildEveningReview(items, now);
    const res = await sendPush(userId, { title: review.title, body: review.body, data: { type: 'evening-review' } });
    return { userId, sent: res.sent > 0 };
  }));

  const sent = results.filter((r) => r.status === 'fulfilled' && r.value.sent).length;
  const failed = results.filter((r) => r.status === 'rejected').length;
  results.forEach((r, i) => {
    if (r.status === 'rejected') console.error(`[cron/evening-review] falhou para user_id ${userIds[i]}:`, r.reason && r.reason.message ? r.reason.message : r.reason);
  });

  console.log(`[cron/evening-review] ${sent} enviados, ${failed} falharam, de ${userIds.length} com device registrado`);
  return Response.json({ ok: true, sent, failed, total: userIds.length });
}
