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

/** POST { deviceId, action } -> controla o aparelho */
export async function POST(req) {
  const user = await userFromRequest(req);
  if (!user) return Response.json({ error: 'Sem sessão.' }, { status: 401 });
  if (!process.env.LG_PAT) return Response.json({ error: 'LG não configurado.' }, { status: 400 });

  const { deviceId, action } = await req.json();
  try {
    // status atual
    if (action === 'status') {
      const r = await fetch(`${BASE}/devices/${deviceId}/state`, { headers: headers(), cache: 'no-store' });
      const j = await r.json();
      if (!r.ok) throw new Error((j.error && j.error.message) || ('HTTP ' + r.status));
      return Response.json({ ok: true, state: j.response || j });
    }
    // liga/desliga (operação padrão para muitos aparelhos)
    const body = { operation: { [action === 'off' ? 'airConOperationMode' : 'airConOperationMode']: action === 'off' ? 'POWER_OFF' : 'POWER_ON' } };
    const r = await fetch(`${BASE}/devices/${deviceId}/control`, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
    const j = await r.json();
    if (!r.ok) throw new Error((j.error && j.error.message) || ('HTTP ' + r.status));
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 500 });
  }
}
