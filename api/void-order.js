const { requireRole } = require('./_lib/auth');
const {
  readDb,
  upsertOrder,
  createVoidRequest,
  reviewVoidRequest,
  writeAudit,
  readJson,
  sendJson,
  sendError
} = require('./_lib/supabase-storage');

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
      if (order.status === 'pending' && order.previouslyCompleted !== true) {
        const voidedAt = new Date().toISOString();
        const savedOrder = await upsertOrder({
          ...order,
          previousStatus: order.status,
          status: 'voided',
          voidReason: reason,
          voidedAt,
          voidedBy: cashier.name || cashier.sub
        });
        await writeAudit({
          actor: cashier,
          action: 'order.voided',
          entityType: 'order',
          entityId: order.id,
          details: { reason }
        });
        return sendJson(res, 200, { order: savedOrder });
      }
      if (order.status !== 'done' && order.previouslyCompleted !== true) {
        return sendJson(res, 400, { error: 'This order cannot be voided.' });
      }

      await createVoidRequest(order, reason, cashier.name || cashier.sub);
      await writeAudit({
        actor: cashier,
        action: 'void_request.created',
        entityType: 'order',
        entityId: order.id,
        details: { reason }
      });
      const refreshed = await readDb();
      return sendJson(res, 201, {
        order: refreshed.orders.find(item => String(item.id) === String(order.id))
      });
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
      await reviewVoidRequest(order.id, decision, admin.name || admin.sub);
      const savedOrder = decision === 'approve' ? await upsertOrder(order) : order;
      await writeAudit({
        actor: admin,
        action: `void_request.${decision === 'approve' ? 'approved' : 'rejected'}`,
        entityType: 'order',
        entityId: order.id,
        details: { reason: order.voidRequest.reason }
      });
      const refreshed = await readDb();
      return sendJson(res, 200, {
        order: refreshed.orders.find(item => String(item.id) === String(savedOrder.id))
      });
    }

    return sendJson(res, 405, { error: 'Method not allowed' });
  } catch (error) {
    return sendError(res, error);
  }
};
