const { authenticate } = require('./_lib/auth');
const { writeAudit, readJson, sendJson, sendError } = require('./_lib/supabase-storage');

module.exports = async function handler(req, res) {
  try {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
    const body = await readJson(req);
    const result = await authenticate(body.username, String(body.password || ''));
    await writeAudit({
      actor: result.user,
      action: 'session.login',
      entityType: 'user',
      entityId: result.user.username
    });
    sendJson(res, 200, result);
  } catch (error) {
    sendError(res, error);
  }
};
