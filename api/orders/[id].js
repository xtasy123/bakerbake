const { requireRole } = require('../_lib/auth');
const { readDb, writeDb, readJson, sendJson, sendError } = require('../_lib/supabase-storage');

module.exports = async function handler(req, res) {
  try {
    requireRole(req, 'cashier');
    if (req.method !== 'PATCH') return sendJson(res, 405, { error: 'Method not allowed' });
    const id = Number(req.query.id);
    const patch = await readJson(req);
    const db = await readDb();
    const index = db.orders.findIndex(order => order.id === id);
    if (index === -1) return sendJson(res, 404, { error: 'Order not found' });
    const current = db.orders[index];
    const protectedFields = ['voidRequest', 'voidReason', 'voidedAt', 'voidedBy', 'authorizedBy', 'previousStatus'];
    if (protectedFields.some(field => Object.hasOwn(patch, field))
      || patch.status === 'voided'
      || current.status === 'voided'
      || (current.voidRequest?.status === 'pending' && patch.status && patch.status !== current.status)
      || (current.status === 'done' && patch.status === 'pending' && patch.previouslyCompleted !== true)) {
      return sendJson(res, 403, { error: 'Protected order history cannot be changed through this endpoint.' });
    }
    db.orders[index] = { ...db.orders[index], ...patch, id };
    await writeDb(db);
    sendJson(res, 200, { order: db.orders[index] });
  } catch (error) {
    sendError(res, error);
  }
};
