import { userFromRequest } from '../../../../lib/oauth';
import { sendPush } from '../../../../lib/push';

export const runtime = 'nodejs';

/** POST -> manda uma push de teste pros devices do usuário logado */
export async function POST(req) {
  const user = await userFromRequest(req);
  if (!user) return Response.json({ error: 'Sem sessão.' }, { status: 401 });

  try {
    const result = await sendPush(user.id, {
      title: 'Life Control',
      body: 'Notificações estão funcionando.',
      data: { type: 'test' },
    });
    if (!result.sent && !result.failed) return Response.json({ error: 'Nenhum device registrado.' }, { status: 400 });
    return Response.json(result);
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 500 });
  }
}
