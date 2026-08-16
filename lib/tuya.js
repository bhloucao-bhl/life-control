import crypto from 'crypto';

/**
 * Helpers de assinatura/host compartilhados entre a API de dispositivos
 * (app/api/tuya/route.js, credenciais de projeto TUYA_CLIENT_ID/SECRET) e o
 * login OAuth2 do usuário final (TUYA_AUTH_CLIENT_ID/SECRET, ver
 * exchangeTuyaUserCode abaixo) — são credenciais diferentes na Tuya, mas a
 * forma de assinar as chamadas à Cloud API é a mesma.
 */

export const REGION_HOST = {
  us: 'https://openapi.tuyaus.com',
  eu: 'https://openapi.tuyaeu.com',
  cn: 'https://openapi.tuyacn.com',
  in: 'https://openapi.tuyain.com',
};

export function tuyaHost() {
  const r = (process.env.TUYA_REGION || 'us').toLowerCase();
  return REGION_HOST[r] || REGION_HOST.us;
}

export function sha256hex(s) {
  return crypto.createHash('sha256').update(s || '', 'utf8').digest('hex');
}

export function hmac(msg, secret) {
  return crypto.createHmac('sha256', secret).update(msg, 'utf8').digest('hex').toUpperCase();
}

/**
 * Troca o "code" devolvido pela tela de login OAuth2 da Tuya (Link App
 * Account > Configure OAuth 2.0 Authorization, no painel iot.tuya.com)
 * pelo access_token/uid do usuário que autorizou. Usa client_id/secret de
 * "App Authorization" — TUYA_AUTH_CLIENT_ID/TUYA_AUTH_CLIENT_SECRET — que
 * são diferentes do client_id/secret da Cloud API (TUYA_CLIENT_ID/SECRET)
 * usado pra controlar os dispositivos.
 */
export async function exchangeTuyaUserCode(code) {
  const id = process.env.TUYA_AUTH_CLIENT_ID;
  const secret = process.env.TUYA_AUTH_CLIENT_SECRET;
  if (!id || !secret) throw new Error('Faltam TUYA_AUTH_CLIENT_ID/TUYA_AUTH_CLIENT_SECRET na Vercel.');

  const t = Date.now().toString();
  const path = `/v1.0/token?grant_type=2&code=${encodeURIComponent(code)}`;
  const contentHash = sha256hex('');
  const stringToSign = `GET\n${contentHash}\n\n${path}`;
  const sign = hmac(id + t + stringToSign, secret);

  const r = await fetch(tuyaHost() + path, {
    headers: { client_id: id, sign, t, sign_method: 'HMAC-SHA256', 'Content-Type': 'application/json' },
  });
  const j = await r.json();
  if (!j.success) throw new Error('Tuya [' + (j.code != null ? j.code : '?') + ']: ' + (j.msg || JSON.stringify(j)));
  return j.result; // { access_token, refresh_token, uid, expire_time, ... }
}
