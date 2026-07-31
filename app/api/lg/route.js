import crypto from 'crypto';
import { userFromRequest } from '../../../lib/oauth';

export const runtime = 'nodejs';

/**
 * Integração LG ThinQ (Connect API) via Personal Access Token.
 * O token é criado em https://connect-pat.lgthinq.com e vai na Vercel.
 */

const BASE = 'https://api-aic.lgthinq.com'; // endpoint global (Américas)

function headers() {
  return {
    Authorization: `Bearer ${process.env.LG_PAT}`,
    'x-country': process.env.LG_COUNTRY || 'BR',
    'x-message-id': crypto.randomBytes(16).toString('base64url').slice(0, 22),
    'x-client-id': process.env.LG_CLIENT_ID || 'life-control-client',
    'x-api-key': 'v6GFvkweNo7DK7yD3ylIZ9w52aKBU0eJ7wLXkSR3', // chave pública documentada do ThinQ Connect
    'Content-Type': 'application/json',
  };
}

// A LG ThinQ tem hosts por regiao; tentamos os das Americas.
const LG_HOSTS = [
  'https://api-aic.lgthinq.com',
  'https://api-kic.lgthinq.com',
  'https://api-eic.lgthinq.com',
];

/** GET -> lista de aparelhos LG. ?debug=1 devolve a resposta crua. */
export async function GET(req) {
  const user = await userFromRequest(req);
  if (!user) return Response.json({ error: 'Sem sessão.' }, { status: 401 });
  if (!process.env.LG_PAT) return Response.json({ configured: false, devices: [] });

  const debug = new URL(req.url).searchParams.get('debug');
  const attempts = [];

  for (const host of LG_HOSTS) {
    try {
      const r = await fetch(`${host}/devices`, { headers: headers(), cache: 'no-store' });
      const text = await r.text();
      let j = null; try { j = JSON.parse(text); } catch (e) {}
      attempts.push({ host, status: r.status, body: (j || text) });
      if (r.ok && j) {
        const list = (j.response || j.devices || (Array.isArray(j) ? j : []));
        const devices = (Array.isArray(list) ? list : []).map((d) => ({
          id: d.deviceId || d.device_id,
          name: (d.deviceInfo && (d.deviceInfo.alias || d.deviceInfo.modelName)) || d.alias || d.deviceId,
          type: (d.deviceInfo && d.deviceInfo.deviceType) || d.deviceType || null,
          online: (d.deviceInfo && d.deviceInfo.reportable) !== false,
        }));
        if (debug) return Response.json({ configured: true, connected: true, devices, attempts });
        return Response.json({ configured: true, connected: true, devices, host });
      }
    } catch (e) {
      attempts.push({ host, error: String(e.message || e) });
    }
  }
  return Response.json({ configured: true, connected: false, devices: [], attempts });
}

/** GET status detalhado de um device */
async function deviceState(host, deviceId) {
  const r = await fetch(`${host}/devices/${deviceId}/state`, { headers: headers(), cache: 'no-store' });
  const j = await r.json();
  if (!r.ok) throw new Error((j && j.error && j.error.message) || ('HTTP ' + r.status));
  return j.response || j;
}

async function control(host, deviceId, body) {
  const r = await fetch(`${host}/devices/${deviceId}/control`, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error((j && j.error && j.error.message) || ('HTTP ' + r.status) + ' ' + JSON.stringify(j).slice(0, 200));
  return j;
}

/**
 * POST
 *   { deviceId, op: 'status' }
 *   { deviceId, op: 'power', value: true|false }        (ar-condicionado)
 *   { deviceId, op: 'temp', value: 23 }
 *   { deviceId, op: 'mode', value: 'COOL'|'HEAT'|'AIR_DRY'|'FAN'|'AIR_CLEAN' }
 *   { deviceId, op: 'wind', value: 'LOW'|'MID'|'HIGH' }
 */
export async function POST(req) {
  const user = await userFromRequest(req);
  if (!user) return Response.json({ error: 'Sem sessão.' }, { status: 401 });
  if (!process.env.LG_PAT) return Response.json({ error: 'LG não configurado.' }, { status: 400 });

  const b = await req.json();
  const host = b.host || 'https://api-aic.lgthinq.com';

  try {
    if (b.op === 'status') {
      const st = await deviceState(host, b.deviceId);
      return Response.json({ ok: true, state: st });
    }
    let body = null;
    if (b.op === 'power') body = { operation: { airConOperationMode: b.value ? 'POWER_ON' : 'POWER_OFF' } };
    else if (b.op === 'temp') body = { temperature: { targetTemperature: Number(b.value), unit: 'C' } };
    else if (b.op === 'mode') body = { airConJobMode: { currentJobMode: b.value } };
    else if (b.op === 'wind') body = { airFlow: { windStrength: b.value } };
    else return Response.json({ error: 'op inválida' }, { status: 400 });

    await control(host, b.deviceId, body);
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 500 });
  }
}
