import { admin } from '../../../../lib/oauth';
import { sendPush } from '../../../../lib/push';
import { loadUserState, buildMorningBrief, shouldFireNow, markNotifSent } from '../../../../lib/brief';
import { brDate } from '../../../../lib/tz';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * GET /api/cron/morning-brief
 *
 * Roda a cada poucos minutos, o dia inteiro, e manda uma push com o resumo da manhã —
 * compromissos de trabalho, itens pendentes da lista de compras e tarefas importantes/
 * atrasadas/do dia — pra cada usuário no horário que ele mesmo escolheu em Ajustes
 * (settings.notifPrefs.morning.time, 07:30 por padrão). shouldFireNow() garante que só
 * dispara uma vez por dia por usuário, mesmo rodando com frequência.
 *
 * Agendado via GitHub Actions (.github/workflows/morning-brief.yml) — Vercel Hobby não
 * permite cron nativo com essa granularidade.
 *
 * Protegida por Authorization: Bearer <CRON_SECRET>, igual /api/health/supabase.
 */
export async function GET(req) {
  const auth = req.headers.get('authorization') || '';
  const expected = `Bearer ${process.env.CRON_SECRET || ''}`;
  if (!process.env.CRON_SECRET || auth !== expected) {
    console.warn('[cron/morning-brief] chamada não autorizada (Authorization header ausente ou incorreto)');
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const db = admin();
  const { data: devices, error } = await db.from('push_tokens').select('user_id');
  if (error) {
    console.error('[cron/morning-brief] falha ao listar devices:', error.message || error);
    return Response.json({ ok: false, error: 'failed to list devices' }, { status: 500 });
  }
  const userIds = [...new Set((devices || []).map((d) => d.user_id))];
  const now = new Date();
  const today = brDate(now);

  const results = await Promise.allSettled(userIds.map(async (userId) => {
    const { items, settings } = await loadUserState(db, userId);
    const notifPrefs = settings.notifPrefs || {};
    const morningPrefs = { on: true, work: true, groceries: true, tasks: true, time: '07:30', ...notifPrefs.morning };
    const weekendsOn = notifPrefs.weekends !== false;
    if (!shouldFireNow(morningPrefs, weekendsOn, now, '07:30')) return { userId, sent: false };

    await markNotifSent(db, userId, settings, 'morning', today);
    const brief = buildMorningBrief(items, settings, now, morningPrefs);
    if (!brief) return { userId, sent: false };
    const res = await sendPush(userId, { title: brief.title, body: brief.body, data: { type: 'morning-brief' } });
    return { userId, sent: res.sent > 0 };
  }));

  const sent = results.filter((r) => r.status === 'fulfilled' && r.value.sent).length;
  const failed = results.filter((r) => r.status === 'rejected').length;
  results.forEach((r, i) => {
    if (r.status === 'rejected') console.error(`[cron/morning-brief] falhou para user_id ${userIds[i]}:`, r.reason && r.reason.message ? r.reason.message : r.reason);
  });

  console.log(`[cron/morning-brief] ${sent} enviados, ${failed} falharam, de ${userIds.length} com device registrado`);
  return Response.json({ ok: true, sent, failed, total: userIds.length });
}
