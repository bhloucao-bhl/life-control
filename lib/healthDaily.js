/**
 * Histórico permanente de saúde (tabela health_daily) — ver schema8.sql.
 * Diferente dos caches (oura_cache, healthkit_steps_cache), que são
 * substituídos por inteiro a cada atualização e por isso só enxergam a
 * janela curta que a última chamada trouxe, aqui cada dia é fundido
 * (merge raso) com o que já existia: uma fonte que só cobre os últimos 13-14
 * dias nunca apaga dias mais antigos já gravados por uma chamada anterior.
 */

/**
 * Funde novos valores diários no histórico permanente.
 * @param {*} db cliente admin() do Supabase
 * @param {string} userId
 * @param {Record<string, object>} byDate ex.: { '2026-08-19': { readiness: 78, steps: 4200 } }
 */
export async function mergeHealthDaily(db, userId, byDate) {
  const dates = Object.keys(byDate || {}).filter((d) => byDate[d] && Object.keys(byDate[d]).length);
  if (!dates.length) return;

  const { data: existing } = await db.from('health_daily').select('date, metrics').eq('user_id', userId).in('date', dates);
  const existingByDate = {};
  (existing || []).forEach((r) => { existingByDate[r.date] = r.metrics || {}; });

  const now = new Date().toISOString();
  const rows = dates.map((d) => ({
    user_id: userId,
    date: d,
    metrics: { ...(existingByDate[d] || {}), ...byDate[d] },
    updated_at: now,
  }));

  await db.from('health_daily').upsert(rows, { onConflict: 'user_id,date' });
}
