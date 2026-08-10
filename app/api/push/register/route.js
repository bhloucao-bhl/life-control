import { admin, userFromRequest } from '../../../../lib/oauth';

export const runtime = 'nodejs';

/** POST { token, platform } -> registra/atualiza o device do usuário logado */
export async function POST(req) {
  const user = await userFromRequest(req);
  if (!user) return Response.json({ error: 'Sem sessão.' }, { status: 401 });

  const { token, platform } = await req.json();
  if (!token) return Response.json({ error: 'Faltou o token.' }, { status: 400 });

  const { error } = await admin().from('push_tokens').upsert(
    { user_id: user.id, token, platform: platform || 'ios', updated_at: new Date().toISOString() },
    { onConflict: 'token' }
  );
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ ok: true });
}

/** DELETE { token } -> remove o device (ex: usuário desativou ou fez logout) */
export async function DELETE(req) {
  const user = await userFromRequest(req);
  if (!user) return Response.json({ error: 'Sem sessão.' }, { status: 401 });

  const { token } = await req.json();
  const q = admin().from('push_tokens').delete().eq('user_id', user.id);
  if (token) q.eq('token', token);
  await q;
  return Response.json({ ok: true });
}
