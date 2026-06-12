const { SUPABASE_URL, supabaseFetch, sendJson } = require('./_lib/supabase-storage');
const { getUsers, SESSION_SECRET } = require('./_lib/auth');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' });
  let supabaseOk = false;
  let normalizedSchema = false;
  let supabaseError = null;
  try {
    await supabaseFetch('app_state', { query: '?key=eq.order_counter&select=key&limit=1' });
    supabaseOk = true;
    await supabaseFetch('products', { query: '?select=id&limit=1' });
    await supabaseFetch('order_items', { query: '?select=id&limit=1' });
    await supabaseFetch('void_requests', { query: '?select=id&limit=1' });
    normalizedSchema = true;
  } catch (error) {
    supabaseError = error.message;
  }
  sendJson(res, 200, {
    ok: true,
    name: 'BakerBake POS API',
    storage: 'supabase',
    auth: { configured: Boolean(SESSION_SECRET && getUsers().length) },
    realtime: {
      configured: Boolean(process.env.SUPABASE_ANON_KEY && process.env.SUPABASE_JWT_SECRET)
    },
    supabase: { ok: supabaseOk, normalizedSchema, url: SUPABASE_URL, error: supabaseError }
  });
};
