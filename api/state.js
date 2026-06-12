const { requireAuth } = require('./_lib/auth');
const { readDb, sendJson, sendError } = require('./_lib/supabase-storage');

module.exports = async function handler(req, res) {
  try {
    requireAuth(req);
    if (req.method === 'GET') {
      const db = await readDb();
      return sendJson(res, 200, {
        orders: db.orders,
        orderCounter: db.orderCounter,
        products: db.products,
        updatedAt: db.updatedAt,
        storage: db.storage
      });
    }
    if (req.method === 'PUT') {
      return sendJson(res, 405, { error: 'Use the resource-specific order and product endpoints.' });
    }
    sendJson(res, 405, { error: 'Method not allowed' });
  } catch (error) {
    sendError(res, error);
  }
};
