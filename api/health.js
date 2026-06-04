const { SUPABASE_URL, supabaseFetch, sendJson } = require('./_lib/supabase-storage');
const { getUsers, SESSION_SECRET } = require('./_lib/auth');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' });
  let supabaseOk = false;
  let supabaseError = null;
  try {
    await supabaseFetch('app_state', { query: '?key=eq.order_counter&select=key&limit=1' });
    supabaseOk = true;
  } catch (error) {
    supabaseError = error.message;
  }
  sendJson(res, 200, {
    ok: true,
    name: 'BakerBake POS API',
    storage: 'supabase',
    auth: { configured: Boolean(SESSION_SECRET && getUsers().length) },
    supabase: { ok: supabaseOk, url: SUPABASE_URL, error: supabaseError }
  });
};
