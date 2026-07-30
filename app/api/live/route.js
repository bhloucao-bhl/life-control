export const runtime = 'nodejs';
export const revalidate = 0;

/**
 * Dados ao vivo: clima (open-meteo) + cambio (varias fontes em cascata).
 * Todas as APIs sao publicas e gratuitas, sem chave.
 */

// ---------- Cambio: tenta as fontes em ordem ate uma responder ----------
async function fxAwesome() {
  const r = await fetch('https://economia.awesomeapi.com.br/last/USD-BRL,EUR-BRL', { next: { revalidate: 600 } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  const pick = (k, code) => {
    const v = j[k];
    if (!v || !v.bid) return null;
    const pct = v.pctChange != null ? Number(v.pctChange) : null;
    return { code, value: Number(v.bid), pct: isNaN(pct) ? null : pct };
  };
  const out = [pick('USDBRL', 'USD'), pick('EURBRL', 'EUR')].filter(Boolean);
  if (!out.length) throw new Error('sem dados');
  return { fx: out, source: 'awesomeapi' };
}

async function fxErApi() {
  // 1 BRL = rates.USD dolares  ->  USD/BRL = 1 / rates.USD
  const r = await fetch('https://open.er-api.com/v6/latest/BRL', { next: { revalidate: 600 } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  const rates = j && j.rates;
  if (!rates || !rates.USD || !rates.EUR) throw new Error('sem rates');
  return {
    fx: [
      { code: 'USD', value: 1 / Number(rates.USD), pct: null },
      { code: 'EUR', value: 1 / Number(rates.EUR), pct: null },
    ],
    source: 'er-api',
  };
}

async function fxFrankfurter() {
  const r = await fetch('https://api.frankfurter.dev/v1/latest?base=BRL&symbols=USD,EUR', { next: { revalidate: 600 } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  const rates = j && j.rates;
  if (!rates || !rates.USD || !rates.EUR) throw new Error('sem rates');
  return {
    fx: [
      { code: 'USD', value: 1 / Number(rates.USD), pct: null },
      { code: 'EUR', value: 1 / Number(rates.EUR), pct: null },
    ],
    source: 'frankfurter',
  };
}

async function getFx(errors) {
  const chain = [['awesomeapi', fxAwesome], ['er-api', fxErApi], ['frankfurter', fxFrankfurter]];
  for (const [name, fn] of chain) {
    try {
      const res = await fn();
      if (res && res.fx && res.fx.length) return res;
    } catch (e) {
      errors.push('fx/' + name + ': ' + String(e.message || e));
    }
  }
  return { fx: null, source: null };
}

export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const lat = searchParams.get('lat') || '-23.5505';
  const lon = searchParams.get('lon') || '-46.6333';

  const out = { weather: null, fx: null, fxSource: null, errors: [] };

  // ---------- Clima ----------
  try {
    const wxUrl =
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&current=temperature_2m,apparent_temperature,weather_code,relative_humidity_2m,wind_speed_10m,precipitation` +
      `&hourly=precipitation_probability,temperature_2m` +
      `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,uv_index_max,sunrise,sunset,wind_speed_10m_max` +
      `&timezone=auto&forecast_days=6`;
    const r = await fetch(wxUrl, { next: { revalidate: 900 } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    const cur = j.current || {};
    const d = j.daily || {};
    const num = (arr, i, r) => (arr && arr[i] != null ? (r ? Math.round(arr[i]) : arr[i]) : null);
    const days = (d.time || []).slice(0, 6).map((iso, i) => ({
      date: iso,
      code: d.weather_code ? d.weather_code[i] : 0,
      hi: num(d.temperature_2m_max, i, true),
      lo: num(d.temperature_2m_min, i, true),
      rainProb: num(d.precipitation_probability_max, i, true),
      rainMm: num(d.precipitation_sum, i),
      uv: num(d.uv_index_max, i, true),
      sunrise: d.sunrise ? String(d.sunrise[i]).slice(11, 16) : null,
      sunset: d.sunset ? String(d.sunset[i]).slice(11, 16) : null,
      windMax: num(d.wind_speed_10m_max, i, true),
    }));
    // proximas 12 horas de chuva
    const hh = j.hourly || {};
    const nowIso = new Date().toISOString().slice(0, 13);
    let idx = (hh.time || []).findIndex((x) => String(x).slice(0, 13) >= nowIso);
    if (idx < 0) idx = 0;
    const hours = (hh.time || []).slice(idx, idx + 12).map((x, k) => ({
      h: String(x).slice(11, 16),
      rain: hh.precipitation_probability ? hh.precipitation_probability[idx + k] : null,
      temp: hh.temperature_2m ? Math.round(hh.temperature_2m[idx + k]) : null,
    }));
    out.weather = {
      temp: cur.temperature_2m != null ? Math.round(cur.temperature_2m) : null,
      feels: cur.apparent_temperature != null ? Math.round(cur.apparent_temperature) : null,
      code: cur.weather_code != null ? cur.weather_code : 0,
      hi: days[0] ? days[0].hi : null,
      lo: days[0] ? days[0].lo : null,
      humidity: cur.relative_humidity_2m != null ? Math.round(cur.relative_humidity_2m) : null,
      wind: cur.wind_speed_10m != null ? Math.round(cur.wind_speed_10m) : null,
      precipitation: cur.precipitation != null ? cur.precipitation : null,
      days, hours,
      tz: j.timezone || null,
    };
  } catch (e) {
    out.errors.push('weather: ' + String(e.message || e));
  }

  // ---------- Cambio ----------
  const fxRes = await getFx(out.errors);
  out.fx = fxRes.fx;
  out.fxSource = fxRes.source;

  // Se a fonte nao trouxe variacao, compara com o fechamento anterior.
  if (out.fx && out.fx.some((x) => x.pct == null)) {
    try {
      const d = new Date(Date.now() - 4 * 86400000).toISOString().slice(0, 10);
      const r = await fetch(`https://api.frankfurter.dev/v1/${d}..?base=BRL&symbols=USD,EUR`, { next: { revalidate: 3600 } });
      if (r.ok) {
        const j = await r.json();
        const dates = Object.keys(j.rates || {}).sort();
        const prev = dates.length > 1 ? j.rates[dates[dates.length - 2]] : null;
        if (prev) {
          out.fx = out.fx.map((x) => {
            if (x.pct != null) return x;
            const p = prev[x.code] ? 1 / Number(prev[x.code]) : null;
            return p ? { ...x, pct: Number((((x.value - p) / p) * 100).toFixed(2)) } : x;
          });
        }
      }
    } catch (e) { out.errors.push('fx/pct: ' + String(e.message || e)); }
  }

  return Response.json(out, {
    headers: { 'Cache-Control': 'public, s-maxage=600, stale-while-revalidate=1800' },
  });
}
