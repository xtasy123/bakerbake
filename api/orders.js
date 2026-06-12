const { requireAuth, requireRole } = require('./_lib/auth');
const { readDb, insertOrder, writeOrderCounter, writeAudit, readJson, sendJson, sendError } = require('./_lib/supabase-storage');

module.exports = async function handler(req, res) {
  try {
    requireAuth(req);
    const db = await readDb();
    if (req.method === 'GET') return sendJson(res, 200, { orders: db.orders, orderCounter: db.orderCounter });
    if (req.method === 'POST') {
      const cashier = requireRole(req, 'cashier');
      const order = await readJson(req);
      if (order.status && order.status !== 'pending') {
        return sendJson(res, 400, { error: 'New orders must start as pending.' });
      }
      const existing = order.requestId
        ? db.orders.find(candidate => candidate.requestId === order.requestId)
        : null;
      if (existing) {
        return sendJson(res, 200, { order: existing, orderCounter: db.orderCounter, duplicate: true });
      }
      const id = Number.isInteger(order.id) ? order.id : db.orderCounter;
      if (db.orders.some(candidate => candidate.id === id)) {
        return sendJson(res, 409, { error: 'Order number conflict. Refresh and try again.' });
      }
      const savedOrder = await insertOrder({ ...order, id, status: 'pending' });
      const nextCounter = Math.max(db.orderCounter, id + 1);
      await writeOrderCounter(nextCounter);
      await writeAudit({
        actor: cashier,
        action: 'order.created',
        entityType: 'order',
        entityId: id,
        details: { total: savedOrder.total, paymentMethod: savedOrder.method }
      });
      return sendJson(res, 201, { order: savedOrder, orderCounter: nextCounter });
    }
    sendJson(res, 405, { error: 'Method not allowed' });
  } catch (error) {
    sendError(res, error);
  }
};
