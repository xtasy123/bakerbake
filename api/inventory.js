const { requireAuth, requireRole } = require('./_lib/auth');
const {
  getInventoryTemplate,
  getInventoryLogByDate,
  saveInventoryDraft,
  submitInventoryLog,
  listInventoryLogs,
  listInventorySyncJobs,
  readJson,
  sendJson,
  sendError
} = require('./_lib/supabase-storage');

function todayKey() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());
}

module.exports = async function handler(req, res) {
  try {
    const user = requireAuth(req);
    const action = String(req.query.action || 'template');

    if (req.method === 'GET' && action === 'template') {
      return sendJson(res, 200, await getInventoryTemplate());
    }

    if (req.method === 'GET' && action === 'log') {
      const logDate = String(req.query.date || todayKey());
      return sendJson(res, 200, { log: await getInventoryLogByDate(logDate) });
    }

    if (req.method === 'GET' && action === 'history') {
      requireRole(req, 'admin');
      return sendJson(res, 200, { logs: await listInventoryLogs({ limit: 45 }) });
    }

    if (req.method === 'GET' && action === 'sync-jobs') {
      requireRole(req, 'admin');
      return sendJson(res, 200, { jobs: await listInventorySyncJobs({ limit: 25 }) });
    }

    if (req.method === 'POST' && action === 'draft') {
      const body = await readJson(req);
      const logDate = String(body.logDate || todayKey());
      const log = await saveInventoryDraft({ logDate, lines: body.lines || [], user });
      return sendJson(res, 200, { log });
    }

    if (req.method === 'POST' && action === 'submit') {
      const body = await readJson(req);
      const logDate = String(body.logDate || todayKey());
      const log = await submitInventoryLog({ logDate, lines: body.lines || [], user });
      return sendJson(res, 201, { log });
    }

    return sendJson(res, 405, { error: 'Method not allowed' });
  } catch (error) {
    return sendError(res, error);
  }
};
