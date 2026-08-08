const iso = (d) => d.toISOString().slice(0, 10);

/** Busca o id de usuario da Oura (diferente do nosso uuid) para casar com o webhook. */
export async function fetchOuraUserId(token) {
  try {
    const r = await fetch('https://api.ouraring.com/v2/usercollection/personal_info', {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
    if (!r.ok) return null;
    const j = await r.json();
    return j.id || null;
  } catch (e) {
    return null;
  }
}

/** Puxa os dados da Oura (mesma logica usada pelo GET /api/oura). */
export async function fetchOuraData(token) {
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

  const pullTemp = async () => {
    try {
      const r = await fetch(`https://api.ouraring.com/v2/usercollection/daily_readiness?${q}`, { headers: h, cache: 'no-store' });
      if (r.ok) {
        const j = await r.json();
        (j.data || []).forEach((row) => {
          const d = row.day; if (!d) return;
          byDate[d] = byDate[d] || {};
          if (row.temperature_deviation != null) byDate[d].tempDeviation = Math.round(row.temperature_deviation * 10) / 10;
        });
      }
    } catch (e) { errors.push(String(e.message || e)); }
  };

  let lastSleep = null;
  const pullLastSleep = async () => {
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
  };

  await Promise.all([
    pull('daily_readiness', 'readiness'),
    pull('daily_sleep', 'sleep'),
    pull('daily_activity', 'activity'),
    pullTemp(),
    pullLastSleep(),
  ]);

  return { byDate, lastSleep, errors };
}

/** Recarrega os dados da Oura para um usuario e grava no cache (chamado pelo webhook). */
export async function refreshOuraCache(db, user_id, token) {
  const { byDate, lastSleep } = await fetchOuraData(token);
  await db.from('oura_cache').upsert({
    user_id,
    by_date: byDate,
    last_sleep: lastSleep,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'user_id' });
}
