import { admin, userFromRequest } from '../../../../lib/oauth';

export const runtime = 'nodejs';

/**
 * Memória persistente das conversas com o Dr. Claude/Claude (tabela
 * dr_claude_messages — ver schema8.sql). Sem isto, cada conversa começava do
 * zero: o assistente via os dados cadastrados no app (tarefas, saúde, etc.)
 * mas nunca lembrava do que já tinha sido discutido em conversas anteriores.
 */

/** GET /api/dr-claude/messages?limit=20 -> { messages: [{role, content}] } (mais antiga primeiro) */
export async function GET(req) {
  const user = await userFromRequest(req);
  if (!user) return Response.json({ error: 'Sem sessão.' }, { status: 401 });

  const limit = Math.min(Math.max(Number(new URL(req.url).searchParams.get('limit')) || 20, 1), 60);
  const { data, error } = await admin()
    .from('dr_claude_messages')
    .select('role, content')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) return Response.json({ messages: [] });
  return Response.json({ messages: (data || []).reverse() });
}

/** POST /api/dr-claude/messages { role: 'user'|'assistant', content: string } -> registra uma mensagem */
export async function POST(req) {
  const user = await userFromRequest(req);
  if (!user) return Response.json({ error: 'Sem sessão.' }, { status: 401 });

  let body;
  try { body = await req.json(); } catch (e) { return Response.json({ error: 'JSON inválido.' }, { status: 400 }); }
  const role = body && body.role;
  const content = body && body.content;
  if (!['user', 'assistant'].includes(role) || typeof content !== 'string' || !content.trim()) {
    return Response.json({ error: 'role/content inválidos.' }, { status: 400 });
  }

  const db = admin();
  await db.from('dr_claude_messages').insert({ user_id: user.id, role, content: content.slice(0, 8000) });

  // poda: mantém só as últimas 300 mensagens por usuário, pra tabela não crescer sem limite
  const { data: old } = await db.from('dr_claude_messages')
    .select('id').eq('user_id', user.id).order('created_at', { ascending: false }).range(300, 399);
  if (old && old.length) await db.from('dr_claude_messages').delete().in('id', old.map((r) => r.id));

  return Response.json({ ok: true });
}
