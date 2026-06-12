const { requireAuth, requireRole } = require('./_lib/auth');
const { readDb, createOrderTransaction, readJson, sendJson, sendError } = require('./_lib/supabase-storage');

module.exports = async function handler(req, res) {
  try {
    requireAuth(req);
    if (req.method === 'GET') {
      const db = await readDb();
      return sendJson(res, 200, { orders: db.orders, orderCounter: db.orderCounter });
    }
    if (req.method === 'POST') {
      const cashier = requireRole(req, 'cashier');
      const order = await readJson(req);
      if (order.status && order.status !== 'pending') {
        return sendJson(res, 400, { error: 'New orders must start as pending.' });
      }
      const result = await createOrderTransaction({ ...order, status: 'pending' }, cashier);
      return sendJson(res, result.duplicate ? 200 : 201, result);
    }
    sendJson(res, 405, { error: 'Method not allowed' });
  } catch (error) {
    sendError(res, error);
  }
};
