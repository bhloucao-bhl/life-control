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

  // Detalhe do sono mais recente: fases + movimento
  let lastSleep = null;
  try {
    const r = await fetch(`https://api.ouraring.com/v2/usercollection/sleep?${q}`, { headers: h, cache: 'no-store' });
    if (!r.ok) throw new Error('sleep HTTP ' + r.status);
    const j = await r.json();
    const rows = (j.data || []).filter((x) => (x.type === 'long_sleep' || x.type === 'sleep'));
    const last = rows.sort((a, b) => String(a.bedtime_start).localeCompare(String(b.bedtime_start))).pop();
    if (last) {
      lastSleep = {
        day: last.day,
        start: last.bedtime_start,
        end: last.bedtime_end,
        total: last.total_sleep_duration || null,
        deep: last.deep_sleep_duration || null,
        rem: last.rem_sleep_duration || null,
        light: last.light_sleep_duration || null,
        awake: last.awake_time || null,
        efficiency: last.efficiency || null,
        hrLowest: last.lowest_heart_rate || null,
        hrAvg: last.average_heart_rate || null,
        hrv: last.average_hrv || null,
        // hipnograma: 1=deep 2=light 3=rem 4=awake
        phases: last.sleep_phase_5_min || null,
      };
    }
  } catch (e) { errors.push(String(e.message || e)); }

  return Response.json({ connected: true, byDate, lastSleep, errors }, {
    headers: { 'Cache-Control': 'private, s-maxage=900' },
  });
}
