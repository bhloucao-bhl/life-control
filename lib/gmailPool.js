// Roda `fn` sobre `items` com um número limitado de chamadas em paralelo.
// As rotas de varredura de e-mail (inbox-scan, house-scan, work-scan, etc.) buscavam
// dezenas/centenas de mensagens de uma vez com Promise.all "sem limite" — cada
// messages.get custa unidades de quota da Gmail API, e disparar tudo de uma vez
// estoura o limite "Units per minute per user" (erro 403 "Quota exceeded"), que o
// usuário via como mensagem de erro na aba Viagens. Espaçando em lotes pequenos,
// o total de chamadas continua o mesmo, só a rajada instantânea fica menor.
export async function pMap(items, fn, concurrency = 8) {
  const list = items || [];
  const results = new Array(list.length);
  let next = 0;
  async function worker() {
    while (next < list.length) {
      const idx = next++;
      results[idx] = await fn(list[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker));
  return results;
}
