import { admin } from '../../../../lib/oauth';

export const runtime = 'nodejs';
export const maxDuration = 10;

/**
 * GET /api/health/supabase
 *
 * Health-check de "manter vivo" para o projeto gratuito do Supabase, que pausa
 * bancos sem atividade por um período. Faz uma leitura mínima (SELECT ... LIMIT 1)
 * numa tabela já existente — sem inserir, alterar ou apagar nada.
 *
 * Protegida por Authorization: Bearer <CRON_SECRET>. Chamada automaticamente
 * pelo Vercel Cron (ver vercel.json) duas vezes por dia.
 */
export async function GET(req) {
  // ---- autenticação da chamada (só o cron da Vercel, ou alguém com o segredo, pode chamar) ----
  const auth = req.headers.get('authorization') || '';
  const expected = `Bearer ${process.env.CRON_SECRET || ''}`;
  if (!process.env.CRON_SECRET || auth !== expected) {
    console.warn('[health/supabase] chamada não autorizada (Authorization header ausente ou incorreto)');
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const startedAt = Date.now();
  try {
    const db = admin();
    // leitura mínima, somente para "tocar" o banco — sem gravar nada
    const { error, count } = await db.from('kv').select('user_id', { head: true, count: 'exact' }).limit(1);
    if (error) throw error;

    const ms = Date.now() - startedAt;
    console.log(`[health/supabase] ok em ${ms}ms`);
    return Response.json({ ok: true, checkedAt: new Date().toISOString(), ms });
  } catch (e) {
    // nunca expor a mensagem crua de erro do Postgres/Supabase (pode conter detalhes internos) — só um resumo
    console.error('[health/supabase] falhou:', e && e.message ? e.message : e);
    return Response.json({ ok: false, error: 'health check failed', checkedAt: new Date().toISOString() }, { status: 500 });
  }
}
