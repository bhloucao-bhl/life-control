import { admin } from '../../../../lib/oauth';
import { sendPush } from '../../../../lib/push';
import { loadUserState, buildMorningBrief } from '../../../../lib/brief';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * GET /api/cron/morning-brief
 *
 * Roda todo dia às 07h30 (horário de Brasília) e manda uma push com o resumo
 * da manhã: compromissos de trabalho, itens pendentes da lista de compras e
 * tarefas importantes/atrasadas/do dia.
 *
 * Agendado via GitHub Actions (.github/workflows/morning-brief.yml), igual o
 * cron do Mercado Livre — Vercel Hobby não permite escolher o minuto do cron
 * nativo com a granularidade que precisamos aqui.
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

  const results = await Promise.allSettled(userIds.map(async (userId) => {
    const { items, settings } = await loadUserState(db, userId);
    const brief = buildMorningBrief(items, settings, now);
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
