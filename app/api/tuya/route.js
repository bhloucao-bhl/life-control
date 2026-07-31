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
  if (!j.success) throw new Error('token: ' + (j.msg || JSON.stringify(j)).slice(0, 160));
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

/** GET -> lista de aparelhos com estado */
export async function GET(req) {
  const user = await userFromRequest(req);
  if (!user) return Response.json({ error: 'Sem sessão.' }, { status: 401 });
  if (!process.env.TUYA_CLIENT_ID) return Response.json({ configured: false, devices: [] });

  const uid = process.env.TUYA_UID;
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

  const { deviceId, code, value } = await req.json();
  try {
    const j = await tuya('POST', `/v1.0/devices/${deviceId}/commands`, { commands: [{ code, value }] });
    if (!j.success) throw new Error(j.msg || 'comando falhou');
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 500 });
  }
}
