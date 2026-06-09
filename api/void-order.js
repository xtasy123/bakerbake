const { authenticate, requireRole } = require('./_lib/auth');
const { readDb, writeDb, readJson, sendJson, sendError } = require('./_lib/supabase-storage');

module.exports = async function handler(req, res) {
  try {
    const cashier = requireRole(req, 'cashier');
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });

    const body = await readJson(req);
    const reason = String(body.reason || '').trim();
    if (!reason) return sendJson(res, 400, { error: 'A void reason is required.' });

    const authorization = authenticate(body.adminUsername, body.adminPassword);
    if (authorization.user.role !== 'admin') {
      return sendJson(res, 403, { error: 'An admin account is required.' });
    }

    const db = await readDb();
    const order = (db.orders || []).find(item => String(item.id) === String(body.orderId));
    if (!order) return sendJson(res, 404, { error: 'Order not found.' });
    if (order.status === 'voided') return sendJson(res, 409, { error: 'Order is already voided.' });
    if (order.status !== 'done' && order.previouslyCompleted !== true) {
      return sendJson(res, 400, { error: 'This order does not require completed-order authorization.' });
    }

    order.previousStatus = order.status;
    order.status = 'voided';
    order.voidReason = reason;
    order.voidedAt = new Date().toISOString();
    order.voidedBy = cashier.name || cashier.sub;
    order.authorizedBy = authorization.user.name || authorization.user.username;
    await writeDb(db);
    return sendJson(res, 200, { order });
  } catch (error) {
    return sendError(res, error);
  }
};
