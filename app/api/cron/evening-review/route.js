import { admin } from '../../../../lib/oauth';
import { sendPush } from '../../../../lib/push';
import { loadUserState, buildEveningReview } from '../../../../lib/brief';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * GET /api/cron/evening-review
 *
 * Roda todo dia às 17h30 (horário de Brasília) e manda uma push perguntando
 * se as tarefas de hoje foram feitas de verdade, e convidando a revisar/
 * repriorizar a agenda de amanhã.
 *
 * Agendado via GitHub Actions (.github/workflows/evening-review.yml), mesmo
 * esquema do morning-brief e do sync do Mercado Livre.
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

  const results = await Promise.allSettled(userIds.map(async (userId) => {
    const { items } = await loadUserState(db, userId);
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
