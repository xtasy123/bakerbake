const { requireAuth, createSupabaseToken } = require('./_lib/auth');
const { SUPABASE_URL, sendJson, sendError } = require('./_lib/supabase-storage');

module.exports = async function handler(req, res) {
  try {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' });
    const user = requireAuth(req);
    const anonKey = process.env.SUPABASE_ANON_KEY || '';
    const token = createSupabaseToken(user);
    if (!SUPABASE_URL || !anonKey || !token) {
      return sendJson(res, 503, { error: 'Supabase Realtime is not configured.' });
    }
    return sendJson(res, 200, { url: SUPABASE_URL, anonKey, token });
  } catch (error) {
    return sendError(res, error);
  }
};
