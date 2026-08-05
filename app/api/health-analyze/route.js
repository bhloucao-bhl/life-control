import { userFromRequest } from '../../../lib/oauth';

export const runtime = 'nodejs';
export const maxDuration = 60;

const SYSTEM = `Você é o "Dr. Claude", um assistente que ajuda a organizar (NUNCA diagnosticar oficialmente) o histórico de saúde de uma pessoa a partir de exames laboratoriais.

Analise o(s) documento(s) anexado(s) (exames de sangue, laudos, resultados) e extraia todos os indicadores/biomarcadores numéricos encontrados.

Responda SOMENTE com um array JSON, sem texto fora dele, sem cercas de código:
[{"indicator":"nome padronizado em português (ex: Glicemia, Colesterol Total, HDL, LDL, Triglicerídeos, Hemoglobina, Hemoglobina Glicada, TSH, Vitamina D, Creatinina, Ureia, Ácido Úrico, PCR, Leucócitos, Hemácias, Plaquetas, etc.)",
"value": número,
"unit": "unidade (mg/dL, %, etc.)",
"refRange": "faixa de referência do laudo, se houver, senão null",
"status": "normal"|"alto"|"baixo"|null,
"date": "YYYY-MM-DD (data do exame, se identificável, senão null)"}]

Regras:
- Extraia SOMENTE valores que realmente aparecem no documento. Nunca invente.
- Se o documento não for um exame com valores numéricos, devolva [].
- "status" compara o valor com a faixa de referência do próprio laudo, se disponível.
- Ignore texto administrativo (nome da clínica, dados do paciente) — foque nos indicadores.`;

export async function POST(req) {
  const user = await userFromRequest(req);
  if (!user) return Response.json({ error: 'Sem sessão.' }, { status: 401 });

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return Response.json({ error: 'IA não configurada.' }, { status: 500 });

  const { docId, attachments, notes, fallbackDate } = await req.json();
  if (!attachments || !attachments.length) return Response.json({ error: 'Sem anexos para analisar.' }, { status: 400 });

  try {
    const content = [];
    for (const att of attachments.slice(0, 4)) {
      if (!att.dataUrl) continue;
      const m = att.dataUrl.match(/^data:([^;]+);base64,(.+)$/);
      if (!m) continue;
      const mime = m[1], b64 = m[2];
      if (mime === 'application/pdf') content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } });
      else if (mime.startsWith('image/')) content.push({ type: 'image', source: { type: 'base64', media_type: mime, data: b64 } });
    }
    // se nenhum anexo virou um bloco de imagem/documento válido, não adianta chamar o Claude — ele sempre vai dizer "nada encontrado"
    if (content.length === 0) {
      return Response.json({ error: 'Não consegui ler o(s) anexo(s) (formato não reconhecido ou corrompido). Tente reanexar o arquivo.', indicators: [] });
    }
    if (notes) content.push({ type: 'text', text: 'Notas adicionais: ' + notes });
    content.push({ type: 'text', text: 'Extraia os indicadores deste documento.' });

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 4000, system: SYSTEM, messages: [{ role: 'user', content }] }),
    });
    const j = await r.json();
    if (j.error) throw new Error(j.error.message || 'erro IA');
    const text = (j.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('').replace(/```json|```/g, '').trim();
    const a = text.indexOf('['), b = text.lastIndexOf(']');
    let arr = [];
    try { arr = JSON.parse(a !== -1 && b !== -1 ? text.slice(a, b + 1) : text); } catch (e) { return Response.json({ error: 'Resposta não interpretável.', indicators: [] }); }

    const indicators = (Array.isArray(arr) ? arr : []).map((x) => ({
      indicator: String(x.indicator || '').slice(0, 80),
      value: typeof x.value === 'number' ? x.value : Number(x.value),
      unit: x.unit || '',
      refRange: x.refRange || null,
      status: ['normal', 'alto', 'baixo'].includes(x.status) ? x.status : null,
      date: x.date || fallbackDate || null,
    })).filter((x) => x.indicator && !isNaN(x.value));

    return Response.json({ docId, indicators });
  } catch (e) {
    return Response.json({ error: String(e.message || e), indicators: [] });
  }
}
