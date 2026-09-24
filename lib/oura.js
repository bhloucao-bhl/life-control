import { mergeHealthDaily } from './healthDaily';
import { brDate } from './tz';

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

// Escopos que o app pede no login da Oura (ver lib/oauth.js). Um escopo que o token não tem faz
// o endpoint correspondente responder 401 — aí o dado simplesmente não aparece, e a tela de
// Ajustes avisa pra reconectar (ver OURA_SCOPES_NEEDED / GET /api/connect).
export const OURA_SCOPES = 'personal daily heartrate workout session spo2 stress heart_health ring_configuration';
export const OURA_SCOPES_NEEDED = ['daily', 'personal', 'heartrate', 'workout', 'session', 'spo2', 'stress', 'heart_health'];

const OURA_BASE = 'https://api.ouraring.com/v2/usercollection/';
const r1 = (n) => (n == null || isNaN(n) ? null : Math.round(n * 10) / 10);
const toMin = (sec) => (sec == null ? null : Math.round(sec / 60));
const avgOf = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
// contribuidores das notas (readiness/sleep/activity/resiliência) vêm como { chave: 0-100 } —
// guarda só os numéricos, arredondados, pra não inflar o histórico.
const contribs = (o) => {
  if (!o || typeof o !== 'object') return null;
  const out = {};
  Object.entries(o).forEach(([k, v]) => { if (typeof v === 'number') out[k] = Math.round(v); });
  return Object.keys(out).length ? out : null;
};
// média de uma série de amostras da Oura ({ items: [..] }), ignorando buracos (null)
const sampleAvg = (smp) => {
  const vals = ((smp && smp.items) || []).filter((x) => typeof x === 'number');
  return vals.length ? Math.round(avgOf(vals)) : null;
};

/** GET paginado (next_token) num endpoint da coleção do usuário. Lança Error com .status. */
async function ouraGetAll(token, path, query, maxPages = 12) {
  const rows = [];
  let next = null;
  for (let i = 0; i < maxPages; i++) {
    const qs = query + (next ? `&next_token=${encodeURIComponent(next)}` : '');
    const r = await fetch(`${OURA_BASE}${path}?${qs}`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) {
      const e = new Error(`${path} HTTP ${r.status}`);
      e.status = r.status;
      throw e;
    }
    const j = await r.json();
    rows.push(...(j.data || []));
    next = j.next_token;
    if (!next) break;
  }
  return rows;
}

/**
 * Puxa TUDO que a Oura oferece (menos tags) numa janela de 13 dias.
 * Devolve:
 *  - byDate: campos por dia (vão pro oura_cache e pro histórico permanente health_daily)
 *  - lastSleep: detalhe da última noite (hipnograma, curvas de FC/HRV)
 *  - extra: o que não é "por dia" — curva de FC das últimas 24h, perfil, horário ideal de dormir,
 *    modo descanso em andamento
 *  - sources: status de cada endpoint ('ok' | 'sem permissão' | 'erro ...') pro diagnóstico
 */
export async function fetchOuraData(token) {
  const now = new Date();
  const start = new Date(now.getTime() - 13 * 86400000);
  const tomorrow = new Date(now.getTime() + 86400000);
  const q = `start_date=${iso(start)}&end_date=${iso(tomorrow)}`;
  const byDate = {};
  const extra = {};
  const errors = [];
  const sources = {};
  const day = (d) => (byDate[d] = byDate[d] || {});

  // roda um endpoint isolado: erro de um (ex.: escopo não concedido) não derruba os outros
  const run = async (path, query, handle) => {
    try {
      const rows = await ouraGetAll(token, path, query);
      handle(rows);
      sources[path] = 'ok';
    } catch (e) {
      sources[path] = e.status === 401 || e.status === 403 ? 'sem permissão' : String(e.message || e);
      errors.push(String(e.message || e));
    }
  };

  let lastSleep = null;

  await Promise.all([
    run('daily_readiness', q, (rows) => rows.forEach((row) => {
      if (!row.day) return;
      const d = day(row.day);
      if (row.score != null) d.readiness = Math.round(row.score);
      if (row.temperature_deviation != null) d.tempDeviation = r1(row.temperature_deviation);
      if (row.temperature_trend_deviation != null) d.tempTrendDeviation = r1(row.temperature_trend_deviation);
      const c = contribs(row.contributors); if (c) d.readinessContrib = c;
    })),

    run('daily_sleep', q, (rows) => rows.forEach((row) => {
      if (!row.day) return;
      const d = day(row.day);
      if (row.score != null) d.sleep = Math.round(row.score);
      const c = contribs(row.contributors); if (c) d.sleepContrib = c;
    })),

    run('daily_activity', q, (rows) => rows.forEach((row) => {
      if (!row.day) return;
      const d = day(row.day);
      if (row.score != null) d.activity = Math.round(row.score);
      if (row.steps != null) d.steps = row.steps;
      if (row.active_calories != null) d.activeCalories = row.active_calories;
      if (row.total_calories != null) d.totalCalories = row.total_calories;
      if (row.target_calories != null) d.targetCalories = row.target_calories;
      if (row.equivalent_walking_distance != null) d.walkingDistanceKm = r1(row.equivalent_walking_distance / 1000);
      if (row.high_activity_time != null) d.highActivityMin = toMin(row.high_activity_time);
      if (row.medium_activity_time != null) d.mediumActivityMin = toMin(row.medium_activity_time);
      if (row.low_activity_time != null) d.lowActivityMin = toMin(row.low_activity_time);
      if (row.sedentary_time != null) d.sedentaryMin = toMin(row.sedentary_time);
      if (row.non_wear_time != null) d.nonWearMin = toMin(row.non_wear_time);
      if (row.inactivity_alerts != null) d.inactivityAlerts = row.inactivity_alerts;
      const c = contribs(row.contributors); if (c) d.activityContrib = c;
    })),

    run('sleep', q, (rows) => {
      const periods = rows.filter((x) => x.day && x.type !== 'deleted');
      // um dia pode ter vários períodos (noite + cochilos): o principal é o long_sleep, ou o mais longo
      const byDay = {};
      periods.forEach((p) => { (byDay[p.day] = byDay[p.day] || []).push(p); });
      Object.entries(byDay).forEach(([dd, list]) => {
        const main = list.find((p) => p.type === 'long_sleep') || [...list].sort((a, b) => (b.total_sleep_duration || 0) - (a.total_sleep_duration || 0))[0];
        const d = day(dd);
        if (main.total_sleep_duration != null) d.sleepTotalMin = toMin(main.total_sleep_duration);
        if (main.time_in_bed != null) d.timeInBedMin = toMin(main.time_in_bed);
        if (main.efficiency != null) d.sleepEfficiency = main.efficiency;
        if (main.latency != null) d.sleepLatencyMin = toMin(main.latency);
        if (main.deep_sleep_duration != null) d.deepMin = toMin(main.deep_sleep_duration);
        if (main.rem_sleep_duration != null) d.remMin = toMin(main.rem_sleep_duration);
        if (main.light_sleep_duration != null) d.lightMin = toMin(main.light_sleep_duration);
        if (main.awake_time != null) d.awakeMin = toMin(main.awake_time);
        if (main.lowest_heart_rate != null) d.sleepLowestHR = main.lowest_heart_rate;
        if (main.average_heart_rate != null) d.sleepAvgHR = r1(main.average_heart_rate);
        if (main.average_hrv != null) d.sleepHRV = Math.round(main.average_hrv);
        if (main.average_breath != null) d.respRate = r1(main.average_breath);
        if (main.restless_periods != null) d.restlessPeriods = main.restless_periods;
        if (main.bedtime_start) d.bedtimeStart = main.bedtime_start;
        if (main.bedtime_end) d.bedtimeEnd = main.bedtime_end;
        const naps = list.filter((p) => p !== main && ['sleep', 'late_nap'].includes(p.type));
        const napSec = naps.reduce((a, p) => a + (p.total_sleep_duration || 0), 0);
        if (napSec > 0) d.napMin = toMin(napSec);
      });

      // "última noite" = o long_sleep mais recente; um cochilo depois dela não pode tomar o lugar
      const byStart = (a, b) => String(a.bedtime_start).localeCompare(String(b.bedtime_start));
      const last = periods.filter((x) => x.type === 'long_sleep').sort(byStart).pop()
        || periods.filter((x) => x.type === 'sleep').sort(byStart).pop();
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
          timeInBed: last.time_in_bed || null,
          latency: last.latency ?? null,
          efficiency: last.efficiency || null,
          hrLowest: last.lowest_heart_rate || null,
          hrAvg: last.average_heart_rate || null,
          hrv: last.average_hrv || null,
          respRate: r1(last.average_breath),
          restless: last.restless_periods ?? null,
          // hipnograma: 1=deep 2=light 3=rem 4=awake
          phases: last.sleep_phase_5_min || null,
          // curvas da noite, uma amostra a cada `interval` segundos a partir de `timestamp`
          hrSeries: last.heart_rate && last.heart_rate.items ? { interval: last.heart_rate.interval, start: last.heart_rate.timestamp, items: last.heart_rate.items.map((v) => (v == null ? null : Math.round(v))) } : null,
          hrvSeries: last.hrv && last.hrv.items ? { interval: last.hrv.interval, start: last.hrv.timestamp, items: last.hrv.items.map((v) => (v == null ? null : Math.round(v))) } : null,
        };
      }
    }),

    run('daily_spo2', q, (rows) => rows.forEach((row) => {
      if (!row.day) return;
      const avg = row.spo2_percentage && row.spo2_percentage.average;
      if (avg == null && row.breathing_disturbance_index == null) return;
      const d = day(row.day);
      if (avg != null) d.spo2 = r1(avg);
      if (row.breathing_disturbance_index != null) d.breathingDisturbance = row.breathing_disturbance_index;
    })),

    run('daily_stress', q, (rows) => rows.forEach((row) => {
      if (!row.day) return;
      const d = day(row.day);
      if (row.stress_high != null) d.stressHighMin = toMin(row.stress_high);
      if (row.recovery_high != null) d.recoveryHighMin = toMin(row.recovery_high);
      if (row.day_summary) d.stressSummary = row.day_summary; // restored | normal | stressful
    })),

    run('daily_resilience', q, (rows) => rows.forEach((row) => {
      if (!row.day) return;
      const d = day(row.day);
      if (row.level) d.resilience = row.level; // limited | adequate | solid | strong | exceptional
      const c = contribs(row.contributors); if (c) d.resilienceContrib = c;
    })),

    run('daily_cardiovascular_age', q, (rows) => rows.forEach((row) => {
      if (row.day && row.vascular_age != null) day(row.day).vascularAge = row.vascular_age;
    })),

    run('vO2_max', q, (rows) => rows.forEach((row) => {
      if (row.day && row.vo2_max != null) day(row.day).vo2max = r1(row.vo2_max);
    })),

    run('workout', q, (rows) => rows.forEach((row) => {
      if (!row.day) return;
      const d = day(row.day);
      const min = row.start_datetime && row.end_datetime ? Math.round((new Date(row.end_datetime) - new Date(row.start_datetime)) / 60000) : null;
      (d.ouraWorkouts = d.ouraWorkouts || []).push({
        activity: row.activity || null,
        label: row.label || null,
        start: row.start_datetime || null,
        min,
        kcal: row.calories != null ? Math.round(row.calories) : null,
        km: row.distance != null ? r1(row.distance / 1000) : null,
        intensity: row.intensity || null, // easy | moderate | hard
        source: row.source || null,
      });
      d.ouraWorkoutMin = (d.ouraWorkoutMin || 0) + (min || 0);
    })),

    run('session', q, (rows) => rows.forEach((row) => {
      if (!row.day) return;
      const d = day(row.day);
      const min = row.start_datetime && row.end_datetime ? Math.round((new Date(row.end_datetime) - new Date(row.start_datetime)) / 60000) : null;
      (d.ouraSessions = d.ouraSessions || []).push({
        type: row.type || null, // breathing | meditation | nap | relaxation | rest | body_status
        start: row.start_datetime || null,
        min,
        mood: row.mood || null,
        hrAvg: sampleAvg(row.heart_rate),
        hrvAvg: sampleAvg(row.heart_rate_variability),
      });
    })),

    run('sleep_time', q, (rows) => {
      const last = rows.filter((x) => x.day).sort((a, b) => a.day.localeCompare(b.day)).pop();
      if (last) {
        extra.sleepTime = {
          day: last.day,
          // offsets em segundos a partir da meia-noite do dia (negativo = antes da meia-noite)
          optimalStart: last.optimal_bedtime ? last.optimal_bedtime.start_offset : null,
          optimalEnd: last.optimal_bedtime ? last.optimal_bedtime.end_offset : null,
          recommendation: last.recommendation || null,
          status: last.status || null,
        };
      }
    }),

    run('rest_mode_period', q, (rows) => rows.forEach((row) => {
      const from = row.start_day;
      if (!from) return;
      const to = row.end_day || iso(now);
      for (let t = new Date(from + 'T12:00:00Z'); iso(t) <= to; t = new Date(t.getTime() + 86400000)) {
        if (iso(t) >= iso(start)) day(iso(t)).restMode = true;
      }
      if (!row.end_day) extra.restMode = { since: from };
    })),

    // perfil (idade/sexo/altura/peso) — referência pra idade vascular, VO2 máx etc.
    (async () => {
      try {
        const r = await fetch(`${OURA_BASE}personal_info`, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store', signal: AbortSignal.timeout(8000) });
        if (!r.ok) { sources.personal_info = r.status === 401 || r.status === 403 ? 'sem permissão' : 'HTTP ' + r.status; return; }
        const j = await r.json();
        extra.personal = { age: j.age ?? null, sex: j.biological_sex || null, heightM: j.height ?? null, weightKg: j.weight ?? null };
        sources.personal_info = 'ok';
      } catch (e) { sources.personal_info = String(e.message || e); }
    })(),

    // frequência cardíaca contínua: agrega por dia (mín/máx/média, e média acordado) e guarda a
    // curva das últimas 24h (médias de 5 min) pro gráfico da aba Saúde.
    run('heartrate', `start_datetime=${encodeURIComponent(start.toISOString().slice(0, 19))}&end_datetime=${encodeURIComponent(now.toISOString().slice(0, 19))}`, (rows) => {
      const perDay = {};
      const cutoff = now.getTime() - 24 * 3600000;
      const buckets = {};
      rows.forEach((row) => {
        if (typeof row.bpm !== 'number' || !row.timestamp) return;
        const ms = new Date(row.timestamp).getTime();
        const dd = brDate(ms);
        const p = (perDay[dd] = perDay[dd] || { all: [], awake: [] });
        p.all.push(row.bpm);
        if (row.source === 'awake') p.awake.push(row.bpm);
        if (ms >= cutoff) {
          const k = Math.floor(ms / 300000) * 300000;
          const b = (buckets[k] = buckets[k] || { sum: 0, n: 0, src: {} });
          b.sum += row.bpm; b.n += 1; b.src[row.source] = (b.src[row.source] || 0) + 1;
        }
      });
      Object.entries(perDay).forEach(([dd, p]) => {
        if (!p.all.length) return;
        const d = day(dd);
        d.hrMin = Math.min(...p.all);
        d.hrMax = Math.max(...p.all);
        d.hrAvg = Math.round(avgOf(p.all));
        if (p.awake.length) d.hrAwakeAvg = Math.round(avgOf(p.awake));
      });
      // [epoch ms, bpm, fonte] — fonte: awake | rest | sleep | session | live | workout
      extra.hr24h = Object.keys(buckets).map(Number).sort((a, b) => a - b).map((k) => {
        const b = buckets[k];
        const src = Object.entries(b.src).sort((a, c) => c[1] - a[1])[0][0];
        return [k, Math.round(b.sum / b.n), src];
      });
    }),
  ]);

  // erros de uma chamada (ex: escopo não concedido) não derrubam as outras — loga pra dar pra
  // achar nos logs do servidor quando um campo some sem explicação.
  if (errors.length) console.error('[oura] fetchOuraData:', errors.join(' | '));

  return { byDate, lastSleep, extra, errors, sources };
}

/**
 * Grava o resultado de fetchOuraData no oura_cache. A coluna "extra" veio no schema9.sql — se
 * ela ainda não existir no banco, grava sem ela em vez de perder o cache inteiro.
 */
export async function saveOuraCache(db, user_id, { byDate, lastSleep, extra, sources }) {
  const row = { user_id, by_date: byDate, last_sleep: lastSleep, updated_at: new Date().toISOString() };
  const { error } = await db.from('oura_cache').upsert({ ...row, extra: { ...(extra || {}), sources: sources || null } }, { onConflict: 'user_id' });
  if (error) {
    console.error('[oura] oura_cache com extra falhou, gravando sem:', error.message || error);
    await db.from('oura_cache').upsert(row, { onConflict: 'user_id' });
  }
}

/**
 * Última leitura de bateria do anel (o mesmo % que o app da Oura mostra). Só chega na nuvem
 * quando o anel sincroniza com o celular, então pode estar atrasada — por isso volta junto o
 * horário da leitura. Não vai pro oura_cache: é uma chamada barata e é buscada ao vivo a cada
 * GET /api/oura. Nunca lança: devolve { battery, error } pra nunca derrubar o resto dos dados
 * da Oura, e o "error" aparece no diagnóstico dos Ajustes (senão uma recusa da Oura some calada).
 * Tenta mais de um formato de consulta porque a doc oficial não é acessível daqui e não dá pra
 * ter certeza de qual a Oura aceita.
 */
export async function fetchOuraBattery(token) {
  const fmt = (d) => d.toISOString().slice(0, 19); // YYYY-MM-DDThh:mm:ss
  const now = new Date();
  const from = new Date(now.getTime() - 3 * 86400000);
  const queries = [
    'latest=true',
    `start_datetime=${encodeURIComponent(fmt(from))}&end_datetime=${encodeURIComponent(fmt(now))}`,
    `start_date=${from.toISOString().slice(0, 10)}&end_date=${now.toISOString().slice(0, 10)}`,
  ];
  const errs = [];
  const deadline = Date.now() + 6000; // o GET /api/oura espera por isto — nunca segurar ele muito
  for (const q of queries) {
    const left = deadline - Date.now();
    if (left < 500) { errs.push('tempo esgotado'); break; }
    try {
      const r = await fetch(`https://api.ouraring.com/v2/usercollection/ring_battery_level?${q}`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
        signal: AbortSignal.timeout(Math.min(4000, left)),
      });
      if (!r.ok) {
        const body = (await r.text().catch(() => '')).slice(0, 160);
        errs.push(`[${q.split('=')[0]}] HTTP ${r.status} ${body}`);
        // sem permissão/endpoint inexistente não muda trocando a consulta — para aqui
        if (r.status === 401 || r.status === 403 || r.status === 404) break;
        continue;
      }
      const j = await r.json();
      const rows = (j.data || []).filter((x) => x && x.level != null);
      const last = rows.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp))).pop();
      if (!last) { errs.push(`[${q.split('=')[0]}] sem leituras`); continue; }
      return { battery: { level: Math.round(last.level), charging: !!last.charging, at: last.timestamp || null }, error: null };
    } catch (e) {
      errs.push(`[${q.split('=')[0]}] ${String(e.message || e)}`);
    }
  }
  const error = errs.join(' | ') || 'sem resposta';
  console.error('[oura] ring_battery_level:', error);
  return { battery: null, error };
}

/** Recarrega os dados da Oura para um usuario e grava no cache (chamado pelo webhook e pelo cron). */
export async function refreshOuraCache(db, user_id, token) {
  const data = await fetchOuraData(token);
  await saveOuraCache(db, user_id, data);
  // grava no histórico permanente também (ver lib/healthDaily.js) — o cache acima é só
  // uma janela curta que fica sobrescrita a cada chamada; isto aqui não perde dias antigos.
  await mergeHealthDaily(db, user_id, data.byDate);
}
