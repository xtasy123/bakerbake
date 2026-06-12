const { requireAuth, createSupabaseToken } = require('./_lib/auth');
const { sendJson, sendError } = require('./_lib/supabase-storage');

module.exports = async function handler(req, res) {
  try {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' });
    const user = requireAuth(req);
    sendJson(res, 200, { user, realtimeToken: createSupabaseToken(user) });
  } catch (error) {
    sendError(res, error);
  }
};
