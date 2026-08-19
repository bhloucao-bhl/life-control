import { admin, userFromRequest, siteUrl } from '../../../../lib/oauth';
import { brDate } from '../../../../lib/tz';

export const runtime = 'nodejs';

async function loadSettings(db, userId) {
  const { data } = await db.from('kv').select('value').eq('user_id', userId).eq('key', 'lcc_settings_v1').maybeSingle();
  if (!data || !data.value) return {};
  try { return JSON.parse(data.value) || {}; } catch (e) { return {}; }
}
async function saveSettings(db, userId, settings) {
  await db.from('kv').upsert({ user_id: userId, key: 'lcc_settings_v1', value: JSON.stringify(settings), updated_at: new Date().toISOString() }, { onConflict: 'user_id,key' });
}

// ---- Cenas: mesma tradução de passo -> comando que o app usa em runSceneStep (app/page.js) ----
// Portado pra rodar aqui (server) em vez do WebView, pra funcionar como App Intent do widget/Lock
// Screen sem precisar abrir o app. Mantenha os dois em sincronia se o formato de um step mudar.
const acModeToTuya = (mode) => (mode === 'heat' ? 'hot' : mode === 'fan' ? 'wind' : 'cold');
const acModeToLg = (mode) => (mode === 'heat' ? 'HEAT' : mode === 'fan' ? 'FAN' : 'COOL');
const windToLg = (wind) => (wind === 'high' ? 'HIGH' : wind === 'low' ? 'LOW' : wind === 'mid' ? 'MID' : null);

function callApi(req, path, body) {
  return fetch(`${siteUrl(req)}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: req.headers.get('authorization') || '' },
    body: JSON.stringify(body),
  }).catch(() => null);
}

async function runSceneStep(req, s) {
  const a = s.action || {};
  if (s.target === 'tuya' && s.kind === 'ir_key') {
    await callApi(req, '/api/tuya', { ir: 'key', infrared_id: s.irId, remote_id: s.deviceId, key: a.key, key_id: a.key_id, category_id: a.category_id, remote_index: a.remote_index });
    await new Promise((res) => setTimeout(res, 800));
    return;
  }
  if (s.target === 'tuya' && s.kind === 'ac') {
    await callApi(req, '/api/tuya', { ir: 'ac', infrared_id: s.irId, remote_id: s.deviceId, acCode: 'all', acValue: { power: a.power ? 1 : 0, mode: acModeToTuya(a.mode), temp: a.temp, wind: a.wind || 'auto' } });
    await new Promise((res) => setTimeout(res, 1200));
    return;
  }
  if (s.target === 'tuya') {
    await callApi(req, '/api/tuya', { deviceId: s.deviceId, code: s.switchCode, value: !!a.power });
    if (a.power && s.kind === 'light') {
      if (a.mode === 'colour') {
        await callApi(req, '/api/tuya', { deviceId: s.deviceId, code: 'work_mode', value: 'colour' });
        await callApi(req, '/api/tuya', { deviceId: s.deviceId, code: s.colourCode, value: { h: a.hue, s: 1000, v: 1000 } });
      } else {
        await callApi(req, '/api/tuya', { deviceId: s.deviceId, code: 'work_mode', value: 'white' });
      }
      const briMax = s.briCode === 'bright_value_v2' ? 1000 : 255;
      await callApi(req, '/api/tuya', { deviceId: s.deviceId, code: s.briCode, value: Math.round((a.percent / 100) * briMax) });
    }
    return;
  }
  if (s.target === 'lg') {
    await callApi(req, '/api/lg', { deviceId: s.deviceId, host: s.host, op: 'power', value: !!a.power });
    if (a.power) {
      await callApi(req, '/api/lg', { deviceId: s.deviceId, host: s.host, op: 'mode', value: acModeToLg(a.mode) });
      if (a.temp != null) await callApi(req, '/api/lg', { deviceId: s.deviceId, host: s.host, op: 'temp', value: a.temp });
      const w = windToLg(a.wind);
      if (w) await callApi(req, '/api/lg', { deviceId: s.deviceId, host: s.host, op: 'wind', value: w });
    }
  }
}

async function runScene(req, scene) {
  for (const s of scene.steps || []) {
    try { await runSceneStep(req, s); } catch (e) { /* segue tentando os próximos passos da cena */ }
  }
}

/**
 * POST /api/widget/action
 * Ações rápidas e sem ambiguidade que os widgets de iOS podem disparar direto
 * (via App Intent interativo, sem abrir o app). De propósito bem restrito:
 * só ações que não exigem digitar nada. Qualquer coisa que precise de entrada
 * do usuário (valor de um gasto, nome de uma compra, etc.) o widget resolve
 * abrindo o app numa tela pré-preenchida — não tenta simular isso aqui.
 */
export async function POST(req) {
  const user = await userFromRequest(req);
  if (!user) return Response.json({ error: 'Sem sessão.' }, { status: 401 });

  let body;
  try { body = await req.json(); } catch (e) { return Response.json({ error: 'JSON inválido.' }, { status: 400 }); }
  const { action, id } = body || {};

  const db = admin();

  if (action === 'markPurchaseReceived') {
    if (!id) return Response.json({ error: 'Falta o id.' }, { status: 400 });
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

  if (action === 'runScene') {
    if (!id) return Response.json({ error: 'Falta o id.' }, { status: 400 });
    const settings = await loadSettings(db, user.id);
    const scene = (settings.scenes || []).find((s) => s.id === id);
    if (!scene) return Response.json({ error: 'Cena não encontrada.' }, { status: 404 });

    await runScene(req, scene);

    const next = { ...settings, lastSceneRun: { id: scene.id, name: scene.name, at: new Date().toISOString() } };
    await saveSettings(db, user.id, next);

    return Response.json({ ok: true });
  }

  return Response.json({ error: 'Ação desconhecida.' }, { status: 400 });
}
