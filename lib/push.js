import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import { admin as supabaseAdmin } from './oauth';

/**
 * Credenciais do service account do Firebase. Prioriza FIREBASE_SERVICE_ACCOUNT_B64
 * (o JSON inteiro em base64 — imune a corrupção de copia-cola de valor multi-linha)
 * e cai pras 3 vars separadas (FIREBASE_PROJECT_ID/CLIENT_EMAIL/PRIVATE_KEY) se a
 * primeira não estiver setada.
 */
function firebaseCredentials() {
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64;
  if (b64) {
    const json = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    return { projectId: json.project_id, clientEmail: json.client_email, privateKey: json.private_key };
  }
  return {
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    // a Vercel guarda a env var com \n literais — precisa virar quebra de linha de verdade
    privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
  };
}

/** App do firebase-admin, inicializado uma vez por instância serverless. */
function firebaseApp() {
  if (getApps().length) return getApps()[0];
  return initializeApp({ credential: cert(firebaseCredentials()) });
}

/**
 * Manda uma push notification pra todos os devices do usuário.
 * Remove do banco os tokens que o FCM devolver como inválidos/desregistrados.
 * Não lança erro se o usuário não tiver nenhum device registrado.
 */
export async function sendPush(userId, { title, body, data } = {}) {
  const db = supabaseAdmin();
  const { data: rows } = await db.from('push_tokens').select('token').eq('user_id', userId);
  const tokens = (rows || []).map((r) => r.token);
  if (!tokens.length) return { sent: 0, failed: 0 };

  const messaging = getMessaging(firebaseApp());
  const res = await messaging.sendEachForMulticast({
    tokens,
    notification: { title, body },
    data: Object.fromEntries(Object.entries(data || {}).map(([k, v]) => [k, String(v)])),
    apns: { payload: { aps: { sound: 'default' } } },
  });

  const stale = [];
  res.responses.forEach((r, i) => {
    if (!r.success && ['messaging/registration-token-not-registered', 'messaging/invalid-argument'].includes(r.error && r.error.code)) {
      stale.push(tokens[i]);
    }
  });
  if (stale.length) await db.from('push_tokens').delete().in('token', stale);

  return { sent: res.successCount, failed: res.failureCount };
}
