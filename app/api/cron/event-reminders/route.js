import { admin } from '../../../../lib/oauth';
import { sendPush } from '../../../../lib/push';
import { loadUserState, findUpcomingEventAlerts, markItemsReminded } from '../../../../lib/brief';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * GET /api/cron/event-reminders
 *
 * Roda a cada poucos minutos, o dia inteiro, e manda uma push tipo alarme de agenda/Outlook
 * pra cada compromisso (event/appointment) que vai começar nos próximos 10 minutos — só pra
 * quem tem esse tipo de alerta ligado em Ajustes (settings.notifPrefs.eventReminders.on,
 * true por padrão). Cada item só alerta uma vez (meta.eventReminded10).
 *
 * Agendado via GitHub Actions (.github/workflows/event-reminders.yml), mesmo esquema dos
 * outros crons de notificação.
 *
 * Protegida por Authorization: Bearer <CRON_SECRET>, igual /api/health/supabase.
 */
export async function GET(req) {
  const auth = req.headers.get('authorization') || '';
  const expected = `Bearer ${process.env.CRON_SECRET || ''}`;
  if (!process.env.CRON_SECRET || auth !== expected) {
    console.warn('[cron/event-reminders] chamada não autorizada (Authorization header ausente ou incorreto)');
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const db = admin();
  const { data: devices, error } = await db.from('push_tokens').select('user_id');
  if (error) {
    console.error('[cron/event-reminders] falha ao listar devices:', error.message || error);
    return Response.json({ ok: false, error: 'failed to list devices' }, { status: 500 });
  }
  const userIds = [...new Set((devices || []).map((d) => d.user_id))];
  const now = new Date();

  const results = await Promise.allSettled(userIds.map(async (userId) => {
    const { items, settings } = await loadUserState(db, userId);
    const prefs = settings.notifPrefs || {};
    const on = !prefs.eventReminders || prefs.eventReminders.on !== false;
    if (!on) return { userId, sent: 0 };

    const due = findUpcomingEventAlerts(items, now);
    if (!due.length) return { userId, sent: 0 };

    await markItemsReminded(db, userId, items, due.map((i) => i.id));
    let sent = 0;
    for (const ev of due) {
      const res = await sendPush(userId, {
        title: `⏰ ${ev.title}`,
        body: ev.time ? `Começa às ${ev.time} — prepare-se.` : 'Começa em poucos minutos.',
        data: { type: 'event-reminder', itemId: ev.id },
      });
      if (res.sent > 0) sent++;
    }
    return { userId, sent };
  }));

  const sent = results.reduce((a, r) => a + (r.status === 'fulfilled' ? r.value.sent : 0), 0);
  const failed = results.filter((r) => r.status === 'rejected').length;
  results.forEach((r, i) => {
    if (r.status === 'rejected') console.error(`[cron/event-reminders] falhou para user_id ${userIds[i]}:`, r.reason && r.reason.message ? r.reason.message : r.reason);
  });

  console.log(`[cron/event-reminders] ${sent} alertas enviados, ${failed} falharam, de ${userIds.length} com device registrado`);
  return Response.json({ ok: true, sent, failed, total: userIds.length });
}
