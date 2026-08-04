import { userFromRequest, validToken } from '../../../lib/oauth';

export const runtime = 'nodejs';
export const maxDuration = 60;

const G = 'https://gmail.googleapis.com/gmail/v1/users/me';

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
    body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1500, system, messages }),
  });
  const j = await r.json();
  return (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
}

/**
 * GET /api/inbox-scan
 * Procura, nos e-mails recentes, reservas de voo/hotel/viagem e compromissos,
 * e devolve SUGESTOES de itens para o usuario aprovar (nada e salvo aqui).
 */
export async function GET(req) {
  const user = await userFromRequest(req);
  if (!user) return Response.json({ error: 'Sem sessão.' }, { status: 401 });

  const token = await validToken(user.id, 'google');
  if (!token) return Response.json({ connected: false, suggestions: [] });

  const h = { Authorization: `Bearer ${token}` };
  const days = new URL(req.url).searchParams.get('days') || '30';

  try {
    // Busca 1: dirigida por palavras-chave (fallback). Busca 2: label "(V) Viagens" criada pelo usuário (mais precisa).
    const query = `newer_than:${days}d (voo OR passagem OR reserva OR embarque OR itinerário OR itinerario OR hotel OR check-in OR flight OR booking OR reservation OR boarding OR itinerary)`;
    const queryLabel = `label:"(V) Viagens" newer_than:${days}d`;
    const [r, rLabel] = await Promise.all([
      fetch(`${G}/messages?q=${encodeURIComponent(query)}&maxResults=15`, { headers: h, cache: 'no-store' }),
      fetch(`${G}/messages?q=${encodeURIComponent(queryLabel)}&maxResults=15`, { headers: h, cache: 'no-store' }),
    ]);
    if (!r.ok) {
      const txt = await r.text();
      throw new Error('HTTP ' + r.status + ' — ' + txt.slice(0, 200));
    }
    const j = await r.json();
    let jLabel = { messages: [] };
    try { if (rLabel.ok) jLabel = await rLabel.json(); } catch (e) {}
    const ids = [...new Set([...(j.messages || []).map((m) => m.id), ...(jLabel.messages || []).map((m) => m.id)])];
    if (!ids.length) return Response.json({ connected: true, suggestions: [], scanned: 0 });

    const mails = (await Promise.all(ids.map(async (id) => {
      try {
        const rr = await fetch(`${G}/messages/${id}?format=full`, { headers: h, cache: 'no-store' });
        if (!rr.ok) return null;
        const m = await rr.json();
        return {
          id,
          from: header(m.payload, 'From'),
          subject: header(m.payload, 'Subject'),
          date: m.internalDate ? new Date(Number(m.internalDate)).toISOString().slice(0, 10) : null,
          body: (plainBody(m.payload) || m.snippet || '').slice(0, 2500),
          link: `https://mail.google.com/mail/u/0/#inbox/${id}`,
        };
      } catch (e) { return null; }
    }))).filter(Boolean);

    const today = new Date().toISOString().slice(0, 10);
    const system = `Você extrai reservas de viagem e compromissos de e-mails, para um app pessoal.
Hoje é ${today}. Responda SOMENTE com um array JSON, sem texto fora dele, sem cercas de código.

Para cada e-mail que REALMENTE contenha uma reserva ou compromisso confirmado, gere um ou mais itens:
{"type":"flight"|"trip"|"event"|"appointment"|"bill",
 "title":"texto curto em português",
 "date":"YYYY-MM-DD"|null,
 "time":"HH:MM"|null,
 "amount":número|null,
 "meta":{"airline":"","flightNumber":"","from":"IATA","to":"IATA","seat":"","locator":"","destination":"","endDate":"YYYY-MM-DD","hotel":""},
 "sourceId":"id do e-mail",
 "confidence":0..1,
 "why":"por que você concluiu isso, em 1 frase curta"}

Regras rígidas:
- NÃO invente dados. Se um campo não estiver escrito no e-mail, use null ou omita.
- Ignore propaganda, newsletter, promoção e sugestão de destino: só reservas/compromissos confirmados.
- Não repita o mesmo voo/reserva duas vezes.
- Se nada qualificar, devolva [].`;

    const payload = mails.map((m) => ({ id: m.id, from: m.from, subject: m.subject, date: m.date, body: m.body }));
    const text = await claude(system, [{ role: 'user', content: JSON.stringify(payload) }]);

    let arr = [];
    try {
      const a = text.indexOf('['), b = text.lastIndexOf(']');
      arr = JSON.parse(a !== -1 && b !== -1 ? text.slice(a, b + 1) : text);
    } catch (e) {
      return Response.json({ connected: true, suggestions: [], scanned: mails.length, error: 'Resposta não interpretável.' });
    }

    const byId = {};
    mails.forEach((m) => { byId[m.id] = m; });
    const suggestions = (Array.isArray(arr) ? arr : []).map((x, i) => {
      const src = byId[x.sourceId] || {};
      return {
        key: 'sug_' + i + '_' + (x.sourceId || ''),
        type: ['flight', 'trip', 'event', 'appointment', 'bill'].includes(x.type) ? x.type : 'event',
        title: String(x.title || '').slice(0, 140),
        date: x.date || null,
        time: x.time || null,
        amount: x.amount != null && !isNaN(Number(x.amount)) ? Number(x.amount) : null,
        meta: x.meta || {},
        confidence: typeof x.confidence === 'number' ? x.confidence : 0.5,
        why: String(x.why || '').slice(0, 200),
        source: { subject: src.subject || '', from: src.from || '', link: src.link || null },
      };
    }).filter((x) => x.title);

    return Response.json({ connected: true, suggestions, scanned: mails.length });
  } catch (e) {
    return Response.json({ connected: true, suggestions: [], error: String(e.message || e) });
  }
}
