import crypto from 'crypto';

/**
 * Helpers de assinatura/host compartilhados entre as rotas que falam com a
 * Cloud API da Tuya (app/api/tuya/route.js, controle dos dispositivos, e
 * app/api/admin/tuya-link, que só grava o UID vinculado manualmente).
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
