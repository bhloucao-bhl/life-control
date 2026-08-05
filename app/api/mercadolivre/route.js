import { userFromRequest, validToken } from '../../../lib/oauth';

export const runtime = 'nodejs';
export const maxDuration = 30;

const ML = 'https://api.mercadolibre.com';

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

export async function GET(req) {
  const user = await userFromRequest(req);
  if (!user) return Response.json({ error: 'Sem sessão.' }, { status: 401 });

  const token = await validToken(user.id, 'mercadolivre');
  if (!token) return Response.json({ connected: false, purchases: [] });

  const h = { Authorization: `Bearer ${token}` };
  const days = Number(new URL(req.url).searchParams.get('days')) || 30;

  try {
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

    const purchases = await Promise.all(orders.map(async (o) => {
      let shipStatus = null, tracking = null, eta = null;
      const shId = o.shipping && (o.shipping.id || o.shipping);
      if (shId) {
        try {
          const rs = await fetch(`${ML}/shipments/${shId}`, { headers: h, cache: 'no-store' });
          if (rs.ok) { const sj = await rs.json(); shipStatus = sj.status || null; tracking = sj.tracking_number || null; eta = findEta(sj); }
        } catch (e) {}
      }
      if (!shipStatus && o.shipping && o.shipping.status) shipStatus = o.shipping.status;

      const itemsList = (o.order_items || []).map((it) => ({ title: it.item && it.item.title, qty: it.quantity, price: it.unit_price }));
      const title = itemsList.length === 1 ? itemsList[0].title : (itemsList[0] ? `${itemsList[0].title} +${itemsList.length - 1}` : 'Compra Mercado Livre');
      // Bruno não usa o nome do vendedor individual do ML pra filtrar — deixa fixo como "Mercado Livre"
      const store = 'Mercado Livre';

      const stage = stageOf(o, shipStatus);
      return {
        id: 'ml_' + o.id,
        type: 'purchase',
        domain: 'shopping',
        title: title || 'Compra Mercado Livre',
        amount: Number(o.total_amount) || null,
        date: o.date_created ? o.date_created.slice(0, 10) : null,
        status: 'planned',
        meta: {
          external: 'mercadolivre',
          orderId: o.id,
          stage,
          store,
          deliveredDate: stage === 'delivered' ? (o.date_closed ? o.date_closed.slice(0, 10) : o.date_created.slice(0, 10)) : null,
          etaDate: stage !== 'delivered' ? eta : null,
          shipStatus,
          tracking,
          items: itemsList,
          link: `https://www.mercadolivre.com.br/vendas/${o.id}/detalhe`,
        },
      };
    }));

    return Response.json({ connected: true, purchases });
  } catch (e) {
    return Response.json({ connected: true, purchases: [], error: String(e.message || e) });
  }
}
