import { userFromRequest, validToken } from '../../../lib/oauth';
import { brDate } from '../../../lib/tz';

export const runtime = 'nodejs';
export const maxDuration = 60;

const G = 'https://gmail.googleapis.com/gmail/v1/users/me';
const CAL = 'https://www.googleapis.com/calendar/v3';

function header(payload, name) {
  const hs = (payload && payload.headers) || [];
  const f = hs.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return f ? f.value : '';
}
function plainBody(payload) {
  if (!payload) return '';
  const dec = (d) => { try { return Buffer.from(d.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'); } catch (e) { return ''; } };
  if (payload.mimeType === 'text/plain' && payload.body && payload.body.data) return dec(payload.body.data);
  for (const p of payload.parts || []) if (p.mimeType === 'text/plain' && p.body && p.body.data) return dec(p.body.data);
  for (const p of payload.parts || []) { const n = plainBody(p); if (n) return n; }
  if (payload.mimeType === 'text/html' && payload.body && payload.body.data) {
    return dec(payload.body.data).replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  }
  return '';
}
async function claude(system, messages) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 3000, system, messages }),
  });
  const j = await r.json();
  return (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
}

/**
 * GET /api/health-scan
 * Varre e-mails recentes (e a agenda) atrás de qualquer coisa relacionada a saúde — sem lista fixa
 * de palavras-chave: quem decide o que é "de saúde" é o Claude, olhando remetente/assunto/corpo.
 * Cobre: e-mails de médico/clínica, pedido de exames, resultados de exames, confirmação de consulta,
 * convites de agenda com aparência de consulta/exame. Nada é salvo aqui — só sugestões.
 */
export async function GET(req) {
  const user = await userFromRequest(req);
  if (!user) return Response.json({ error: 'Sem sessão.' }, { status: 401 });

  const token = await validToken(user.id, 'google');
  if (!token) return Response.json({ connected: false, suggestions: [] });

  const h = { Authorization: `Bearer ${token}` };
  const days = new URL(req.url).searchParams.get('days') || '30';

  let mails = [];
  let calEvents = [];

  // ---------- Gmail ----------
  try {
    // Busca ampla o bastante pra não perder nada, mas ainda assim direcionada — o Claude filtra o que
    // realmente é de saúde depois. Inclui label "(S) Saúde" opcional (se o usuário criar essa label no Gmail).
    const queryKeyword = `newer_than:${days}d (médico OR medico OR médica OR medica OR clínica OR clinica OR hospital OR exame OR exames OR laudo OR resultado OR "resultado de exame" OR consulta OR agendamento OR convênio OR convenio OR unimed OR amil OR "sulamérica" OR sulamerica OR bradesco OR notredame OR hapvida OR receita OR "receituário" OR prescrição OR prescricao OR "encaixe" OR fisioterapia OR dentista OR odontológico OR odontologico OR laboratório OR laboratorio OR "dasa" OR fleury OR "hermes pardini" OR einstein OR "sírio-libanês" OR "sirio libanes" OR telemedicina)`;
    const queryLabel = `label:"(S) Saúde" newer_than:${days}d`;
    const [r, rLabel] = await Promise.all([
      fetch(`${G}/messages?q=${encodeURIComponent(queryKeyword)}&maxResults=30`, { headers: h, cache: 'no-store' }),
      fetch(`${G}/messages?q=${encodeURIComponent(queryLabel)}&maxResults=30`, { headers: h, cache: 'no-store' }),
    ]);
    let j = { messages: [] }, jLabel = { messages: [] };
    if (r.ok) j = await r.json();
    if (rLabel.ok) jLabel = await rLabel.json();
    const ids = [...new Set([...(j.messages || []).map((m) => m.id), ...(jLabel.messages || []).map((m) => m.id)])].slice(0, 45);

    mails = (await Promise.all(ids.map(async (id) => {
      try {
        const rr = await fetch(`${G}/messages/${id}?format=full`, { headers: h, cache: 'no-store' });
        if (!rr.ok) return null;
        const m = await rr.json();
        return {
          id,
          from: header(m.payload, 'From'),
          subject: header(m.payload, 'Subject'),
          date: m.internalDate ? brDate(Number(m.internalDate)) : null,
          body: (plainBody(m.payload) || m.snippet || '').slice(0, 3500),
          link: `https://mail.google.com/mail/u/0/#inbox/${id}`,
        };
      } catch (e) { return null; }
    }))).filter(Boolean);
  } catch (e) {
    // segue sem e-mails se der erro
  }

  // ---------- Agenda (convites que parecem consulta/exame, passados recentes + futuros) ----------
  try {
    const timeMin = new Date(Date.now() - Number(days) * 86400000).toISOString();
    const timeMax = new Date(Date.now() + 90 * 86400000).toISOString();
    const u = `${CAL}/calendars/primary/events?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}&singleEvents=true&orderBy=startTime&maxResults=100`;
    const r = await fetch(u, { headers: h, cache: 'no-store' });
    if (r.ok) {
      const j = await r.json();
      calEvents = (j.items || []).filter((e) => e.status !== 'cancelled').map((e) => {
        const startRaw = (e.start && (e.start.dateTime || e.start.date)) || null;
        if (!startRaw) return null;
        const hasTime = !!(e.start && e.start.dateTime);
        let dateStr, timeStr = null;
        if (hasTime) {
          const mm = startRaw.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/);
          if (mm) { dateStr = mm[1]; timeStr = mm[2] + ':' + mm[3]; } else { dateStr = startRaw.slice(0, 10); }
        } else dateStr = startRaw.slice(0, 10);
        return {
          id: e.id,
          title: e.summary || '',
          date: dateStr,
          time: timeStr,
          location: e.location || '',
          description: (e.description || '').slice(0, 500),
          link: e.htmlLink || null,
        };
      }).filter(Boolean);
    }
  } catch (e) {
    // segue sem agenda se der erro
  }

  if (!mails.length && !calEvents.length) return Response.json({ connected: true, suggestions: [], scanned: 0 });

  const today = brDate(Date.now());
  const system = `Você é um assistente que identifica itens relacionados a SAÚDE (médico, clínica, exame, consulta, tratamento) em e-mails e eventos de agenda de uma pessoa, para um app pessoal de controle de vida.
Hoje é ${today}. Responda SOMENTE com um array JSON, sem texto fora dele, sem cercas de código.

Você decide sozinho o que conta como "de saúde" — não existe lista fixa de palavras. Considere: e-mail de médico/dentista/clínica/hospital/laboratório, pedido ou resultado de exame, confirmação/lembrete de consulta, convite de agenda que pareça consulta médica/exame/vacina/fisioterapia, renovação de receita, guia de convênio.
IGNORE: propaganda de plano de saúde, newsletter de bem-estar genérica, promoção de academia/farmácia, e qualquer coisa que não seja um evento/documento real da vida da pessoa.

Para cada item relevante, gere um objeto:
{"type":"appointment"|"document"|"task"|"note",
 "title":"texto curto em português",
 "date":"YYYY-MM-DD"|null,
 "time":"HH:MM"|null,
 "meta":{"doctor":"","specialty":"","clinic":"","isExam":true|false,"location":""},
 "sourceType":"email"|"calendar",
 "sourceId":"id do e-mail OU id do evento de agenda",
 "confidence":0..1,
 "why":"por que você concluiu isso, em 1 frase curta"}

Regras:
- "appointment" = consulta ou compromisso médico com data marcada.
- "document" = exame (pedido ou resultado), receita, laudo — marque meta.isExam=true quando for exame.
- "task" = algo que a pessoa precisa fazer (ex: agendar exame, renovar receita) sem data marcada ainda.
- "note" = informação de saúde relevante que não se encaixa nos tipos acima.
- NÃO invente dados ausentes — use null.
- Não duplique o mesmo compromisso vindo do e-mail E da agenda — se forem claramente o mesmo evento, gere só um item (prefira a fonte com mais detalhe).
- Se nada for relevante, devolva [].`;

  const payloadMails = mails.map((m) => ({ sourceType: 'email', id: m.id, from: m.from, subject: m.subject, date: m.date, body: m.body }));
  const payloadEvents = calEvents.map((e) => ({ sourceType: 'calendar', id: e.id, title: e.title, date: e.date, time: e.time, location: e.location, description: e.description }));
  const text = await claude(system, [{ role: 'user', content: JSON.stringify({ emails: payloadMails, calendarEvents: payloadEvents }) }]);

  let arr = [];
  try {
    const a = text.indexOf('['), b = text.lastIndexOf(']');
    arr = JSON.parse(a !== -1 && b !== -1 ? text.slice(a, b + 1) : text);
  } catch (e) {
    return Response.json({ connected: true, suggestions: [], scanned: mails.length + calEvents.length, error: 'Resposta não interpretável.' });
  }

  const byMailId = {}; mails.forEach((m) => { byMailId[m.id] = m; });
  const byEventId = {}; calEvents.forEach((e) => { byEventId[e.id] = e; });

  const suggestions = (Array.isArray(arr) ? arr : []).map((x, i) => {
    const isCal = x.sourceType === 'calendar';
    const src = isCal ? (byEventId[x.sourceId] || {}) : (byMailId[x.sourceId] || {});
    return {
      key: 'hsug_' + i + '_' + (x.sourceId || ''),
      sourceType: isCal ? 'calendar' : 'email',
      sourceId: x.sourceId || null,
      type: ['appointment', 'document', 'task', 'note'].includes(x.type) ? x.type : 'note',
      title: String(x.title || '').slice(0, 140),
      date: x.date || src.date || null,
      time: x.time || src.time || null,
      meta: x.meta || {},
      confidence: typeof x.confidence === 'number' ? x.confidence : 0.5,
      why: String(x.why || '').slice(0, 200),
      source: isCal
        ? { subject: src.title || '', from: src.location || '', link: src.link || null }
        : { subject: src.subject || '', from: src.from || '', link: src.link || null },
    };
  }).filter((x) => x.title && x.sourceId);

  return Response.json({ connected: true, suggestions, scanned: mails.length + calEvents.length });
}
