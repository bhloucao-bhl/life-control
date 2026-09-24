import { brDate } from './tz';

/**
 * Cotacao USD/EUR -> BRL, usada pela Hoje (via /api/live) e pelo widget de iOS
 * (via /api/widget/summary) — mesma fonte e mesma conta, pra os dois mostrarem
 * exatamente o mesmo numero. Todas as APIs sao publicas e gratuitas, sem chave.
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

export async function getFx(errors) {
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

// Cotacao + variacao do dia (a mesma que a Hoje mostra ao lado de cada moeda).
export async function getFxWithChange(errors) {
  const out = { ...(await getFx(errors)) };

  // Se a fonte nao trouxe variacao, compara com o fechamento anterior.
  if (out.fx && out.fx.some((x) => x.pct == null)) {
    try {
      const d = brDate(Date.now() - 4 * 86400000);
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
    } catch (e) { errors.push('fx/pct: ' + String(e.message || e)); }
  }
  return out;
}
