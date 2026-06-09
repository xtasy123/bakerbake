const { requireAuth, requireRole } = require('./_lib/auth');
const { readDb, writeDb, readJson, sendJson, sendError } = require('./_lib/supabase-storage');

module.exports = async function handler(req, res) {
  try {
    const user = requireAuth(req);
    if (req.method === 'GET') {
      const db = await readDb();
      return sendJson(res, 200, user.role === 'admin'
        ? { ...db, cart: {} }
        : { cart: db.cart, orders: db.orders, orderCounter: db.orderCounter, products: db.products, updatedAt: db.updatedAt, storage: db.storage });
    }
    if (req.method === 'PUT') {
      requireRole(req, 'cashier');
      const body = await readJson(req);
      const currentDb = await readDb();
      return sendJson(res, 200, await writeDb({
        ...currentDb,
        cart: body.cart && typeof body.cart === 'object' ? body.cart : {},
        orders: Array.isArray(body.orders) ? body.orders : [],
        orderCounter: Number.isInteger(body.orderCounter) ? body.orderCounter : currentDb.orderCounter
      }));
    }
    sendJson(res, 405, { error: 'Method not allowed' });
  } catch (error) {
    sendError(res, error);
  }
};
