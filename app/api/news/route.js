import { userFromRequest, admin } from '../../../lib/oauth';

export const runtime = 'nodejs';

// Fontes RSS (gratuitas, sem chave). Focadas nos interesses do Bruno.
const FEEDS = [
  // Tecnologia / IA / inovação
  { url: 'https://techcrunch.com/feed/', theme: 'tech' },
  { url: 'https://www.theverge.com/rss/index.xml', theme: 'tech' },
  { url: 'https://feeds.arstechnica.com/arstechnica/index', theme: 'tech' },
  // Mercado financeiro / negócios (BR)
  { url: 'https://www.infomoney.com.br/feed/', theme: 'financas' },
  { url: 'https://valor.globo.com/rss/', theme: 'financas' },
  // Negócios internacionais / M&A
  { url: 'https://feeds.feedburner.com/venturebeat/SZYF', theme: 'negocios' },
  // Carros premium
  { url: 'https://www.motor1.com/rss/news/all/', theme: 'carros' },
  // Espaço / foguetes
  { url: 'https://www.space.com/feeds/all', theme: 'espaco' },
  // Aviação
  { url: 'https://simpleflying.com/feed/', theme: 'aviacao' },
];

const INTERESTS = `Bruno é um executivo brasileiro, Head de Portfólio, Desenvolvimento de Produtos e Inovação.
Interesses centrais (ordene por relevância a estes temas):
- Inovação e early-adoption de tecnologia (geek por natureza)
- Novos produtos e lançamentos disruptivos
- Novos mercados e disrupção de indústrias
- Inteligência Artificial (avanços, produtos, modelos)
- Mercado financeiro brasileiro e internacional
- Fusões e aquisições (M&A)
- Carros premium — especialmente Audi, Porsche e Ferrari
- Foguetes e espaço — especialmente SpaceX
- Negócios internacionais
- Aviação (sonho de ser piloto)`;

function decode(x) {
  return String(x || '')
    .replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#[0-9]+;/g, ' ')
    .replace(/<[^>]+>/g, '').trim();
}

function parseFeed(xml, theme) {
  const items = [];
  const blocks = xml.split(/<item[ >]/).slice(1).concat(xml.split(/<entry[ >]/).slice(1));
  for (const b of blocks.slice(0, 12)) {
    const title = decode((b.match(/<title[^>]*>(.*?)<\/title>/s) || [])[1]);
    let link = (b.match(/<link[^>]*>(.*?)<\/link>/s) || [])[1];
    if (!link) link = (b.match(/<link[^>]*href="(.*?)"/s) || [])[1];
    const pub = (b.match(/<pubDate[^>]*>(.*?)<\/pubDate>/s) || b.match(/<updated[^>]*>(.*?)<\/updated>/s) || b.match(/<published[^>]*>(.*?)<\/published>/s) || [])[1];
    const desc = decode((b.match(/<description[^>]*>(.*?)<\/description>/s) || b.match(/<summary[^>]*>(.*?)<\/summary>/s) || [])[1]).slice(0, 300);
    if (title && link) {
      let source = '';
      try { source = new URL(decode(link)).hostname.replace(/^www\./, ''); } catch (e) {}
      items.push({ title, link: decode(link), pub: pub || null, desc, theme, source });
    }
  }
  return items;
}

async function fetchFeed(f) {
  try {
    const r = await fetch(f.url, { headers: { 'User-Agent': 'Mozilla/5.0 LifeControl' }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return [];
    const xml = await r.text();
    return parseFeed(xml, f.theme);
  } catch (e) { return []; }
}

async function curate() {
  // 1) buscar todos os feeds em paralelo
  const all = (await Promise.all(FEEDS.map(fetchFeed))).flat();
  if (all.length === 0) return { items: [], error: 'Nenhuma fonte respondeu.' };

  // 2) ordenar por data (mais recentes primeiro) e limitar candidatos
  const withDate = all.map((x) => ({ ...x, ts: x.pub ? Date.parse(x.pub) || 0 : 0 }));
  withDate.sort((a, b) => b.ts - a.ts);
  const candidates = withDate.slice(0, 40);

  // 3) Claude rankeia e resume os 5 principais
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { items: candidates.slice(0, 12).map((x) => ({ ...x, why: null, summary: x.desc })) };

  const list = candidates.map((x, i) => `[${i}] (${x.theme}) ${x.title} — ${x.desc.slice(0, 120)}`).join('\n');
  const prompt = `${INTERESTS}

Abaixo estão manchetes recentes numeradas. Escolha as 5 MAIS relevantes e recentes para o Bruno, priorizando novidade e aderência aos interesses dele. Para cada uma, escreva um resumo de 1 frase (em português do Brasil) e uma justificativa curta de por que interessa a ele.

Manchetes:
${list}

Responda APENAS com JSON válido, sem markdown, no formato:
{"picks":[{"i":0,"summary":"...","why":"..."}]}`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1200, messages: [{ role: 'user', content: prompt }] }),
    });
    const j = await r.json();
    const txt = (j.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('').replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(txt);
    const picks = (parsed.picks || []).map((p) => ({ ...candidates[p.i], summary: p.summary })).filter((x) => x.title);
    // acrescenta mais recentes (sem resumo IA) para preencher a aba completa por tema
    const extra = candidates.filter((c) => !picks.find((p) => p.link === c.link)).slice(0, 20);
    return { items: [...picks, ...extra] };
  } catch (e) {
    return { items: candidates.slice(0, 20).map((x) => ({ ...x, summary: x.desc })), error: String(e.message || e) };
  }
}

const MAX_AGE_MS = 20 * 60 * 1000; // 20 minutos

export async function GET(req) {
  const user = await userFromRequest(req);
  if (!user) return Response.json({ error: 'Sem sessão.' }, { status: 401 });

  const force = new URL(req.url).searchParams.get('force');
  const db = admin();

  // 1) tentar cache
  if (!force) {
    try {
      const { data } = await db.from('news_cache').select('items, updated_at').eq('id', 'latest').maybeSingle();
      if (data && data.items && (Date.now() - Date.parse(data.updated_at)) < MAX_AGE_MS) {
        return Response.json({ items: data.items, cachedAt: data.updated_at, cached: true });
      }
    } catch (e) { /* tabela pode não existir ainda; segue para curar */ }
  }

  // 2) recurar e salvar
  const result = await curate();
  try {
    await db.from('news_cache').upsert({ id: 'latest', items: result.items, updated_at: new Date().toISOString() });
  } catch (e) { /* sem cache, ok */ }
  return Response.json({ ...result, cachedAt: new Date().toISOString(), cached: false });
}
