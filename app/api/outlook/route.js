import { userFromRequest, validToken } from '../../../lib/oauth';
import { brDate } from '../../../lib/tz';
export const runtime = 'nodejs';

export async function GET(req) {
  const user = await userFromRequest(req);
  if (!user) return Response.json({ error: 'Sem sessão.' }, { status: 401 });

  const token = await validToken(user.id, 'microsoft');
  if (!token) return Response.json({ connected: false, events: [] });

  // janela do dia "de hoje" em horario de Brasilia — o servidor (Vercel) roda em UTC, e como o
  // Prefer abaixo pede pro Graph interpretar start/end no fuso de Sao Paulo, as strings precisam
  // ser wall-clock BR (sem "Z"/offset), não a meia-noite UTC do servidor.
  const todayStr = brDate(Date.now());
  const tomorrowDt = new Date(todayStr + 'T00:00:00Z');
  tomorrowDt.setUTCDate(tomorrowDt.getUTCDate() + 1);
  const tomorrowStr = tomorrowDt.toISOString().slice(0, 10);
  const start = `${todayStr}T00:00:00`;
  const end = `${tomorrowStr}T00:00:00`;
  const url = `https://graph.microsoft.com/v1.0/me/calendarView?startDateTime=${start}&endDateTime=${end}&$orderby=start/dateTime&$top=20`;

  try {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Prefer: 'outlook.timezone="America/Sao_Paulo"' }, cache: 'no-store' });
    const j = await r.json();
    if (!r.ok) throw new Error((j.error && j.error.message) || ('HTTP ' + r.status));
    const events = (j.value || []).map((e) => ({
      id: e.id, title: e.subject || '(sem título)',
      start: e.start && e.start.dateTime, end: e.end && e.end.dateTime,
      allDay: e.isAllDay, location: e.location && e.location.displayName,
      online: e.isOnlineMeeting, link: e.onlineMeeting && e.onlineMeeting.joinUrl,
    }));
    return Response.json({ connected: true, events });
  } catch (e) {
    return Response.json({ connected: true, events: [], error: String(e.message || e) });
  }
}
