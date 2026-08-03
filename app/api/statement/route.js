import { userFromRequest } from '../../../lib/oauth';
export const runtime = 'nodejs';

const EXTRACT_PROMPT = `Você recebe um extrato bancário ou fatura de cartão (em PDF, imagem, planilha ou texto). Extraia TODAS as transações em JSON.
Para cada transação retorne: date (YYYY-MM-DD), description (string curta e limpa), amount (número positivo), type ("expense" para saídas/débitos/compras, "income" para entradas/créditos/recebimentos).
Ignore linhas de saldo, totais e cabeçalhos. Se o ano não estiver claro, use o ano corrente.
Responda APENAS com JSON válido, sem markdown, sem comentários:
{"transactions":[{"date":"2026-01-15","description":"...","amount":123.45,"type":"expense"}],"account":"nome do banco/conta se identificável"}`;

function fingerprint(t) {
  return `${t.date}|${Number(t.amount).toFixed(2)}|${String(t.description || '').toLowerCase().replace(/\s+/g, ' ').replace(/[^a-z0-9 ]/g, '').trim().slice(0, 40)}`;
}

async function callClaude(key, content) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 4000, messages: [{ role: 'user', content }] }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || 'erro IA');
  const txt = (j.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('').replace(/```json|```/g, '').trim();
  return JSON.parse(txt);
}

export async function POST(req) {
  const user = await userFromRequest(req);
  if (!user) return Response.json({ error: 'Sem sessão.' }, { status: 401 });

  let body;
  try { body = await req.json(); } catch (e) { return Response.json({ error: 'JSON inválido.' }, { status: 400 }); }
  const b64 = body.fileBase64 || body.pdfBase64;
  const mime = body.mime || 'application/pdf';
  const filename = body.filename || '';
  if (!b64) return Response.json({ error: 'Envie o arquivo do extrato.' }, { status: 400 });

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return Response.json({ error: 'IA não configurada.' }, { status: 500 });

  const isImage = /^image\//.test(mime) || /\.(png|jpe?g|webp|gif|heic)$/i.test(filename);
  const isPdf = mime === 'application/pdf' || /\.pdf$/i.test(filename);
  const isSheet = /sheet|excel|csv|\.xlsx?$|\.csv$/i.test(mime + ' ' + filename);

  try {
    let parsed;
    if (isImage) {
      parsed = await callClaude(key, [
        { type: 'image', source: { type: 'base64', media_type: mime || 'image/jpeg', data: b64 } },
        { type: 'text', text: EXTRACT_PROMPT },
      ]);
    } else if (isPdf) {
      parsed = await callClaude(key, [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } },
        { type: 'text', text: EXTRACT_PROMPT },
      ]);
    } else if (isSheet) {
      let text = '';
      const buf = Buffer.from(b64, 'base64');
      if (/\.csv$/i.test(filename) || /csv/i.test(mime)) {
        text = buf.toString('utf8');
      } else {
        const XLSX = await import('xlsx');
        const wb = XLSX.read(buf, { type: 'buffer' });
        text = wb.SheetNames.map((n) => XLSX.utils.sheet_to_csv(wb.Sheets[n])).join('\n');
      }
      parsed = await callClaude(key, [{ type: 'text', text: EXTRACT_PROMPT + '\n\nConteúdo:\n' + text.slice(0, 16000) }]);
    } else {
      return Response.json({ error: 'Formato não suportado. Use PDF, imagem, CSV ou XLSX.' }, { status: 400 });
    }
    const txs = (parsed.transactions || []).filter((t) => t.date && t.amount);
    const withFp = txs.map((t) => ({ ...t, fingerprint: fingerprint(t) }));
    return Response.json({ transactions: withFp, account: parsed.account || null });
  } catch (e) {
    const msg = String(e && e.message || e);
    if (/password|encrypt/i.test(msg)) return Response.json({ error: 'senha', needPassword: true });
    return Response.json({ error: 'Não consegui ler o extrato: ' + msg.slice(0, 140) }, { status: 400 });
  }
}
