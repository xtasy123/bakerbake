const { requireAuth, requireRole } = require('./_lib/auth');
const { readDb, writeProducts, writeAudit, readJson, sendJson, sendError } = require('./_lib/supabase-storage');

module.exports = async function handler(req, res) {
  try {
    requireAuth(req);
    const db = await readDb();
    if (req.method === 'GET') {
      return sendJson(res, 200, { products: db.products || [] });
    }
    if (req.method === 'PUT') {
      const admin = requireRole(req, 'admin');
      const body = await readJson(req);
      if (!Array.isArray(body.products)) {
        return sendJson(res, 400, { error: 'Products must be an array.' });
      }
      const products = await writeProducts(body.products);
      await writeAudit({
        actor: admin,
        action: 'products.updated',
        entityType: 'product_catalog',
        details: { productCount: products.length }
      });
      return sendJson(res, 200, { products });
    }
    sendJson(res, 405, { error: 'Method not allowed' });
  } catch (error) {
    sendError(res, error);
  }
};
