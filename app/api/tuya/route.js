import crypto from 'crypto';
import { userFromRequest } from '../../../lib/oauth';

export const runtime = 'nodejs';

/**
 * Integração Tuya / SmartLife.
 * Usa Client ID + Secret + UID do projeto na nuvem Tuya (iot.tuya.com).
 * A assinatura segue o padrão HMAC-SHA256 exigido pela Tuya Cloud.
 */

const REGION_HOST = {
  us: 'https://openapi.tuyaus.com',
  eu: 'https://openapi.tuyaeu.com',
  cn: 'https://openapi.tuyacn.com',
  in: 'https://openapi.tuyain.com',
};

function host() {
  const r = (process.env.TUYA_REGION || 'us').toLowerCase();
  return REGION_HOST[r] || REGION_HOST.us;
}

function sha256hex(s) {
  return crypto.createHash('sha256').update(s || '', 'utf8').digest('hex');
}
function hmac(msg, secret) {
  return crypto.createHmac('sha256', secret).update(msg, 'utf8').digest('hex').toUpperCase();
}

// cache simples do token em memória do servidor
let tokenCache = { token: null, exp: 0 };

async function getToken() {
  if (tokenCache.token && Date.now() < tokenCache.exp - 30000) return tokenCache.token;

  const id = process.env.TUYA_CLIENT_ID;
  const secret = process.env.TUYA_CLIENT_SECRET;
  const t = Date.now().toString();
  const path = '/v1.0/token?grant_type=1';
  const contentHash = sha256hex('');
  const stringToSign = `GET\n${contentHash}\n\n${path}`;
  const sign = hmac(id + t + stringToSign, secret);

  const r = await fetch(host() + path, {
    headers: { client_id: id, sign, t, sign_method: 'HMAC-SHA256', 'Content-Type': 'application/json' },
  });
  const j = await r.json();
  if (!j.success) {
    const code = j.code;
    let hint = j.msg || JSON.stringify(j);
    if (code === 1106 || /permission/i.test(hint)) hint = 'permission denied — verifique no painel Tuya (iot.tuya.com → Cloud → seu projeto): (1) o serviço IoT Core está com assinatura ATIVA? (2) seu projeto tem o data center correto? (3) a conta do app está vinculada em Devices → Link App Account.';
    else if (code === 1010 || /token/i.test(hint)) hint = 'token expirado/ inválido — a assinatura de algum serviço pode ter vencido no painel Tuya.';
    else if (code === 1004 || /sign/i.test(hint)) hint = 'sign invalid — Client ID/Secret ou região (TUYA_REGION) diferentes do projeto.';
    throw new Error('Tuya [' + (code != null ? code : '?') + ']: ' + hint);
  }
  tokenCache = { token: j.result.access_token, exp: Date.now() + (j.result.expire_time || 7200) * 1000 };
  return tokenCache.token;
}

async function tuya(method, path, body) {
  const id = process.env.TUYA_CLIENT_ID;
  const secret = process.env.TUYA_CLIENT_SECRET;
  const token = await getToken();
  const t = Date.now().toString();
  const bodyStr = body ? JSON.stringify(body) : '';
  const contentHash = sha256hex(bodyStr);
  const stringToSign = `${method}\n${contentHash}\n\n${path}`;
  const sign = hmac(id + token + t + stringToSign, secret);

  const r = await fetch(host() + path, {
    method,
    headers: { client_id: id, access_token: token, sign, t, sign_method: 'HMAC-SHA256', 'Content-Type': 'application/json' },
    body: bodyStr || undefined,
  });
  return r.json();
}


/** Descobre controles IR: hubs -> remotes -> keys */
async function irDiscover() {
  const out = { hubs: [], remotes: [], error: null };
  try {
    // aparelhos do usuario; hubs IR tem category 'wnykq' (IR) ou sao infrared parents
    const uid = process.env.TUYA_UID;
    const dj = await tuya('GET', `/v1.0/users/${uid}/devices`);
    const all = (dj.result || []);
    // hub IR: categoria wnykq (universal remote) ou infrared_id presente
    const hubs = all.filter((d) => d.category === 'wnykq' || d.category === 'infrared');
    for (const hub of hubs) {
      const hubInfo = { id: hub.id, name: hub.name, online: hub.online };
      try {
        const rr = await tuya('GET', `/v2.0/infrareds/${hub.id}/remotes`);
        if (rr.success) {
          hubInfo.remotesCount = (rr.result || []).length;
          (rr.result || []).forEach((rem) => {
            out.remotes.push({ infrared_id: hub.id, remote_id: rem.remote_id || rem.remoteId, name: rem.remote_name || rem.name, category_id: rem.category_id != null ? rem.category_id : rem.categoryId, remote_index: rem.remote_index != null ? rem.remote_index : rem.remoteIndex, _keys: Object.keys(rem) });
          });
        } else {
          hubInfo.error = 'code ' + rr.code + ': ' + (rr.msg || '');
        }
      } catch (e) { hubInfo.error = String(e.message || e); }
      out.hubs.push(hubInfo);
    }
  } catch (e) { out.error = String(e.message || e); }
  return out;
}


/** Lista as teclas disponiveis de um controle IR (TV/STB) */
async function irRemoteMeta(infrared_id, remote_id) {
  // acha category_id e remote_index do controle na lista de remotes do hub
  try {
    const rr = await tuya('GET', `/v2.0/infrareds/${infrared_id}/remotes`);
    if (rr.success) {
      const found = (rr.result || []).find((r) => (r.remote_id || r.remoteId) === remote_id);
      if (found) return {
        category_id: found.category_id != null ? found.category_id : (found.categoryId != null ? found.categoryId : found.category_id),
        remote_index: found.remote_index != null ? found.remote_index : (found.remoteIndex != null ? found.remoteIndex : found.remote_index),
        brand_id: found.brand_id != null ? found.brand_id : found.brandId,
        raw: found,
      };
    }
  } catch (e) {}
  return {};
}

async function irKeys(infrared_id, remote_id) {
  const meta = await irRemoteMeta(infrared_id, remote_id);
  const tries = [
    `/v2.0/infrareds/${infrared_id}/remotes/${remote_id}/keys`,
    `/v2.0/infrareds/${infrared_id}/remotes/${remote_id}/learning-codes`,
    `/v1.0/infrareds/${infrared_id}/remotes/${remote_id}/keys`,
  ];
  let lastMsg = 'sem teclas';
  for (const path of tries) {
    try {
      const j = await tuya('GET', path);
      if (j.success && j.result) {
        const list = j.result.key_list || j.result.keys || j.result;
        if (Array.isArray(list) && list.length) return { keys: list, meta };
      }
      lastMsg = j.msg || lastMsg;
    } catch (e) { lastMsg = String(e.message || e); }
  }
  throw new Error(lastMsg);
}

/** GET -> lista de aparelhos com estado */
export async function GET(req) {
  const user = await userFromRequest(req);
  if (!user) return Response.json({ error: 'Sem sessão.' }, { status: 401 });
  if (!process.env.TUYA_CLIENT_ID) return Response.json({ configured: false, devices: [] });

  const uid = process.env.TUYA_UID;
  const sp = new URL(req.url).searchParams;
  if (sp.get('ir')) {
    const ir = await irDiscover();
    return Response.json({ configured: true, ...ir });
  }
  if (sp.get('status')) {
    try {
      const j = await tuya('GET', `/v1.0/devices/${sp.get('status')}/status`);
      return Response.json({ configured: true, status: j.result || j });
    } catch (e) {
      return Response.json({ configured: true, error: String(e.message || e) });
    }
  }
  if (sp.get('keys')) {
    try {
      const r = await irKeys(sp.get('infrared_id'), sp.get('remote_id'));
      return Response.json({ configured: true, keys: r.keys, meta: r.meta || {} });
    } catch (e) {
      return Response.json({ configured: true, keys: [], error: String(e.message || e) });
    }
  }
  try {
    const j = await tuya('GET', `/v1.0/users/${uid}/devices`);
    if (!j.success) throw new Error(j.msg || 'falha ao listar');
    const devices = (j.result || []).map((d) => ({
      id: d.id,
      name: d.name,
      online: !!d.online,
      category: d.category,
      icon: d.icon ? `https://images.tuyaus.com/${d.icon}` : null,
      status: (d.status || []).reduce((acc, s) => { acc[s.code] = s.value; return acc; }, {}),
    }));
    return Response.json({ configured: true, connected: true, devices });
  } catch (e) {
    return Response.json({ configured: true, connected: false, devices: [], error: String(e.message || e) });
  }
}

/** POST { deviceId, code, value } -> envia comando */
export async function POST(req) {
  const user = await userFromRequest(req);
  if (!user) return Response.json({ error: 'Sem sessão.' }, { status: 401 });

  const body = await req.json();
  try {
    // ---- Comando IR de TV / set-top box: usa key ----
    if (body.ir === 'key') {
      // se nao veio category_id/remote_index do front, busca no servidor
      let cat = body.category_id, idx = body.remote_index;
      if (cat == null || idx == null) {
        const meta = await irRemoteMeta(body.infrared_id, body.remote_id);
        if (cat == null) cat = meta.category_id;
        if (idx == null) idx = meta.remote_index;
      }
      const base = `/v2.0/infrareds/${body.infrared_id}/remotes/${body.remote_id}`;
      const full = { key: body.key };
      if (cat != null) full.categoryId = cat;
      if (idx != null) full.remoteIndex = idx;
      const attempts = [
        ['POST', `${base}/command`, full],
        ['POST', `${base}/command`, cat != null ? { categoryId: cat, key: body.key } : { key: body.key }],
      ];
      let firstErr = null;
      for (const [m, p, b] of attempts) {
        try { const j = await tuya(m, p, b); if (j.success) return Response.json({ ok: true }); if (!firstErr) firstErr = 'code ' + (j.code != null ? j.code : '?') + ': ' + (j.msg || ''); } catch (e) { if (!firstErr) firstErr = String(e.message || e); }
      }
      return Response.json({ error: firstErr || 'falhou', key: body.key, sentCategory: cat, sentIndex: idx }, { status: 500 });
    }
    // ---- Comando IR de ar-condicionado ----
    if (body.ir === 'ac') {
      const v = body.acValue || {};
      // formato multi-condicao: power, mode, temp, wind de uma vez
      const attempts = [
        ['POST', `/v2.0/infrareds/${body.infrared_id}/air-conditioners/${body.remote_id}/scenes/command`, { power: v.power, mode: v.mode, temp: v.temp, wind: v.wind }],
        ['POST', `/v2.0/infrareds/${body.infrared_id}/air-conditioners/${body.remote_id}/command`, { code: body.acCode || 'power', value: v.power }],
      ];
      let last = 'falhou';
      for (const [m, p, b] of attempts) {
        try { const j = await tuya(m, p, b); if (j.success) return Response.json({ ok: true }); last = j.msg || last; } catch (e) { last = String(e.message || e); }
      }
      return Response.json({ error: last }, { status: 500 });
    }
    // ---- Aparelho normal (tomada, luz) ----
    // tenta o code informado; se for switch e falhar, tenta variantes comuns de lâmpada
    const codeVariants = [body.code];
    if (/^switch/.test(body.code || '')) { ['switch_led', 'switch_1', 'switch'].forEach((c) => { if (!codeVariants.includes(c)) codeVariants.push(c); }); }
    let lastErr = 'comando falhou';
    for (const code of codeVariants) {
      try {
        const j = await tuya('POST', `/v1.0/devices/${body.deviceId}/commands`, { commands: [{ code, value: body.value }] });
        if (j.success) return Response.json({ ok: true, usedCode: code });
        lastErr = 'code ' + (j.code != null ? j.code : '?') + ': ' + (j.msg || '');
      } catch (e) { lastErr = String(e.message || e); }
    }
    return Response.json({ error: lastErr }, { status: 500 });
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 500 });
  }
}
