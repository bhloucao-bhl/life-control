import { admin, validToken } from '../../../../lib/oauth';
import { refreshOuraCache } from '../../../../lib/oura';

export const runtime = 'nodejs';

// Uma sincronização do anel gera uma rajada de eventos (um por tipo de dado e por create/update —
// até ~20 assinaturas), chegando quase juntos. Cada um disparava uma atualização COMPLETA (~15
// chamadas à Oura), então uma sincronização virava ~300 chamadas. Agora só o primeiro evento de
// cada janela atualiza; os outros são descartados. Janela curta de propósito: dados processados
// pela Oura alguns minutos depois (ex.: a nota do sono) ainda entram por um evento posterior, e o
// cron das 6h/20h fecha qualquer lacuna.
const MIN_GAP_MS = 5 * 60 * 1000;

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

    // reivindica a janela de forma atômica (UPDATE condicional): os eventos da rajada chegam em
    // paralelo, então só quem conseguir mexer na linha atualiza — checar "cache recente" antes
    // deixaria todos passarem juntos.
    const { data: row } = await db.from('oura_cache').select('updated_at').eq('user_id', conn.user_id).maybeSingle();
    if (row) {
      const { data: claimed } = await db.from('oura_cache')
        .update({ updated_at: new Date().toISOString() })
        .eq('user_id', conn.user_id)
        .lt('updated_at', new Date(Date.now() - MIN_GAP_MS).toISOString())
        .select('user_id');
      if (!claimed || !claimed.length) return; // outro evento da rajada já está atualizando
    }

    const token = await validToken(conn.user_id, 'oura');
    if (!token) return;

    // sem { battery: true }: a bateria só é lida nas rodadas agendadas
    await refreshOuraCache(db, conn.user_id, token);
  }));

  return Response.json({ ok: true });
}
