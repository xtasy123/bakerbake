const { authenticate } = require('./_lib/auth');
const { readJson, sendJson, sendError } = require('./_lib/supabase-storage');

module.exports = async function handler(req, res) {
  try {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
    const body = await readJson(req);
    sendJson(res, 200, authenticate(body.username, String(body.password || '')));
  } catch (error) {
    sendError(res, error);
  }
};
