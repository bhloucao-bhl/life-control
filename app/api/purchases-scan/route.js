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
    body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 2000, system, messages }),
  });
  const j = await r.json();
  return (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
}

/**
 * GET /api/purchases-scan
 * Busca e-mails com a label "(C) Compras" (criada pelo usuário no Gmail) dos últimos N dias,
 * usa Claude para extrair produto/preço/status/rastreio, e devolve SUGESTOES (nada é salvo aqui).
 */
export async function GET(req) {
  const user = await userFromRequest(req);
  if (!user) return Response.json({ error: 'Sem sessão.' }, { status: 401 });

  const token = await validToken(user.id, 'google');
  if (!token) return Response.json({ connected: false, suggestions: [] });

  const h = { Authorization: `Bearer ${token}` };
  const days = new URL(req.url).searchParams.get('days') || '20';

  try {
    const query = `label:"(C) Compras" newer_than:${days}d`;
    const r = await fetch(`${G}/messages?q=${encodeURIComponent(query)}&maxResults=25`, { headers: h, cache: 'no-store' });
    if (!r.ok) {
      const txt = await r.text();
      throw new Error('HTTP ' + r.status + ' — ' + txt.slice(0, 200));
    }
    const j = await r.json();
    const ids = (j.messages || []).map((m) => m.id);
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
          body: (plainBody(m.payload) || m.snippet || '').slice(0, 3000),
          link: `https://mail.google.com/mail/u/0/#inbox/${id}`,
        };
      } catch (e) { return null; }
    }))).filter(Boolean);

    const today = new Date().toISOString().slice(0, 10);
    const system = `Você extrai informações de compras online a partir de e-mails, para um app pessoal de acompanhamento de pedidos.
Hoje é ${today}. Responda SOMENTE com um array JSON, sem texto fora dele, sem cercas de código.

Para cada e-mail, classifique o momento do ciclo da compra e gere um item:
{"messageId":"id do e-mail",
 "title":"nome do produto (curto) ou loja, em português",
 "store":"nome da loja/marketplace",
 "amount":número ou null,
 "date":"YYYY-MM-DD" (data do e-mail),
 "stage":"paid"|"shipped"|"delivered"|"other",
 "tracking":"código de rastreio, se houver, senão null",
 "trackingLink":"link de rastreio, se houver, senão null",
 "paymentMethod":"forma de pagamento se mencionada, senão null",
 "confidence":0..1}

Regras:
- "paid" = confirmação de compra/pagamento aprovado.
- "shipped" = pedido enviado / a caminho / despachado.
- "delivered" = e-mail diz que foi entregue com sucesso.
- "other" = e-mail relacionado a compra mas não se encaixa nos acima (ex: cancelamento, nota fiscal).
- NÃO invente dados ausentes — use null.
- Se o e-mail não for realmente sobre uma compra, não o inclua.
- Um e-mail = um item (não duplique).`;

    const payload = mails.map((m) => ({ id: m.id, from: m.from, subject: m.subject, date: m.date, body: m.body }));
    const text = await claude(system, [{ role: 'user', content: JSON.stringify(payload) }]);

    let arr = [];
    try {
      const a = text.indexOf('['), b = text.lastIndexOf(']');
      arr = JSON.parse(a !== -1 && b !== -1 ? text.slice(a, b + 1) : text);
    } catch (e) {
      return Response.json({ connected: true, suggestions: [], scanned: mails.length, error: 'Resposta não interpretável.' });
    }

    const byId = {}; mails.forEach((m) => { byId[m.id] = m; });
    const suggestions = (Array.isArray(arr) ? arr : []).map((x, i) => {
      const src = byId[x.messageId] || {};
      return {
        key: 'psug_' + i + '_' + (x.messageId || ''),
        messageId: x.messageId || null,
        title: String(x.title || x.store || 'Compra').slice(0, 140),
        store: x.store || null,
        amount: x.amount != null && !isNaN(Number(x.amount)) ? Number(x.amount) : null,
        date: x.date || src.date || null,
        stage: ['paid', 'shipped', 'delivered', 'other'].includes(x.stage) ? x.stage : 'other',
        tracking: x.tracking || null,
        trackingLink: x.trackingLink || null,
        paymentMethod: x.paymentMethod || null,
        confidence: typeof x.confidence === 'number' ? x.confidence : 0.5,
        source: { subject: src.subject || '', from: src.from || '', link: src.link || null },
      };
    }).filter((x) => x.messageId);

    return Response.json({ connected: true, suggestions, scanned: mails.length });
  } catch (e) {
    return Response.json({ connected: true, suggestions: [], error: String(e.message || e) });
  }
}
