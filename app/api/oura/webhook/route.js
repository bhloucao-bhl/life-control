import { admin, validToken } from '../../../../lib/oauth';
import { refreshOuraCache } from '../../../../lib/oura';

export const runtime = 'nodejs';

/**
 * GET /api/oura/webhook -> handshake de verificacao que a Oura faz na hora
 * de criar a assinatura. Ela manda verification_token + challenge por query
 * string; a gente confirma que o token bate com o nosso segredo e devolve o
 * challenge de volta.
 */
export async function GET(req) {
  const url = new URL(req.url);
  const token = url.searchParams.get('verification_token');
  const challenge = url.searchParams.get('challenge') || url.searchParams.get('hub.challenge');

  if (!process.env.OURA_WEBHOOK_VERIFICATION_TOKEN || token !== process.env.OURA_WEBHOOK_VERIFICATION_TOKEN) {
    return Response.json({ error: 'verification_token inválido' }, { status: 403 });
  }
  return Response.json({ challenge });
}

/**
 * POST /api/oura/webhook -> evento de que algo mudou nos dados da Oura
 * (ex.: o anel acabou de sincronizar com o app). A gente casa o user_id da
 * Oura com a nossa conexao e recarrega o cache na hora, sem esperar o
 * usuario abrir o app da vida-control.
 *
 * OBS: a Oura documenta a existencia de um header x-oura-signature pra
 * autenticar o payload, mas o algoritmo exato nao pode ser confirmado aqui
 * (docs bloqueadas no ambiente de dev). Por isso a gente nao rejeita por
 * assinatura ainda — o unico efeito de um evento forjado seria disparar um
 * refresh (com o NOSSO token salvo) pra um user_id que exista na tabela de
 * conexoes; nao ha leitura/escrita de dados de terceiros. Validar o
 * x-oura-signature depois de testar contra um evento real é o proximo passo
 * recomendado.
 */
export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch (e) {
    return Response.json({ ok: true });
  }

  const events = Array.isArray(body) ? body : Array.isArray(body?.events) ? body.events : [body];
  const db = admin();

  await Promise.allSettled(events.map(async (ev) => {
    const ouraUserId = ev?.user_id;
    if (!ouraUserId) return;

    const { data: conn } = await db.from('connections')
      .select('user_id').eq('provider', 'oura').eq('oura_user_id', ouraUserId).maybeSingle();
    if (!conn) return;

    const token = await validToken(conn.user_id, 'oura');
    if (!token) return;

    await refreshOuraCache(db, conn.user_id, token);
  }));

  return Response.json({ ok: true });
}
