import { userFromRequest, validToken } from '../../../lib/oauth';

export const runtime = 'nodejs';
export const revalidate = 0;

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
  let calendarsFound = [];
  let calendarErr = null;

  // ---------- Google Agenda: primary + calendário "Moura" (trabalho) ----------
  try {
    const timeMin = new Date(Date.now() - 86400000).toISOString();
    const timeMax = new Date(Date.now() + 60 * 86400000).toISOString();

    // descobre os calendários do usuário para achar o "Moura"
    let calIds = [{ id: 'primary', work: false }];
    try {
      const rl = await fetch('https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=250', { headers: h, cache: 'no-store' });
      if (rl.ok) {
        const jl = await rl.json();
        calendarsFound = (jl.items || []).map((c) => c.summaryOverride || c.summary).filter(Boolean);
        (jl.items || []).forEach((c) => {
          const name = (c.summary || '') + ' ' + (c.summaryOverride || '');
          if (/moura/i.test(name)) calIds.push({ id: c.id, work: true });
        });
      } else {
        let detail = '';
        try { const eb = await rl.json(); detail = (eb.error && (eb.error.message || eb.error.status)) || ''; } catch (e) {}
        calendarErr = 'calendarList HTTP ' + rl.status + (detail ? ' — ' + detail : '');
      }
    } catch (e) { calendarErr = String(e.message || e); }

    const mapEvent = (e, isWork) => {
      const startRaw = (e.start && (e.start.dateTime || e.start.date)) || null;
      if (!startRaw) return null;
      const hasTime = !!(e.start && e.start.dateTime);
      const title = e.summary || '(sem título)';
      const work = isWork || /^\s*\(m\)/i.test(title);
      // extrai data e hora LOCAL direto da string do Google (que já vem com o offset correto, ex: 2026-08-06T14:00:00-03:00)
      // NÃO usar new Date().toTimeString() porque o servidor (Vercel) roda em UTC e desloca o horário.
      let dateStr, timeStr = null, durationMin = null;
      if (hasTime) {
        const m = startRaw.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/);
        if (m) { dateStr = m[1]; timeStr = m[2] + ':' + m[3]; }
        else { const dt = new Date(startRaw); dateStr = isoDay(dt); timeStr = dt.toISOString().slice(11, 16); }
        // duração a partir do end
        const endRaw = e.end && (e.end.dateTime || e.end.date);
        if (endRaw) { try { const diff = (new Date(endRaw) - new Date(startRaw)) / 60000; if (diff > 0 && diff < 1440) durationMin = Math.round(diff); } catch (x) {} }
      } else {
        dateStr = startRaw.slice(0, 10);
      }
      return {
        id: 'g_' + e.id,
        type: 'event',
        domain: work ? 'work' : 'personal',
        title,
        date: dateStr,
        time: timeStr,
        notes: [e.location, e.description].filter(Boolean).join('\n').slice(0, 1500) || null,
        status: 'planned',
        priority: 2,
        meta: { external: 'google', link: e.htmlLink || null, location: e.location || null, work, moura: work, durationMin },
      };
    };

    for (const cal of calIds) {
      try {
        const u = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal.id)}/events?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}&singleEvents=true&orderBy=startTime&maxResults=100`;
        const r = await fetch(u, { headers: h, cache: 'no-store' });
        if (!r.ok) continue;
        const j = await r.json();
        const evs = (j.items || []).filter((e) => e.status !== 'cancelled').map((e) => mapEvent(e, cal.work)).filter(Boolean);
        events = events.concat(evs);
      } catch (e) {}
    }
    const seen = new Set();
    events = events.filter((e) => { if (seen.has(e.id)) return false; seen.add(e.id); return true; });
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

  return Response.json({ connected: true, events, messages, errors, calendarsFound, calendarErr }, {
    headers: { 'Cache-Control': 'no-store' },
  });
}
