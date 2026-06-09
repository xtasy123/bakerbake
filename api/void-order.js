const { requireRole } = require('./_lib/auth');
const { readDb, writeDb, readJson, sendJson, sendError } = require('./_lib/supabase-storage');

module.exports = async function handler(req, res) {
  try {
    if (req.method === 'POST') {
      const cashier = requireRole(req, 'cashier');
      const body = await readJson(req);
      const reason = String(body.reason || '').trim();
      if (!reason) return sendJson(res, 400, { error: 'A void reason is required.' });

      const db = await readDb();
      const order = (db.orders || []).find(item => String(item.id) === String(body.orderId));
      if (!order) return sendJson(res, 404, { error: 'Order not found.' });
      if (order.status === 'voided') return sendJson(res, 409, { error: 'Order is already voided.' });
      if (order.voidRequest?.status === 'pending') {
        return sendJson(res, 409, { error: 'A void request is already pending.' });
      }
      if (order.status !== 'done' && order.previouslyCompleted !== true) {
        return sendJson(res, 400, { error: 'Only completed orders require a void request.' });
      }

      order.voidRequest = {
        status: 'pending',
        reason,
        requestedAt: new Date().toISOString(),
        requestedBy: cashier.name || cashier.sub
      };
      await writeDb(db);
      return sendJson(res, 201, { order });
    }

    if (req.method === 'PATCH') {
      const admin = requireRole(req, 'admin');
      const body = await readJson(req);
      const decision = String(body.decision || '').toLowerCase();
      if (!['approve', 'reject'].includes(decision)) {
        return sendJson(res, 400, { error: 'Decision must be approve or reject.' });
      }

      const db = await readDb();
      const order = (db.orders || []).find(item => String(item.id) === String(body.orderId));
      if (!order) return sendJson(res, 404, { error: 'Order not found.' });
      if (order.voidRequest?.status !== 'pending') {
        return sendJson(res, 409, { error: 'This void request is no longer pending.' });
      }

      const reviewedAt = new Date().toISOString();
      if (decision === 'approve') {
        order.previousStatus = order.status;
        order.status = 'voided';
        order.voidReason = order.voidRequest.reason;
        order.voidedAt = reviewedAt;
        order.voidedBy = order.voidRequest.requestedBy;
        order.authorizedBy = admin.name || admin.sub;
      }
      order.voidRequest = {
        ...order.voidRequest,
        status: decision === 'approve' ? 'approved' : 'rejected',
        reviewedAt,
        reviewedBy: admin.name || admin.sub
      };
      await writeDb(db);
      return sendJson(res, 200, { order });
    }

    return sendJson(res, 405, { error: 'Method not allowed' });
  } catch (error) {
    return sendError(res, error);
  }
};
