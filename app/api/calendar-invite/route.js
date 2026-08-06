import { userFromRequest, validToken } from '../../../lib/oauth';

export const runtime = 'nodejs';
export const maxDuration = 20;

const CAL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
const TZ = 'America/Sao_Paulo';
const pad2 = (n) => String(n).padStart(2, '0');

/**
 * POST /api/calendar-invite
 * body: { title, date, time, durationMin, notes, attendees:[{email,name}], googleEventId? }
 * Cria (ou, se googleEventId vier preenchido, ATUALIZA acrescentando convidados a) um evento
 * de verdade na Google Agenda — o Google manda o convite por e-mail (Aceitar/Recusar)
 * automaticamente via sendUpdates=all. Exige o escopo calendar.events.
 */
export async function POST(req) {
  const user = await userFromRequest(req);
  if (!user) return Response.json({ error: 'Sem sessão.' }, { status: 401 });

  const token = await validToken(user.id, 'google');
  if (!token) return Response.json({ ok: false, error: 'Google não conectado.' }, { status: 400 });

  let body;
  try { body = await req.json(); } catch (e) { body = {}; }
  const { title, date, time, durationMin, notes, attendees, googleEventId } = body || {};
  const list = (Array.isArray(attendees) ? attendees : []).filter((a) => a && a.email);
  if (!list.length) return Response.json({ ok: false, error: 'Nenhuma pessoa com e-mail cadastrado pra convidar.' }, { status: 400 });

  const h = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  // já existe um evento no Google pra esse item — só soma os novos convidados aos que já estão lá
  if (googleEventId) {
    try {
      const rGet = await fetch(`${CAL}/${googleEventId}`, { headers: h, cache: 'no-store' });
      if (rGet.ok) {
        const ev = await rGet.json();
        const merged = [...(ev.attendees || [])];
        list.forEach((a) => { if (!merged.some((e) => e.email === a.email)) merged.push({ email: a.email, displayName: a.name || undefined }); });
        const rPatch = await fetch(`${CAL}/${googleEventId}?sendUpdates=all`, {
          method: 'PATCH', headers: h, body: JSON.stringify({ attendees: merged }),
        });
        if (!rPatch.ok) { const txt = await rPatch.text(); throw new Error('HTTP ' + rPatch.status + ' — ' + txt.slice(0, 300)); }
        const j = await rPatch.json();
        return Response.json({ ok: true, eventId: j.id, link: j.htmlLink || null });
      }
      // se o evento não existe mais no Google (ex.: apagado por lá), cai pro fluxo de criar um novo abaixo
    } catch (e) {
      return Response.json({ ok: false, error: String(e.message || e) }, { status: 500 });
    }
  }

  if (!title || !date) {
    return Response.json({ ok: false, error: 'Dados incompletos (título e data são obrigatórios pra criar o evento).' }, { status: 400 });
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
    const r = await fetch(`${CAL}?sendUpdates=all`, {
      method: 'POST',
      headers: h,
      body: JSON.stringify({
        summary: title,
        description: notes || undefined,
        start,
        end,
        attendees: list.map((a) => ({ email: a.email, displayName: a.name || undefined })),
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
