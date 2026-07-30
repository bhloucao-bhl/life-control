import { userFromRequest, validToken } from '../../../lib/oauth';

export const runtime = 'nodejs';

const iso = (d) => d.toISOString().slice(0, 10);

/** GET /api/oura -> { byDate: { 'YYYY-MM-DD': { readiness, sleep } } } */
export async function GET(req) {
  const user = await userFromRequest(req);
  if (!user) return Response.json({ error: 'Sem sessão.' }, { status: 401 });

  const token = await validToken(user.id, 'oura');
  if (!token) return Response.json({ connected: false, byDate: {} });

  const end = new Date();
  const start = new Date(Date.now() - 13 * 86400000);
  const q = `start_date=${iso(start)}&end_date=${iso(end)}`;
  const h = { Authorization: `Bearer ${token}` };
  const byDate = {};
  const errors = [];

  const pull = async (path, field) => {
    try {
      const r = await fetch(`https://api.ouraring.com/v2/usercollection/${path}?${q}`, { headers: h, cache: 'no-store' });
      if (!r.ok) throw new Error(path + ' HTTP ' + r.status);
      const j = await r.json();
      (j.data || []).forEach((row) => {
        const d = row.day;
        if (!d) return;
        byDate[d] = byDate[d] || {};
        if (row.score != null) byDate[d][field] = Math.round(row.score);
      });
    } catch (e) {
      errors.push(String(e.message || e));
    }
  };

  await pull('daily_readiness', 'readiness');
  await pull('daily_sleep', 'sleep');

  return Response.json({ connected: true, byDate, errors }, {
    headers: { 'Cache-Control': 'private, s-maxage=900' },
  });
}
