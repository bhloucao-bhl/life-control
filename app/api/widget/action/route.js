import { admin, userFromRequest } from '../../../../lib/oauth';
import { brDate } from '../../../../lib/tz';

export const runtime = 'nodejs';

/**
 * POST /api/widget/action
 * Acoes rapidas e sem ambiguidade que os widgets de iOS podem disparar direto
 * (via App Intent interativo, sem abrir o app). De proposito bem restrito:
 * so acoes que nao exigem digitar nada (ex.: marcar uma compra como recebida).
 * Qualquer coisa que precise de entrada do usuario (valor de um gasto, nome de
 * uma compra, etc.) o widget resolve abrindo o app numa tela pre-preenchida —
 * nao tenta simular isso aqui.
 */
export async function POST(req) {
  const user = await userFromRequest(req);
  if (!user) return Response.json({ error: 'Sem sessão.' }, { status: 401 });

  let body;
  try { body = await req.json(); } catch (e) { return Response.json({ error: 'JSON inválido.' }, { status: 400 }); }
  const { action, id } = body || {};
  if (action !== 'markPurchaseReceived' || !id) return Response.json({ error: 'Ação desconhecida.' }, { status: 400 });

  const db = admin();
  const { data } = await db.from('kv').select('value').eq('user_id', user.id).eq('key', 'lcc_items_v1').maybeSingle();
  let items = [];
  try { items = data && data.value ? JSON.parse(data.value) : []; } catch (e) { items = []; }
  if (!Array.isArray(items)) items = [];

  const idx = items.findIndex((i) => i.id === id && i.type === 'purchase');
  if (idx === -1) return Response.json({ error: 'Compra não encontrada.' }, { status: 404 });

  const today = brDate(Date.now());
  items[idx] = { ...items[idx], meta: { ...items[idx].meta, stage: 'delivered', deliveredDate: today } };

  const { error } = await db.from('kv').upsert({ user_id: user.id, key: 'lcc_items_v1', value: JSON.stringify(items), updated_at: new Date().toISOString() }, { onConflict: 'user_id,key' });
  if (error) return Response.json({ error: String(error.message || error) }, { status: 500 });

  return Response.json({ ok: true });
}
