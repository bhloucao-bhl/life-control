import { admin, userFromRequest } from '../../../../lib/oauth';

export const runtime = 'nodejs';

/**
 * A Tuya não oferece login OAuth2 self-service pra contas do app Smart
 * Life (só existe pra apps OEM de marca própria) — então cada pessoa é
 * vinculada à mão pelo admin depois que ela escaneia o QR gerado em
 * Devices → Link App Account no painel iot.tuya.com. Essa rota substitui
 * o INSERT manual que antes era feito direto no Supabase SQL Editor.
 */
async function findUserByEmail(email) {
  const db = admin();
  const target = email.trim().toLowerCase();
  for (let page = 1; page <= 5; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error(error.message || 'listUsers falhou');
    const found = (data.users || []).find((u) => (u.email || '').toLowerCase() === target);
    if (found) return found;
    if (!data.users || data.users.length < 1000) break;
  }
  return null;
}

export async function POST(req) {
  const user = await userFromRequest(req);
  if (!user) return Response.json({ error: 'Sem sessão.' }, { status: 401 });

  const admins = (process.env.ADMIN_EMAIL || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!admins.length || !admins.includes((user.email || '').toLowerCase())) {
    return Response.json({ error: 'Sem permissão.' }, { status: 403 });
  }

  const { email, uid } = await req.json();
  if (!email || !uid) return Response.json({ error: 'Faltou email ou uid.' }, { status: 400 });

  try {
    const target = await findUserByEmail(email);
    if (!target) return Response.json({ error: 'Não achei nenhum usuário com esse e-mail — ele precisa ter feito login no app pelo menos uma vez.' }, { status: 404 });

    await admin().from('connections').upsert({
      user_id: target.id,
      provider: 'tuya',
      tuya_uid: uid.trim(),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id,provider' });

    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 500 });
  }
}
