import { userFromRequest, validToken } from '../../../lib/oauth';
import { brDate } from '../../../lib/tz';

export const runtime = 'nodejs';
export const maxDuration = 60;

const G = 'https://gmail.googleapis.com/gmail/v1/users/me';
const LABEL_NAME = '(V) processado';

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
 * GET /api/inbox-scan
 * Procura, nos e-mails recentes, reservas de voo/hotel/viagem e compromissos,
 * e devolve SUGESTOES de itens para o usuario aprovar (nada e salvo aqui).
 *
 * Abordagem em duas fases (a busca antiga, só por palavras-chave/remetentes conhecidos
 * em "q=", vinha voltando vazia — muitos e-mails de viagem reais não batiam com nenhuma
 * palavra do fallback nem com os domínios fixos):
 *  1) pega um lote amplo de e-mails recentes (sem depender de palavra-chave bater) e pede
 *     pra Claude, só com assunto/remetente/trecho, triar quais parecem viagem;
 *  2) só então busca o corpo completo dos poucos que passaram na triagem, pra extrair os
 *     detalhes (datas, localizador, etc.) com o prompt de extração de sempre.
 */
export async function GET(req) {
  const user = await userFromRequest(req);
  if (!user) return Response.json({ error: 'Sem sessão.' }, { status: 401 });

  const token = await validToken(user.id, 'google');
  if (!token) return Response.json({ connected: false, suggestions: [] });

  const h = { Authorization: `Bearer ${token}` };
  const days = new URL(req.url).searchParams.get('days') || '30';

  try {
    // Busca 1: e-mails recentes em geral (rede ampla, sem depender de palavra-chave bater).
    // Busca 2: label "(V) Viagens" criada pelo usuário, se existir.
    // Busca 3: remetentes conhecidos de companhias aéreas / OTAs (reforço, mesmo já cobertos pela busca 1).
    // "-label:(V) processado" exclui e-mails cuja sugestão já foi aceita antes (evita voo/reserva duplicado)
    const queryBroad = `newer_than:${days}d -in:spam -in:trash -label:"${LABEL_NAME}"`;
    const queryLabel = `label:"(V) Viagens" newer_than:${days}d -label:"${LABEL_NAME}"`;
    const querySenders = `newer_than:${days}d -label:"${LABEL_NAME}" from:(latam.com OR voegol.com.br OR voeazul.com.br OR avianca.com OR aa.com OR united.com OR delta.com OR copaair.com OR tap.pt OR tap.fr OR iberia.com OR airfrance.fr OR klm.com OR emirates.com OR booking.com OR airbnb.com OR decolar.com OR despegar.com OR expedia.com OR hoteis.com OR hotels.com OR trivago.com OR agoda.com OR cvc.com.br OR submarinoviagens.com.br OR maxmilhas.com.br OR 123milhas.com OR smiles.com.br OR livelo.com.br)`;
    const [rBroad, rLabel, rSenders] = await Promise.all([
      fetch(`${G}/messages?q=${encodeURIComponent(queryBroad)}&maxResults=90`, { headers: h, cache: 'no-store' }),
      fetch(`${G}/messages?q=${encodeURIComponent(queryLabel)}&maxResults=30`, { headers: h, cache: 'no-store' }),
      fetch(`${G}/messages?q=${encodeURIComponent(querySenders)}&maxResults=30`, { headers: h, cache: 'no-store' }),
    ]);
    if (!rBroad.ok) {
      const txt = await rBroad.text();
      throw new Error('HTTP ' + rBroad.status + ' — ' + txt.slice(0, 200));
    }
    const jBroad = await rBroad.json();
    let jLabel = { messages: [] };
    try { if (rLabel.ok) jLabel = await rLabel.json(); } catch (e) {}
    let jSenders = { messages: [] };
    try { if (rSenders.ok) jSenders = await rSenders.json(); } catch (e) {}
    const senderIds = new Set([...(jSenders.messages || []).map((m) => m.id), ...(jLabel.messages || []).map((m) => m.id)]);
    const ids = [...new Set([
      ...(jBroad.messages || []).map((m) => m.id),
      ...senderIds,
    ])].slice(0, 150);
    if (!ids.length) return Response.json({ connected: true, suggestions: [], scanned: 0 });

    // fase 1: metadata leve (barato) pra triar
    const metas = (await Promise.all(ids.map(async (id) => {
      try {
        const rr = await fetch(`${G}/messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`, { headers: h, cache: 'no-store' });
        if (!rr.ok) return null;
        const m = await rr.json();
        return { id, from: header(m.payload, 'From'), subject: header(m.payload, 'Subject'), snippet: (m.snippet || '').slice(0, 200) };
      } catch (e) { return null; }
    }))).filter(Boolean);
    if (!metas.length) return Response.json({ connected: true, suggestions: [], scanned: 0 });

    // e-mails de remetentes conhecidos de companhia aérea/OTA já entram direto na fase 2 —
    // não dependem da triagem da Claude, que é reservada pro resto do lote amplo
    const knownSenderMetas = metas.filter((m) => senderIds.has(m.id));
    const restMetas = metas.filter((m) => !senderIds.has(m.id));

    let triagedIds = [];
    if (restMetas.length) {
      const triageSystem = `Você tria e-mails pra achar reservas/compromissos de viagem (voo, hotel, aluguel de carro, itinerário, cartão de embarque), em qualquer idioma.
Responda SOMENTE com um array JSON de strings (os "id" dos e-mails que parecem viagem), sem texto fora dele, sem cercas de código.
Inclua qualquer e-mail que pareça confirmação de compra/reserva de passagem, hospedagem, aluguel de carro, itinerário ou embarque — mesmo que o texto disponível seja curto.
Ignore propaganda, newsletter, promoção e sugestão de destino. Se nada qualificar, devolva [].`;
      const triageText = await claude(triageSystem, [{ role: 'user', content: JSON.stringify(restMetas.map((m) => ({ id: m.id, from: m.from, subject: m.subject, snippet: m.snippet }))) }]);
      try {
        const a = triageText.indexOf('['), b = triageText.lastIndexOf(']');
        const arr = JSON.parse(a !== -1 && b !== -1 ? triageText.slice(a, b + 1) : triageText);
        if (Array.isArray(arr)) triagedIds = arr.map(String);
      } catch (e) { triagedIds = []; }
    }
    const triagedSet = new Set(triagedIds);
    const candidateIds = [...new Set([...knownSenderMetas.map((m) => m.id), ...restMetas.filter((m) => triagedSet.has(m.id)).map((m) => m.id)])].slice(0, 60);
    if (!candidateIds.length) return Response.json({ connected: true, suggestions: [], scanned: metas.length });

    // fase 2: corpo completo só dos que passaram na triagem, pra extrair os detalhes
    const mails = (await Promise.all(candidateIds.map(async (id) => {
      try {
        const rr = await fetch(`${G}/messages/${id}?format=full`, { headers: h, cache: 'no-store' });
        if (!rr.ok) return null;
        const m = await rr.json();
        return {
          id,
          from: header(m.payload, 'From'),
          subject: header(m.payload, 'Subject'),
          date: m.internalDate ? brDate(Number(m.internalDate)) : null,
          body: (plainBody(m.payload) || m.snippet || '').slice(0, 4000),
          link: `https://mail.google.com/mail/u/0/#inbox/${id}`,
        };
      } catch (e) { return null; }
    }))).filter(Boolean);

    const today = brDate(Date.now());
    const system = `Você extrai reservas de viagem e compromissos de e-mails, para um app pessoal.
Hoje é ${today}. Responda SOMENTE com um array JSON, sem texto fora dele, sem cercas de código.

Para cada e-mail que REALMENTE contenha uma reserva ou compromisso confirmado, gere um ou mais itens:
{"type":"flight"|"trip"|"event"|"appointment"|"bill",
 "title":"texto curto em português",
 "date":"YYYY-MM-DD"|null,
 "time":"HH:MM"|null,
 "amount":número|null,
 "meta":{"airline":"","flightNumber":"","from":"IATA","to":"IATA","seat":"","locator":"","destination":"","endDate":"YYYY-MM-DD","hotel":"","durationMin":número|null,"arrivalTime":"HH:MM"|null},
 "sourceId":"id do e-mail",
 "confidence":0..1,
 "why":"por que você concluiu isso, em 1 frase curta"}

Regras rígidas:
- NÃO invente dados. Se um campo não estiver escrito no e-mail, use null ou omita.
- Ignore propaganda, newsletter, promoção e sugestão de destino: só reservas/compromissos confirmados.
- E-mails de companhia aérea ou agência de viagem (ex: LATAM, GOL, Azul, Avianca, Booking, Airbnb, Decolar, Expedia, CVC) sobre compra de passagem, check-in, cartão de embarque ou confirmação de hospedagem SÃO reservas confirmadas — inclua mesmo que o corpo do e-mail seja curto ou majoritariamente em HTML/imagens; extraia o que der do assunto e do texto disponível.
- Um e-mail de compra de passagem com ida e volta pode gerar dois itens "flight" (um por trecho) se as datas/números de voo de ambos estiverem no e-mail.
- Para "flight": se a duração do voo estiver escrita no e-mail (ex: "Duração: 2h35"), preencha meta.durationMin em minutos. Se não estiver escrita mas houver horário de partida E de chegada do mesmo trecho (mesmo dia), preencha meta.arrivalTime e calcule meta.durationMin pela diferença entre partida e chegada. Se nada disso estiver disponível, deixe ambos null — não estime.
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
        messageId: x.sourceId || null,
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

async function findLabelId(h) {
  const r = await fetch(`${G}/labels`, { headers: h, cache: 'no-store' });
  if (!r.ok) return null;
  const j = await r.json();
  const found = (j.labels || []).find((l) => l.name === LABEL_NAME);
  return found ? found.id : null;
}
async function getOrCreateLabelId(h) {
  const found = await findLabelId(h);
  if (found) return found;
  const r = await fetch(`${G}/labels`, {
    method: 'POST',
    headers: { ...h, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: LABEL_NAME, labelListVisibility: 'labelShow', messageListVisibility: 'show' }),
  });
  if (!r.ok) return null;
  const j = await r.json();
  return j.id || null;
}

/**
 * POST /api/inbox-scan  { messageId }
 * Marca o e-mail com a label "(V) processado" pra não sugerir de novo — sem arquivar
 * (o usuário quer continuar vendo esses e-mails na caixa de entrada).
 */
export async function POST(req) {
  const user = await userFromRequest(req);
  if (!user) return Response.json({ error: 'Sem sessão.' }, { status: 401 });

  const token = await validToken(user.id, 'google');
  if (!token) return Response.json({ ok: false, error: 'Google não conectado.' }, { status: 400 });

  let body;
  try { body = await req.json(); } catch (e) { body = {}; }
  const messageId = body && body.messageId;
  if (!messageId) return Response.json({ ok: false, error: 'messageId ausente.' }, { status: 400 });

  const h = { Authorization: `Bearer ${token}` };
  try {
    const labelId = await getOrCreateLabelId(h);
    if (!labelId) return Response.json({ ok: false, error: 'Não foi possível criar/achar a label.' }, { status: 500 });
    const r = await fetch(`${G}/messages/${messageId}/modify`, {
      method: 'POST',
      headers: { ...h, 'Content-Type': 'application/json' },
      body: JSON.stringify({ addLabelIds: [labelId] }),
    });
    if (!r.ok) {
      const txt = await r.text();
      throw new Error('HTTP ' + r.status + ' — ' + txt.slice(0, 200));
    }
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ ok: false, error: String(e.message || e) }, { status: 500 });
  }
}
