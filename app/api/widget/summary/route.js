import { admin, userFromRequest } from '../../../../lib/oauth';
import { brDate } from '../../../../lib/tz';

export const runtime = 'nodejs';

const isDebit = (i) => i.type === 'expense' || i.type === 'bill' || i.type === 'maintenance';
const isCredit = (i) => i.type === 'income';
const isTx = (i) => isDebit(i) || isCredit(i);
// mesma conta de saldo usada no app: base digitada na conta + soma das transações vinculadas a ela
function accountBalance(acc, items) {
  const base = Number(acc.meta && acc.meta.balance) || 0;
  const txs = items.filter(isTx).filter((i) => i.meta && i.meta.accountId === acc.id);
  const delta = txs.reduce((sum, t) => sum + (isCredit(t) ? 1 : -1) * (Number(t.amount) || 0), 0);
  return base + delta;
}

async function loadItems(db, userId) {
  const { data } = await db.from('kv').select('value').eq('user_id', userId).eq('key', 'lcc_items_v1').maybeSingle();
  if (!data || !data.value) return [];
  try { const arr = JSON.parse(data.value); return Array.isArray(arr) ? arr : []; } catch (e) { return []; }
}
async function loadSettings(db, userId) {
  const { data } = await db.from('kv').select('value').eq('user_id', userId).eq('key', 'lcc_settings_v1').maybeSingle();
  if (!data || !data.value) return {};
  try { return JSON.parse(data.value) || {}; } catch (e) { return {}; }
}

/**
 * GET /api/widget/summary
 * Snapshot enxuto pros widgets de iOS (WidgetKit): nao devolve os itens inteiros,
 * so os indicadores que os widgets mostram. Pensado pra ser barato de chamar
 * a cada reload de timeline (o orcamento de refresh do WidgetKit e limitado).
 */
export async function GET(req) {
  const user = await userFromRequest(req);
  if (!user) return Response.json({ error: 'Sem sessão.' }, { status: 401 });

  const db = admin();
  const today = brDate(Date.now());

  const [items, settings, ouraRow] = await Promise.all([
    loadItems(db, user.id),
    loadSettings(db, user.id),
    db.from('oura_cache').select('by_date').eq('user_id', user.id).maybeSingle().then((r) => r.data),
  ]);

  // saude: readiness/sono do dia; se ainda nao houver leitura de hoje, cai pro dia mais recente disponivel
  let health = { connected: false, readiness: null, sleep: null, date: null };
  const byDate = (ouraRow && ouraRow.by_date) || null;
  if (byDate) {
    const dates = Object.keys(byDate).sort();
    const day = byDate[today] ? today : dates[dates.length - 1];
    if (day) health = { connected: true, readiness: byDate[day].readiness ?? null, sleep: byDate[day].sleep ?? null, date: day };
  }

  // tarefas: pendentes com vencimento ate hoje (atrasadas + as de hoje), ordenadas por prioridade
  const pendingTasks = items
    .filter((i) => i.type === 'task' && i.status !== 'done' && (!i.date || i.date <= today))
    .sort((a, b) => (a.priority || 3) - (b.priority || 3) || (a.date || '').localeCompare(b.date || ''));
  const tasks = { count: pendingTasks.length, next: pendingTasks[0] ? { id: pendingTasks[0].id, title: pendingTasks[0].title, date: pendingTasks[0].date || null } : null };

  // proximo compromisso a partir de agora
  const nowHM = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' })).toTimeString().slice(0, 5);
  const upcoming = items
    .filter((i) => (i.type === 'event' || i.type === 'appointment') && i.date && (i.date > today || (i.date === today && (!i.time || i.time >= nowHM))))
    .sort((a, b) => a.date.localeCompare(b.date) || (a.time || '99:99').localeCompare(b.time || '99:99'));
  const event = upcoming[0] ? { id: upcoming[0].id, title: upcoming[0].title, date: upcoming[0].date, time: upcoming[0].time || null } : null;

  // dieta: refeicoes de hoje
  const mealsToday = items.filter((i) => i.type === 'meal' && i.date === today);
  const caloriesToday = mealsToday.reduce((sum, m) => sum + (Number(m.meta && m.meta.calories) || 0), 0);
  const calorieGoal = Number(settings && settings.health && settings.health.calorieGoal) || 2000;
  const diet = { caloriesToday, goal: calorieGoal, mealsToday: mealsToday.length };

  // financas: contas com saldo calculado
  const accounts = items
    .filter((i) => i.type === 'account')
    .map((a) => ({ id: a.id, title: a.title, institution: (a.meta && a.meta.institution) || null, balance: accountBalance(a, items) }));

  // compras a caminho (pagas ou enviadas, ainda nao entregues), mais proximas de chegar primeiro
  const purchases = items
    .filter((i) => i.type === 'purchase' && i.meta && (i.meta.stage === 'paid' || i.meta.stage === 'shipped'))
    .sort((a, b) => (a.meta.etaDate || '9999') .localeCompare(b.meta.etaDate || '9999'))
    .slice(0, 10)
    .map((p) => ({ id: p.id, title: p.title, store: (p.meta && p.meta.store) || null, etaDate: (p.meta && p.meta.etaDate) || null, stage: p.meta.stage, tracking: (p.meta && p.meta.tracking) || null }));

  return Response.json({ today, health, tasks, event, diet, finance: { accounts }, purchases }, {
    headers: { 'Cache-Control': 'private, no-store' },
  });
}
