import { userFromRequest, validToken } from '../../../lib/oauth';
import { brDate } from '../../../lib/tz';

export const runtime = 'nodejs';
export const maxDuration = 60;

const G = 'https://gmail.googleapis.com/gmail/v1/users/me';
const LABEL_NAME = '(Z) processado';
const SUBJECT_RE = /^\(Z\)\s*/i;

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
 * GET /api/house-scan
 * Procura, nos e-mails recentes, o marcador "(Z)" no início do assunto e usa a Claude
 * para separar o que é TAREFA da casa do que é COMPROMISSO (com data/hora), devolvendo
 * também os casos duvidosos. Nada é salvo aqui — quem grava é o app, depois de decidir.
 */
export async function GET(req) {
  const user = await userFromRequest(req);
  if (!user) return Response.json({ error: 'Sem sessão.' }, { status: 401 });

  const token = await validToken(user.id, 'google');
  if (!token) return Response.json({ connected: false, results: [] });

  const h = { Authorization: `Bearer ${token}` };
  const days = new URL(req.url).searchParams.get('days') || '14';

  try {
    const query = `newer_than:${days}d -label:"${LABEL_NAME}"`;
    const rList = await fetch(`${G}/messages?q=${encodeURIComponent(query)}&maxResults=50`, { headers: h, cache: 'no-store' });
    if (!rList.ok) {
      const txt = await rList.text();
      throw new Error('HTTP ' + rList.status + ' — ' + txt.slice(0, 200));
    }
    const jList = await rList.json();
    const ids = (jList.messages || []).map((m) => m.id);
    if (!ids.length) return Response.json({ connected: true, results: [], scanned: 0 });

    // 1a passada: metadata leve, só pra achar quais assuntos começam com "(Z)"
    const metas = (await Promise.all(ids.map(async (id) => {
      try {
        const rr = await fetch(`${G}/messages/${id}?format=metadata&metadataHeaders=Subject`, { headers: h, cache: 'no-store' });
        if (!rr.ok) return null;
        const m = await rr.json();
        return { id, subject: header(m.payload, 'Subject') };
      } catch (e) { return null; }
    }))).filter(Boolean);
    const matchIds = metas.filter((m) => SUBJECT_RE.test(m.subject || '')).map((m) => m.id);
    if (!matchIds.length) return Response.json({ connected: true, results: [], scanned: metas.length });

    // 2a passada: corpo completo só dos que batem, pra extrair contexto (data recebida, texto)
    const mails = (await Promise.all(matchIds.map(async (id) => {
      try {
        const rr = await fetch(`${G}/messages/${id}?format=full`, { headers: h, cache: 'no-store' });
        if (!rr.ok) return null;
        const m = await rr.json();
        const subject = header(m.payload, 'Subject');
        return {
          id,
          from: header(m.payload, 'From'),
          subject,
          zText: subject.replace(SUBJECT_RE, '').trim(),
          receivedDate: m.internalDate ? brDate(Number(m.internalDate)) : null,
          body: (plainBody(m.payload) || m.snippet || '').slice(0, 3000),
          link: `https://mail.google.com/mail/u/0/#inbox/${id}`,
        };
      } catch (e) { return null; }
    }))).filter(Boolean).filter((m) => m.zText);

    if (!mails.length) return Response.json({ connected: true, results: [], scanned: metas.length });

    const today = brDate(Date.now());
    const system = `Você ajuda a organizar tarefas e compromissos da casa a partir de e-mails, para um app pessoal.
Hoje é ${today}. Cada e-mail tem no assunto o marcador "(Z)" seguido de um pedido, ex: "(Z) compre pilhas" ou "(Z) ir ao mercado segunda dia 05/09".
Responda SOMENTE com um array JSON, sem texto fora dele, sem cercas de código.

Para cada e-mail, devolva um item:
{"sourceId":"id do e-mail",
 "kind":"task"|"event"|"ambiguous",
 "title":"texto curto e claro em português, sem o marcador (Z)",
 "notes":"detalhes extras relevantes que não cabem no título, ou null",
 "date":"YYYY-MM-DD"|null,
 "time":"HH:MM"|null,
 "confidence":0..1,
 "why":"motivo curto da classificação, 1 frase"}

Regras:
- "task": um pedido/demanda da casa para RESOLVER (comprar algo, consertar algo, contratar alguém, etc.), sem data/hora específica marcada. date e time ficam null mesmo que haja um prazo vago tipo "essa semana".
- "event": tem uma data e/ou horário específico em que algo deve acontecer (ex: "ir ao mercado segunda dia 05/09", "eletricista vem quinta às 14h"). Resolva a data para YYYY-MM-DD usando a data de recebimento do e-mail (campo receivedDate) como referência: se só o dia da semana e o dia/mês forem citados, calcule o ano certo (o mais próximo no futuro a partir de receivedDate). Se não houver horário, time fica null.
- "ambiguous": você não tem certeza se é tarefa ou compromisso, ou falta informação pra decidir com confiança. Use confidence < 0.6 nesse caso.
- "notes": mantenha o título curto e coloque em notes qualquer detalhe adicional do assunto ou corpo do e-mail que ajude a executar a tarefa — por exemplo uma lista de itens de compra, quantidades, marcas específicas, endereço, telefone, instruções. Uma lista de itens vira notes com um item por linha. Se não houver nada além do título, notes fica null.
- Nunca invente data/hora nem itens que não estejam escritos no assunto ou no corpo do e-mail.
- Sempre devolva exatamente um item por e-mail da lista (nunca omita nenhum sourceId).`;

    const payload = mails.map((m) => ({ sourceId: m.id, subject: m.subject, zText: m.zText, receivedDate: m.receivedDate, body: m.body }));
    const text = await claude(system, [{ role: 'user', content: JSON.stringify(payload) }]);

    let arr = [];
    try {
      const a = text.indexOf('['), b = text.lastIndexOf(']');
      arr = JSON.parse(a !== -1 && b !== -1 ? text.slice(a, b + 1) : text);
    } catch (e) {
      return Response.json({ connected: true, results: [], scanned: mails.length, error: 'Resposta não interpretável.' });
    }

    const byId = {};
    mails.forEach((m) => { byId[m.id] = m; });
    const results = (Array.isArray(arr) ? arr : []).map((x) => {
      const src = byId[x.sourceId];
      if (!src) return null;
      return {
        id: src.id,
        subject: src.subject,
        zText: src.zText,
        from: src.from,
        receivedDate: src.receivedDate,
        link: src.link,
        classification: {
          kind: ['task', 'event', 'ambiguous'].includes(x.kind) ? x.kind : 'ambiguous',
          title: String(x.title || src.zText || '').slice(0, 140),
          notes: x.notes ? String(x.notes).slice(0, 2000) : '',
          date: x.date || null,
          time: x.time || null,
          confidence: typeof x.confidence === 'number' ? x.confidence : 0.4,
          why: String(x.why || '').slice(0, 200),
        },
      };
    }).filter(Boolean);

    return Response.json({ connected: true, results, scanned: mails.length });
  } catch (e) {
    return Response.json({ connected: true, results: [], error: String(e.message || e) });
  }
}

/**
 * POST /api/house-scan  { messageId }
 * Marca o e-mail como processado (label "(Z) processado"), pra não reaparecer na próxima varredura.
 */
export async function POST(req) {
  const user = await userFromRequest(req);
  if (!user) return Response.json({ error: 'Sem sessão.' }, { status: 401 });

  const token = await validToken(user.id, 'google');
  if (!token) return Response.json({ ok: false, error: 'Gmail não conectado.' }, { status: 400 });

  let body;
  try { body = await req.json(); } catch (e) { body = {}; }
  const messageId = body && body.messageId;
  if (!messageId) return Response.json({ ok: false, error: 'messageId ausente.' }, { status: 400 });

  const h = { Authorization: `Bearer ${token}` };
  try {
    const labelId = await getOrCreateLabelId(h);
    if (!labelId) return Response.json({ ok: false, error: 'Não foi possível criar/achar a label.' }, { status: 500 });
    // aplica a label "(Z) processado" e arquiva (tira da INBOX) numa única chamada
    const r = await fetch(`${G}/messages/${messageId}/modify`, {
      method: 'POST',
      headers: { ...h, 'Content-Type': 'application/json' },
      body: JSON.stringify({ addLabelIds: [labelId], removeLabelIds: ['INBOX'] }),
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
