import { brDate } from './tz';

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

const joinList = (arr, max) => {
  if (arr.length === 0) return '';
  const shown = arr.slice(0, max).join(', ');
  return arr.length > max ? `${shown} (+${arr.length - max})` : shown;
};

/**
 * Monta o resumo matinal: compromissos de trabalho da manhã, itens pendentes
 * da lista de compras e tarefas importantes/atrasadas/do dia.
 * Retorna null quando não há nada relevante pra avisar.
 */
export function buildMorningBrief(items, settings, now) {
  const today = brDate(now);
  const workEvents = items
    .filter((i) => i.domain === 'work' && ['event', 'appointment'].includes(i.type) && i.date === today && (!i.time || i.time < '13:00'))
    .sort((a, b) => (a.time || '').localeCompare(b.time || ''));
  const groceries = (settings.groceryList || []).filter((g) => !g.checked);
  const tasks = items
    .filter((i) => i.type === 'task' && i.status !== 'done' && (i.priority === 1 || (i.date && i.date <= today)))
    .sort((a, b) => (a.priority === 1 ? -1 : 0) - (b.priority === 1 ? -1 : 0) || (a.date || '').localeCompare(b.date || ''));

  if (!workEvents.length && !groceries.length && !tasks.length) return null;

  const lines = [];
  if (workEvents.length) lines.push(`🗓️ ${workEvents.map((e) => (e.time ? `${e.time} ${e.title}` : e.title)).slice(0, 3).join('; ')}${workEvents.length > 3 ? ` (+${workEvents.length - 3})` : ''}`);
  if (groceries.length) lines.push(`🛒 Comprar: ${joinList(groceries.map((g) => g.text), 4)}`);
  if (tasks.length) lines.push(`⭐ Tarefas: ${joinList(tasks.map((t) => t.title), 4)}`);

  return { title: 'Bom dia! ☀️', body: lines.join('\n') };
}

/**
 * Monta o resumo de fim de dia: o que ficou pendente de hoje e o convite pra
 * já revisar/repriorizar a agenda de amanhã.
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
