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
      const currentOrders = new Map((currentDb.orders || []).map(order => [String(order.id), order]));
      const nextOrders = Array.isArray(body.orders) ? body.orders : [];
      const nextOrderIds = new Set(nextOrders.map(order => String(order.id)));
      const hasDeletedOrders = [...currentOrders.keys()].some(id => !nextOrderIds.has(id));
      const hasProtectedMutation = nextOrders.some(order => {
        const current = currentOrders.get(String(order.id));
        if (!current) return order.status !== 'pending' || Boolean(order.voidRequest);
        const unauthorizedVoid = order.status === 'voided'
          && current.status !== 'voided'
          && (current.status === 'done' || current.previouslyCompleted === true);
        const clearedCompletionAudit = (current.status === 'done' && order.status === 'pending' && order.previouslyCompleted !== true)
          || (current.previouslyCompleted === true && order.previouslyCompleted !== true);
        const restoredVoidedOrder = current.status === 'voided' && order.status !== 'voided';
        const changedVoidRequest = JSON.stringify(current.voidRequest || null) !== JSON.stringify(order.voidRequest || null);
        return unauthorizedVoid || clearedCompletionAudit || restoredVoidedOrder || changedVoidRequest;
      });
      if (hasDeletedOrders || hasProtectedMutation) {
        const error = new Error('Protected order history cannot be changed without authorization.');
        error.statusCode = 403;
        throw error;
      }
      return sendJson(res, 200, await writeDb({
        ...currentDb,
        cart: body.cart && typeof body.cart === 'object' ? body.cart : {},
        orders: nextOrders,
        orderCounter: Number.isInteger(body.orderCounter) ? body.orderCounter : currentDb.orderCounter
      }));
    }
    sendJson(res, 405, { error: 'Method not allowed' });
  } catch (error) {
    sendError(res, error);
  }
};
