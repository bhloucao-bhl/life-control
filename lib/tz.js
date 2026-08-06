const TZ = 'America/Sao_Paulo';

/**
 * Extrai data/hora LOCAL (Brasil) de um instante — epoch ms, string ISO com offset,
 * ou Date — usando Intl.DateTimeFormat com timeZone explícito. Necessário porque o
 * servidor (Vercel) roda em UTC: new Date(ms).toISOString()/.toTimeString()/.getHours()
 * sem timeZone explícito devolve o horário de UTC, não o do Brasil.
 */
export function brDateTime(when) {
  const d = when instanceof Date ? when : new Date(when);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d);
  const get = (t) => (parts.find((p) => p.type === t) || {}).value || '00';
  let hour = get('hour');
  if (hour === '24') hour = '00';
  return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${hour}:${get('minute')}` };
}

export function brDate(when) { return brDateTime(when).date; }
export function brTime(when) { return brDateTime(when).time; }
