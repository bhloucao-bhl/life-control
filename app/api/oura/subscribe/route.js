import { admin, userFromRequest, siteUrl, PROVIDERS } from '../../../../lib/oauth';

export const runtime = 'nodejs';

const DATA_TYPES = ['daily_readiness', 'daily_sleep', 'daily_activity', 'sleep'];
const EVENT_TYPES = ['create', 'update'];

function ouraAppHeaders() {
  return {
    'x-client-id': PROVIDERS.oura.clientId(),
    'x-client-secret': PROVIDERS.oura.clientSecret(),
    'Content-Type': 'application/json',
  };
}

async function listOuraSubscriptions() {
  const r = await fetch('https://api.ouraring.com/v2/webhook/subscription', { headers: ouraAppHeaders(), cache: 'no-store' });
  if (!r.ok) throw new Error('list HTTP ' + r.status);
  return r.json();
}

/** GET -> lista as assinaturas de webhook ativas na Oura (fonte da verdade, não é a nossa tabela). */
export async function GET(req) {
  const user = await userFromRequest(req);
  if (!user) return Response.json({ error: 'Sem sessão.' }, { status: 401 });
  if (!PROVIDERS.oura.clientId() || !PROVIDERS.oura.clientSecret()) {
    return Response.json({ error: 'Faltam OURA_CLIENT_ID/OURA_CLIENT_SECRET na Vercel.' }, { status: 400 });
  }
  try {
    const list = await listOuraSubscriptions();
    return Response.json({ subscriptions: list });
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 502 });
  }
}

/** POST -> cria (uma vez) as assinaturas de webhook para os data_types que o app usa. */
export async function POST(req) {
  const user = await userFromRequest(req);
  if (!user) return Response.json({ error: 'Sem sessão.' }, { status: 401 });
  if (!PROVIDERS.oura.clientId() || !PROVIDERS.oura.clientSecret()) {
    return Response.json({ error: 'Faltam OURA_CLIENT_ID/OURA_CLIENT_SECRET na Vercel.' }, { status: 400 });
  }
  if (!process.env.OURA_WEBHOOK_VERIFICATION_TOKEN) {
    return Response.json({ error: 'Falta OURA_WEBHOOK_VERIFICATION_TOKEN na Vercel (crie um valor secreto aleatório).' }, { status: 400 });
  }

  const callback_url = `${siteUrl(req)}/api/oura/webhook`;
  const db = admin();

  let existing = [];
  try {
    existing = await listOuraSubscriptions();
  } catch (e) {
    return Response.json({ error: 'Não consegui listar assinaturas existentes: ' + String(e.message || e) }, { status: 502 });
  }
  const already = new Set(
    (existing || [])
      .filter((s) => s.callback_url === callback_url)
      .map((s) => `${s.data_type}:${s.event_type}`)
  );

  const created = [];
  const failed = [];
  const skipped = [];

  for (const data_type of DATA_TYPES) {
    for (const event_type of EVENT_TYPES) {
      const key = `${data_type}:${event_type}`;
      if (already.has(key)) { skipped.push(key); continue; }

      try {
        const r = await fetch('https://api.ouraring.com/v2/webhook/subscription', {
          method: 'POST',
          headers: ouraAppHeaders(),
          body: JSON.stringify({
            callback_url,
            verification_token: process.env.OURA_WEBHOOK_VERIFICATION_TOKEN,
            event_type,
            data_type,
          }),
        });
        const j = await r.json();
        if (!r.ok) throw new Error(`HTTP ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);

        await db.from('oura_webhook_subscriptions').upsert({
          id: j.id,
          data_type,
          event_type,
          expiration_time: j.expiration_time || null,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'id' });

        created.push(key);
      } catch (e) {
        failed.push({ key, error: String(e.message || e) });
      }
    }
  }

  return Response.json({ callback_url, created, skipped, failed });
}
