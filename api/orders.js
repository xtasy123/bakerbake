const { requireAuth, requireRole } = require('./_lib/auth');
const { readDb, writeDb, readJson, sendJson, sendError } = require('./_lib/supabase-storage');

module.exports = async function handler(req, res) {
  try {
    requireAuth(req);
    const db = await readDb();
    if (req.method === 'GET') return sendJson(res, 200, { orders: db.orders, orderCounter: db.orderCounter });
    if (req.method === 'POST') {
      requireRole(req, 'cashier');
      const order = await readJson(req);
      if (order.status && order.status !== 'pending') {
        return sendJson(res, 400, { error: 'New orders must start as pending.' });
      }
      const id = Number.isInteger(order.id) ? order.id : db.orderCounter;
      const savedOrder = { ...order, id, status: 'pending' };
      db.orders = [savedOrder, ...db.orders.filter(existing => existing.id !== id)];
      db.orderCounter = Math.max(db.orderCounter, id + 1);
      await writeDb(db);
      return sendJson(res, 201, { order: savedOrder, orderCounter: db.orderCounter });
    }
    sendJson(res, 405, { error: 'Method not allowed' });
  } catch (error) {
    sendError(res, error);
  }
};
