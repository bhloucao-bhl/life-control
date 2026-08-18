import { brDate, brTime } from './tz';

/** Carrega items (lcc_items_v1) e settings (lcc_settings_v1) de um usuário direto do kv. */
export async function loadUserState(db, userId) {
  const { data: rows } = await db.from('kv').select('key,value').eq('user_id', userId).in('key', ['lcc_items_v1', 'lcc_settings_v1']);
  let items = [], settings = {};
  (rows || []).forEach((r) => {
    try {
      if (r.key === 'lcc_items_v1') items = JSON.parse(r.value) || [];
      else if (r.key === 'lcc_settings_v1') settings = JSON.parse(r.value) || {};
    } catch (e) { /* valor corrompido — ignora e segue com vazio */ }
  });
  return { items, settings };
}

/**
 * Grava de volta em settings.notifPrefs[section].lastSent = today, pra não reconstruir/reenviar
 * a mesma notificação a cada nova rodada do cron no mesmo dia. Lê settings de novo antes de
 * gravar (best-effort — sem lock; app de uso pessoal, risco de corrida é baixo).
 */
export async function markNotifSent(db, userId, settings, section, today) {
  const notifPrefs = { ...(settings.notifPrefs || {}) };
  notifPrefs[section] = { ...(notifPrefs[section] || {}), lastSent: today };
  const next = { ...settings, notifPrefs };
  await db.from('kv').upsert({ user_id: userId, key: 'lcc_settings_v1', value: JSON.stringify(next), updated_at: new Date().toISOString() }, { onConflict: 'user_id,key' });
}

/**
 * Grava de volta os items marcando os informados como já alertados (meta.eventReminded10),
 * pra não repetir o alerta de "vai começar" a cada nova rodada do cron.
 */
export async function markItemsReminded(db, userId, items, ids) {
  const idSet = new Set(ids);
  const next = items.map((i) => (idSet.has(i.id) ? { ...i, meta: { ...(i.meta || {}), eventReminded10: true } } : i));
  await db.from('kv').upsert({ user_id: userId, key: 'lcc_items_v1', value: JSON.stringify(next), updated_at: new Date().toISOString() }, { onConflict: 'user_id,key' });
}

/**
 * Compromissos (event/appointment) que vão começar nos próximos 10 minutos — alerta estilo
 * agenda/Outlook, avisando pra se preparar. Janela de -5 a +10 min (cobre o cron rodando com
 * algum atraso) e nunca repete um item já alertado (meta.eventReminded10).
 */
export function findUpcomingEventAlerts(items, now) {
  return (items || []).filter((i) => {
    if (!['event', 'appointment'].includes(i.type)) return false;
    if (!i.date || !i.time) return false;
    if (i.meta && i.meta.eventReminded10) return false;
    const eventAt = new Date(`${i.date}T${i.time}:00-03:00`);
    if (Number.isNaN(eventAt.getTime())) return false;
    const minutesUntil = (eventAt.getTime() - now.getTime()) / 60000;
    return minutesUntil > -5 && minutesUntil <= 10;
  });
}

const isWeekend = (dateISO) => [0, 6].includes(new Date(dateISO + 'T12:00:00Z').getUTCDay());

/**
 * Decide se é hora de disparar a notificação de uma seção (morning/evening) pra esse usuário,
 * dado o horário escolhido em Ajustes, se fins de semana estão habilitados, e se já foi
 * mandada hoje. O cron roda a cada poucos minutos o dia inteiro — essa função é o que faz cada
 * usuário receber no horário que ele mesmo escolheu, em vez de um horário fixo pra todo mundo.
 */
export function shouldFireNow(sectionPrefs, weekendsOn, now, defaultTime) {
  const p = sectionPrefs || {};
  if (p.on === false) return false;
  const today = brDate(now);
  if (p.lastSent === today) return false;
  if (!weekendsOn && isWeekend(today)) return false;
  if (brTime(now) < (p.time || defaultTime)) return false;
  return true;
}

const joinList = (arr, max) => {
  if (arr.length === 0) return '';
  const shown = arr.slice(0, max).join(', ');
  return arr.length > max ? `${shown} (+${arr.length - max})` : shown;
};

/**
 * Monta o resumo matinal: compromissos de trabalho da manhã, itens pendentes
 * da lista de compras e tarefas importantes/atrasadas/do dia — cada bloco
 * respeitando as preferências de notificação de Ajustes (settings.notifPrefs.morning).
 * Retorna null quando não há nada relevante pra avisar (o gate de on/off/horário é feito
 * separadamente por shouldFireNow, antes de chamar esta função).
 */
export function buildMorningBrief(items, settings, now, morningPrefs) {
  const morning = { on: true, work: true, groceries: true, tasks: true, ...morningPrefs };
  const today = brDate(now);
  const workEvents = morning.work ? items
    .filter((i) => i.domain === 'work' && ['event', 'appointment'].includes(i.type) && i.date === today && (!i.time || i.time < '13:00'))
    .sort((a, b) => (a.time || '').localeCompare(b.time || '')) : [];
  const groceries = morning.groceries ? (settings.groceryList || []).filter((g) => !g.checked) : [];
  const tasks = morning.tasks ? items
    .filter((i) => i.type === 'task' && i.status !== 'done' && (i.priority === 1 || (i.date && i.date <= today)))
    .sort((a, b) => (a.priority === 1 ? -1 : 0) - (b.priority === 1 ? -1 : 0) || (a.date || '').localeCompare(b.date || '')) : [];

  if (!workEvents.length && !groceries.length && !tasks.length) return null;

  const lines = [];
  if (workEvents.length) lines.push(`🗓️ ${workEvents.map((e) => (e.time ? `${e.time} ${e.title}` : e.title)).slice(0, 3).join('; ')}${workEvents.length > 3 ? ` (+${workEvents.length - 3})` : ''}`);
  if (groceries.length) lines.push(`🛒 Comprar: ${joinList(groceries.map((g) => g.text), 4)}`);
  if (tasks.length) lines.push(`⭐ Tarefas: ${joinList(tasks.map((t) => t.title), 4)}`);

  return { title: 'Bom dia! ☀️', body: lines.join('\n') };
}

/**
 * Monta o resumo de fim de dia: o que ficou pendente de hoje e o convite pra
 * já revisar/repriorizar a agenda de amanhã. O gate de on/off/horário é feito
 * separadamente por shouldFireNow, antes de chamar esta função.
 */
export function buildEveningReview(items, now) {
  const today = brDate(now);
  const pending = items.filter((i) => i.type === 'task' && i.status !== 'done' && i.date === today);
  const invite = 'Já dá uma olhada na agenda de amanhã e reprioriza o que precisar 👉';

  if (!pending.length) {
    return { title: 'Fim de dia 🌙', body: `Você deu conta de tudo que tinha pra hoje 🎉\n${invite}` };
  }
  return {
    title: 'Fim de dia 🌙',
    body: `Ainda ficou pendente: ${joinList(pending.map((t) => t.title), 4)}. Foi feito de verdade?\n${invite}`,
  };
}
