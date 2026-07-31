import { userFromRequest, validToken } from '../../../lib/oauth';
export const runtime = 'nodejs';

export async function GET(req) {
  const user = await userFromRequest(req);
  if (!user) return Response.json({ error: 'Sem sessão.' }, { status: 401 });

  const token = await validToken(user.id, 'microsoft');
  if (!token) return Response.json({ connected: false, events: [] });

  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0).toISOString();
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0).toISOString();
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
