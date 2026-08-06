import { userFromRequest, validToken } from '../../../lib/oauth';

export const runtime = 'nodejs';
export const maxDuration = 20;

const TZ = 'America/Sao_Paulo';
const pad2 = (n) => String(n).padStart(2, '0');

/**
 * POST /api/calendar-invite
 * body: { title, date, time, durationMin, notes, personEmail, personName }
 * Cria um evento de verdade na Google Agenda (calendário primário) com a pessoa como
 * convidada — o Google manda o convite por e-mail (Aceitar/Recusar) automaticamente
 * via sendUpdates=all. Exige o escopo calendar.events (não calendar.readonly).
 */
export async function POST(req) {
  const user = await userFromRequest(req);
  if (!user) return Response.json({ error: 'Sem sessão.' }, { status: 401 });

  const token = await validToken(user.id, 'google');
  if (!token) return Response.json({ ok: false, error: 'Google não conectado.' }, { status: 400 });

  let body;
  try { body = await req.json(); } catch (e) { body = {}; }
  const { title, date, time, durationMin, notes, personEmail, personName } = body || {};
  if (!title || !date || !personEmail) {
    return Response.json({ ok: false, error: 'Dados incompletos (título, data e e-mail da pessoa são obrigatórios).' }, { status: 400 });
  }

  let start, end;
  if (time) {
    start = { dateTime: `${date}T${time}:00`, timeZone: TZ };
    const dur = Number(durationMin) > 0 ? Number(durationMin) : 60;
    const endDt = new Date(`${date}T${time}:00`);
    endDt.setMinutes(endDt.getMinutes() + dur);
    end = { dateTime: `${endDt.getFullYear()}-${pad2(endDt.getMonth() + 1)}-${pad2(endDt.getDate())}T${pad2(endDt.getHours())}:${pad2(endDt.getMinutes())}:00`, timeZone: TZ };
  } else {
    start = { date };
    const endDt = new Date(date + 'T00:00:00');
    endDt.setDate(endDt.getDate() + 1);
    end = { date: `${endDt.getFullYear()}-${pad2(endDt.getMonth() + 1)}-${pad2(endDt.getDate())}` };
  }

  try {
    const r = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=all', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        summary: title,
        description: notes || undefined,
        start,
        end,
        attendees: [{ email: personEmail, displayName: personName || undefined }],
      }),
    });
    if (!r.ok) {
      const txt = await r.text();
      throw new Error('HTTP ' + r.status + ' — ' + txt.slice(0, 300));
    }
    const j = await r.json();
    return Response.json({ ok: true, eventId: j.id, link: j.htmlLink || null });
  } catch (e) {
    return Response.json({ ok: false, error: String(e.message || e) }, { status: 500 });
  }
}
