import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';

/**
 * Proxy do Claude.
 * A chave da Anthropic fica SO no servidor (variavel de ambiente da Vercel).
 * Exige usuario logado — ninguem de fora consegue gastar sua cota.
 */
export async function POST(req) {
  try {
    const token = (req.headers.get('authorization') || '').replace('Bearer ', '');
    if (!token) return Response.json({ error: 'Sem sessão.' }, { status: 401 });

    const admin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      { auth: { persistSession: false } }
    );
    const { data, error } = await admin.auth.getUser(token);
    if (error || !data || !data.user) {
      return Response.json({ error: 'Sessão inválida.' }, { status: 401 });
    }

    const body = await req.json();

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: body.model || 'claude-sonnet-4-6',
        max_tokens: body.max_tokens || 4096,
        system: body.system,
        messages: body.messages || [],
      }),
    });

    const json = await res.json();
    return Response.json(json, { status: res.status });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
