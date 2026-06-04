const { requireAuth } = require('./_lib/auth');
const { readDb, writeDb, readJson, sendJson, sendError } = require('./_lib/supabase-storage');

module.exports = async function handler(req, res) {
  try {
    requireAuth(req);
    if (req.method === 'GET') return sendJson(res, 200, await readDb());
    if (req.method === 'PUT') {
      const body = await readJson(req);
      return sendJson(res, 200, await writeDb({
        cart: body.cart && typeof body.cart === 'object' ? body.cart : {},
        orders: Array.isArray(body.orders) ? body.orders : [],
        orderCounter: Number.isInteger(body.orderCounter) ? body.orderCounter : 1001,
        closeouts: Array.isArray(body.closeouts) ? body.closeouts : []
      }));
    }
    sendJson(res, 405, { error: 'Method not allowed' });
  } catch (error) {
    sendError(res, error);
  }
};
