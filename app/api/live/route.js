export const runtime = 'nodejs';
export const revalidate = 0;

/**
 * Dados ao vivo: clima (open-meteo) + cambio (AwesomeAPI).
 * Ambos sao APIs publicas e gratuitas, sem chave.
 * Roda no servidor para evitar bloqueio de CORS e para poder cachear.
 */
export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const lat = searchParams.get('lat') || '-23.5505';
  const lon = searchParams.get('lon') || '-46.6333';

  const out = { weather: null, fx: null, errors: [] };

  // ---------- Clima ----------
  try {
    const wxUrl =
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&current=temperature_2m,apparent_temperature,weather_code` +
      `&daily=weather_code,temperature_2m_max,temperature_2m_min` +
      `&timezone=auto&forecast_days=6`;
    const r = await fetch(wxUrl, { next: { revalidate: 900 } });
    if (!r.ok) throw new Error('open-meteo ' + r.status);
    const j = await r.json();
    const cur = j.current || {};
    const d = j.daily || {};
    const days = (d.time || []).slice(0, 6).map((iso, i) => ({
      date: iso,
      code: d.weather_code ? d.weather_code[i] : 0,
      hi: d.temperature_2m_max ? Math.round(d.temperature_2m_max[i]) : null,
      lo: d.temperature_2m_min ? Math.round(d.temperature_2m_min[i]) : null,
    }));
    out.weather = {
      temp: cur.temperature_2m != null ? Math.round(cur.temperature_2m) : null,
      feels: cur.apparent_temperature != null ? Math.round(cur.apparent_temperature) : null,
      code: cur.weather_code != null ? cur.weather_code : 0,
      hi: days[0] ? days[0].hi : null,
      lo: days[0] ? days[0].lo : null,
      days,
      tz: j.timezone || null,
    };
  } catch (e) {
    out.errors.push('weather: ' + String(e.message || e));
  }

  // ---------- Cambio ----------
  try {
    const r = await fetch('https://economia.awesomeapi.com.br/last/USD-BRL,EUR-BRL', { next: { revalidate: 600 } });
    if (!r.ok) throw new Error('awesomeapi ' + r.status);
    const j = await r.json();
    const pick = (k, code) => (j[k] ? { code, value: Number(j[k].bid), pct: Number(j[k].pctChange) } : null);
    out.fx = [pick('USDBRL', 'USD'), pick('EURBRL', 'EUR')].filter(Boolean);
    if (out.fx.length === 0) out.fx = null;
  } catch (e) {
    out.errors.push('fx: ' + String(e.message || e));
  }

  return Response.json(out, {
    headers: { 'Cache-Control': 'public, s-maxage=600, stale-while-revalidate=1800' },
  });
}
