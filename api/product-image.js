const { requireRole } = require('./_lib/auth');
const { uploadProductImage, readJson, sendJson, sendError } = require('./_lib/supabase-storage');

module.exports = async function handler(req, res) {
  try {
    requireRole(req, 'admin');
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
    const body = await readJson(req);
    const uploaded = await uploadProductImage(body);
    return sendJson(res, 201, uploaded);
  } catch (error) {
    sendError(res, error);
  }
};
