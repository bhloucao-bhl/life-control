const ML = 'https://api.mercadolibre.com';

// janela usada para popular o cache (cobre o maior filtro disponível na tela de Compras: 90d)
export const CACHE_DAYS = 90;

function stageOf(order, shipStatus) {
  const paid = (order.payments || []).some((p) => p.status === 'approved');
  if (shipStatus === 'delivered') return 'delivered';
  if (['shipped', 'in_transit', 'ready_to_ship', 'handling'].includes(shipStatus)) return 'shipped';
  if (paid) return 'paid';
  return 'pending';
}
// tenta achar a data estimada de entrega em alguns caminhos comuns do payload de shipment do ML
function findEta(sj) {
  const paths = [
    sj && sj.estimated_delivery_time && sj.estimated_delivery_time.date,
    sj && sj.estimated_delivery_final && sj.estimated_delivery_final.date,
    sj && sj.shipping_option && sj.shipping_option.estimated_delivery_time && sj.shipping_option.estimated_delivery_time.date,
    sj && sj.status_history && sj.status_history.date_delivered,
  ];
  const found = paths.find(Boolean);
  return found ? String(found).slice(0, 10) : null;
}

/** Busca e agrupa as compras do Mercado Livre dos últimos `days` dias (mesma lógica usada pelo GET /api/mercadolivre e pelo cron). */
export async function fetchMlPurchases(token, days) {
  const h = { Authorization: `Bearer ${token}` };

  const rMe = await fetch(`${ML}/users/me`, { headers: h, cache: 'no-store' });
  if (!rMe.ok) throw new Error('users/me HTTP ' + rMe.status);
  const me = await rMe.json();

  const from = new Date(Date.now() - days * 86400000).toISOString();
  const to = new Date().toISOString();
  const qs = `buyer=${me.id}&sort=date_desc&limit=50&order.date_created.from=${encodeURIComponent(from)}&order.date_created.to=${encodeURIComponent(to)}`;
  const rOrders = await fetch(`${ML}/orders/search?${qs}`, { headers: h, cache: 'no-store' });
  if (!rOrders.ok) {
    const txt = await rOrders.text();
    throw new Error('orders/search HTTP ' + rOrders.status + ' — ' + txt.slice(0, 200));
  }
  const oj = await rOrders.json();
  const orders = oj.results || [];

  // O ML às vezes divide UMA compra em vários "orders" — por pack_id (checkout com vários
  // vendedores) ou porque pedidos distintos acabam consolidados no mesmo envio (mesmo
  // shipping id). Agrupamos por qualquer um dos dois (union-find), pra virar 1 pedido só
  // com todos os produtos juntos, em vez de um item por order.
  const parent = orders.map((_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
  const firstIndexByKey = new Map();
  orders.forEach((o, i) => {
    const keys = [];
    if (o.pack_id) keys.push('pack:' + o.pack_id);
    const shId = o.shipping && (o.shipping.id || o.shipping);
    if (shId) keys.push('ship:' + shId);
    keys.forEach((k) => {
      if (firstIndexByKey.has(k)) union(i, firstIndexByKey.get(k));
      else firstIndexByKey.set(k, i);
    });
  });
  const groups = new Map();
  orders.forEach((o, i) => {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(o);
  });
  const STAGE_RANK = { pending: 0, paid: 1, shipped: 2, delivered: 3 };

  const purchases = await Promise.all([...groups.values()].map(async (os) => {
    const key = os.map((o) => String(o.id)).sort().join('-');
    const parts = await Promise.all(os.map(async (o) => {
      let shipStatus = null, tracking = null, eta = null;
      const shId = o.shipping && (o.shipping.id || o.shipping);
      if (shId) {
        try {
          const rs = await fetch(`${ML}/shipments/${shId}`, { headers: h, cache: 'no-store' });
          if (rs.ok) { const sj = await rs.json(); shipStatus = sj.status || null; tracking = sj.tracking_number || null; eta = findEta(sj); }
        } catch (e) {}
      }
      if (!shipStatus && o.shipping && o.shipping.status) shipStatus = o.shipping.status;
      return { stage: stageOf(o, shipStatus), tracking, eta, shipStatus };
    }));

    const itemsList = os.flatMap((o) => (o.order_items || []).map((it) => ({ title: it.item && it.item.title, qty: it.quantity, price: it.unit_price })));
    const title = itemsList.length === 1 ? itemsList[0].title : (itemsList[0] ? `${itemsList[0].title} +${itemsList.length - 1}` : 'Compra Mercado Livre');
    const amount = os.reduce((a, o) => a + (Number(o.total_amount) || 0), 0) || null;
    const dateCreated = os.map((o) => o.date_created).filter(Boolean).sort()[0];
    // o pedido agrupado só é "entregue" quando TODAS as partes chegaram; senão mostra o estágio menos avançado
    const worst = parts.reduce((min, p) => (STAGE_RANK[p.stage] < STAGE_RANK[min.stage] ? p : min), parts[0]);
    const tracking = parts.map((p) => p.tracking).filter(Boolean)[0] || null;
    const eta = parts.map((p) => p.eta).filter(Boolean)[0] || null;
    const primary = os[0];

    return {
      id: 'ml_' + key,
      type: 'purchase',
      domain: 'shopping',
      title: title || 'Compra Mercado Livre',
      amount,
      date: dateCreated ? dateCreated.slice(0, 10) : null,
      status: 'planned',
      meta: {
        external: 'mercadolivre',
        orderId: key,
        subOrderIds: os.map((o) => String(o.id)),
        stage: worst.stage,
        store: 'Mercado Livre',
        deliveredDate: worst.stage === 'delivered' ? (primary.date_closed ? primary.date_closed.slice(0, 10) : (dateCreated || '').slice(0, 10)) : null,
        etaDate: worst.stage !== 'delivered' ? eta : null,
        shipStatus: worst.shipStatus,
        tracking,
        items: itemsList,
        link: `https://www.mercadolivre.com.br/vendas/${primary.id}/detalhe`,
      },
    };
  }));

  return purchases;
}

/** Recarrega as compras do Mercado Livre para um usuário e grava no cache (chamado pelo cron horário). */
export async function refreshMlCache(db, user_id, token) {
  const purchases = await fetchMlPurchases(token, CACHE_DAYS);
  await db.from('ml_purchases_cache').upsert({
    user_id,
    purchases,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'user_id' });
  return purchases;
}
