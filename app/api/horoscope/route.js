export const runtime = 'nodejs';
export const maxDuration = 20;

const URL = 'https://www.terra.com.br/vida-e-estilo/horoscopo/signos/sagitario';

/**
 * GET /api/horoscope
 * Busca o parágrafo do dia no horóscopo de Sagitário do Terra — o texto que vem logo
 * após "Confira a previsão para <dia> de <mês>". Leitura simples, sem cache do lado do
 * usuário (o site atualiza 1x por dia).
 */
export async function GET() {
  try {
    const r = await fetch(URL, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LifeControlBot/1.0)' }, cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const html = await r.text();

    // remove script/style e converte cada tag em quebra de linha, pra tratar cada elemento
    // do HTML como uma "linha" de texto — assim dá pra separar a frase-marcador do parágrafo
    // do horóscopo que vem logo depois, mesmo sem saber a estrutura exata da página.
    const plain = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, '\n')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&[a-z]+;/gi, ' ');

    const idx = plain.search(/Confira a previs[aã]o para/i);
    if (idx === -1) throw new Error('marcador não encontrado na página');

    const chunk = plain.slice(idx, idx + 3000);
    const lines = chunk.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);

    let text = null;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].length > 40) { text = lines[i]; break; }
    }
    if (!text) throw new Error('parágrafo do dia não encontrado');

    return Response.json({ text, sourceUrl: URL });
  } catch (e) {
    return Response.json({ text: null, error: String(e.message || e) }, { status: 200 });
  }
}
