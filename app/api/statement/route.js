import { userFromRequest } from '../../../lib/oauth';
export const runtime = 'nodejs';

export async function POST(req) {
  const user = await userFromRequest(req);
  if (!user) return Response.json({ error: 'Sem sessão.' }, { status: 401 });

  let body;
  try { body = await req.json(); } catch (e) { return Response.json({ error: 'JSON inválido.' }, { status: 400 }); }
  const { pdfBase64, password } = body || {};
  if (!pdfBase64) return Response.json({ error: 'Envie o PDF do extrato.' }, { status: 400 });

  let text = '';
  try {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const data = Buffer.from(pdfBase64, 'base64');
    const loadingTask = pdfjs.getDocument({ data: new Uint8Array(data), password: password || undefined });
    const pdf = await loadingTask.promise;
    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      pages.push(content.items.map((it) => it.str).join(' '));
    }
    text = pages.join('\n');
  } catch (e) {
    const msg = String(e && e.message || e);
    if (/password/i.test(msg)) return Response.json({ error: 'senha', needPassword: true });
    return Response.json({ error: 'Não consegui ler o PDF: ' + msg.slice(0, 120) }, { status: 400 });
  }

  if (!text.trim()) return Response.json({ error: 'PDF sem texto legível (pode ser imagem digitalizada).' }, { status: 400 });

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return Response.json({ error: 'IA não configurada.' }, { status: 500 });

  const prompt = `Você recebe o texto de um extrato bancário ou fatura. Extraia TODAS as transações em JSON.
Para cada transação retorne: date (YYYY-MM-DD), description (string curta, limpa), amount (número positivo), type ("expense" para saídas/débitos/compras, "income" para entradas/créditos/recebimentos).
Ignore saldos, totais, cabeçalhos. Se o ano não estiver claro, use o ano corrente.
Responda APENAS com JSON válido, sem markdown: {"transactions":[{"date":"2026-01-15","description":"...","amount":123.45,"type":"expense"}],"account":"nome do banco/conta se identificável"}

Texto do extrato:
${text.slice(0, 14000)}`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 4000, messages: [{ role: 'user', content: prompt }] }),
    });
    const j = await r.json();
    const txt = (j.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('').replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(txt);
    const txs = (parsed.transactions || []).filter((t) => t.date && t.amount);
    const withFp = txs.map((t) => ({
      ...t,
      fingerprint: `${t.date}|${Number(t.amount).toFixed(2)}|${String(t.description || '').toLowerCase().replace(/\s+/g, ' ').replace(/[^a-z0-9 ]/g, '').trim().slice(0, 40)}`,
    }));
    return Response.json({ transactions: withFp, account: parsed.account || null });
  } catch (e) {
    return Response.json({ error: 'Falha ao interpretar o extrato: ' + String(e.message || e).slice(0, 120) }, { status: 500 });
  }
}
