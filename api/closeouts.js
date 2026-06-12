const { requireRole } = require('./_lib/auth');
const { readDb, insertCloseout, writeAudit, readJson, sendJson, sendError } = require('./_lib/supabase-storage');

module.exports = async function handler(req, res) {
  try {
    const admin = requireRole(req, 'admin');
    const db = await readDb();
    if (req.method === 'GET') return sendJson(res, 200, { closeouts: db.closeouts || [] });
    if (req.method === 'POST') {
      const closeout = await readJson(req);
      const saved = {
        id: closeout.id || Date.now(),
        createdAt: closeout.createdAt || new Date().toISOString(),
        ...closeout
      };
      const persisted = await insertCloseout(saved);
      await writeAudit({
        actor: admin,
        action: 'closeout.created',
        entityType: 'closeout',
        entityId: persisted.id
      });
      return sendJson(res, 201, { closeout: persisted });
    }
    sendJson(res, 405, { error: 'Method not allowed' });
  } catch (error) {
    sendError(res, error);
  }
};
