import { userFromRequest, validToken } from '../../../lib/oauth';

export const runtime = 'nodejs';

const isoDay = (d) => d.toISOString().slice(0, 10);

/**
 * GET /api/google
 * -> { events: [...], messages: [...] }  (itens somente-leitura para o app)
 */
export async function GET(req) {
  const user = await userFromRequest(req);
  if (!user) return Response.json({ error: 'Sem sessão.' }, { status: 401 });

  const token = await validToken(user.id, 'google');
  if (!token) return Response.json({ connected: false, events: [], messages: [] });

  const h = { Authorization: `Bearer ${token}` };
  const errors = [];
  let events = [];
  let messages = [];

  // ---------- Google Agenda: proximos 60 dias ----------
  try {
    const timeMin = new Date(Date.now() - 86400000).toISOString();
    const timeMax = new Date(Date.now() + 60 * 86400000).toISOString();
    const u = `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}&singleEvents=true&orderBy=startTime&maxResults=50`;
    const r = await fetch(u, { headers: h, cache: 'no-store' });
    if (!r.ok) throw new Error('calendar HTTP ' + r.status);
    const j = await r.json();
    events = (j.items || [])
      .filter((e) => e.status !== 'cancelled')
      .map((e) => {
        const startRaw = (e.start && (e.start.dateTime || e.start.date)) || null;
        if (!startRaw) return null;
        const hasTime = !!(e.start && e.start.dateTime);
        const dt = new Date(startRaw);
        return {
          id: 'g_' + e.id,
          type: 'event',
          domain: 'work',
          title: e.summary || '(sem título)',
          date: hasTime ? isoDay(dt) : startRaw.slice(0, 10),
          time: hasTime ? dt.toTimeString().slice(0, 5) : null,
          notes: [e.location, e.description].filter(Boolean).join('\n').slice(0, 500) || null,
          status: 'planned',
          priority: 2,
          meta: { external: 'google', link: e.htmlLink || null, location: e.location || null },
        };
      })
      .filter(Boolean);
  } catch (e) {
    errors.push(String(e.message || e));
  }

  // ---------- Gmail: nao lidas da caixa principal ----------
  try {
    const listUrl = 'https://gmail.googleapis.com/gmail/v1/users/me/messages?q=' +
      encodeURIComponent('is:unread category:primary newer_than:14d') + '&maxResults=12';
    const r = await fetch(listUrl, { headers: h, cache: 'no-store' });
    if (!r.ok) throw new Error('gmail HTTP ' + r.status);
    const j = await r.json();
    const ids = (j.messages || []).map((m) => m.id);

    const detail = await Promise.all(ids.map(async (id) => {
      try {
        const u = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`;
        const rr = await fetch(u, { headers: h, cache: 'no-store' });
        if (!rr.ok) return null;
        const m = await rr.json();
        const hs = {};
        ((m.payload && m.payload.headers) || []).forEach((x) => { hs[x.name.toLowerCase()] = x.value; });
        const from = hs.from || '';
        const sender = from.replace(/<.*>/, '').replace(/"/g, '').trim() || from;
        const when = m.internalDate ? new Date(Number(m.internalDate)) : null;
        return {
          id: 'g_' + id,
          type: 'message',
          domain: 'personal',
          title: hs.subject || '(sem assunto)',
          notes: m.snippet || '',
          date: when ? isoDay(when) : null,
          time: when ? when.toTimeString().slice(0, 5) : null,
          status: 'planned',
          priority: 2,
          createdAt: m.internalDate ? Number(m.internalDate) : Date.now(),
          meta: { channel: 'email', sender, unread: true, external: 'google', link: `https://mail.google.com/mail/u/0/#inbox/${id}` },
        };
      } catch (e) { return null; }
    }));
    messages = detail.filter(Boolean);
  } catch (e) {
    errors.push(String(e.message || e));
  }

  return Response.json({ connected: true, events, messages, errors }, {
    headers: { 'Cache-Control': 'private, s-maxage=300' },
  });
}
