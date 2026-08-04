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

export async function GET(req) {
  const user = await userFromRequest(req);
  if (!user) return Response.json({ error: 'Sem sessão.' }, { status: 401 });

  const token = await validToken(user.id, 'mercadolivre');
  if (!token) return Response.json({ connected: false, purchases: [] });

  const h = { Authorization: `Bearer ${token}` };

  try {
    const rMe = await fetch(`${ML}/users/me`, { headers: h, cache: 'no-store' });
    if (!rMe.ok) throw new Error('users/me HTTP ' + rMe.status);
    const me = await rMe.json();

    const rOrders = await fetch(`${ML}/orders/search?buyer=${me.id}&sort=date_desc&limit=50`, { headers: h, cache: 'no-store' });
    if (!rOrders.ok) {
      const txt = await rOrders.text();
      throw new Error('orders/search HTTP ' + rOrders.status + ' — ' + txt.slice(0, 200));
    }
    const oj = await rOrders.json();
    const orders = oj.results || [];

    const purchases = await Promise.all(orders.map(async (o) => {
      let shipStatus = null, tracking = null;
      const shId = o.shipping && (o.shipping.id || o.shipping);
      if (shId) {
        try {
          const rs = await fetch(`${ML}/shipments/${shId}`, { headers: h, cache: 'no-store' });
          if (rs.ok) { const sj = await rs.json(); shipStatus = sj.status || null; tracking = sj.tracking_number || null; }
        } catch (e) {}
      }
      if (!shipStatus && o.shipping && o.shipping.status) shipStatus = o.shipping.status;

      const itemsList = (o.order_items || []).map((it) => ({ title: it.item && it.item.title, qty: it.quantity, price: it.unit_price }));
      const title = itemsList.length === 1 ? itemsList[0].title : (itemsList[0] ? `${itemsList[0].title} +${itemsList.length - 1}` : 'Compra Mercado Livre');

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
          deliveredDate: stage === 'delivered' ? (o.date_closed ? o.date_closed.slice(0, 10) : o.date_created.slice(0, 10)) : null,
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
