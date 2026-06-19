const crypto = require('crypto');
const { requireAuth, requireRole } = require('./_lib/auth');
const {
  getInventoryLogById,
  getInventoryTemplate,
  getInventoryLogByDate,
  saveInventoryDraft,
  submitInventoryLog,
  listInventoryLogs,
  listInventorySyncJobs,
  listPendingInventorySyncJobs,
  readJson,
  sendJson,
  sendError,
  updateInventorySyncJob
} = require('./_lib/supabase-storage');

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

function base64Url(value) {
  return Buffer.from(value).toString('base64url');
}

function todayKey() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());
}

function googleConfig() {
  return {
    spreadsheetId: process.env.GOOGLE_SHEETS_SPREADSHEET_ID || '',
    clientEmail: process.env.GOOGLE_SHEETS_CLIENT_EMAIL || '',
    privateKey: String(process.env.GOOGLE_SHEETS_PRIVATE_KEY || '').replace(/\\n/g, '\n')
  };
}

function ensureGoogleConfig() {
  const config = googleConfig();
  return Boolean(config.spreadsheetId && config.clientEmail && config.privateKey);
}

function assertCanRunSync(req) {
  const configuredSecret = process.env.INVENTORY_SYNC_SECRET || '';
  const providedSecret = req.headers['x-sync-secret'] || req.headers['X-Sync-Secret'];
  if (configuredSecret && providedSecret === configuredSecret) return;
  const user = requireAuth(req);
  if (user.role !== 'admin') {
    const error = new Error('Forbidden');
    error.statusCode = 403;
    throw error;
  }
}

async function getGoogleAccessToken() {
  const config = googleConfig();
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64Url(JSON.stringify({
    iss: config.clientEmail,
    scope: GOOGLE_SHEETS_SCOPE,
    aud: GOOGLE_TOKEN_URL,
    iat: now,
    exp: now + 3600
  }));
  const signature = crypto
    .createSign('RSA-SHA256')
    .update(`${header}.${payload}`)
    .sign(config.privateKey, 'base64url');
  const assertion = `${header}.${payload}.${signature}`;
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion
    })
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error_description || data.error || 'Google token request failed.');
  }
  return data.access_token;
}

async function googleSheetsRequest(path, options = {}) {
  const accessToken = await getGoogleAccessToken();
  const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${path}`, {
    method: options.method || 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(data?.error?.message || `Google Sheets request failed: ${response.status}`);
  }
  return data;
}

async function ensureSheet(spreadsheetId, title) {
  const metadata = await googleSheetsRequest(`${encodeURIComponent(spreadsheetId)}?fields=sheets.properties.title`);
  const exists = metadata.sheets?.some(sheet => sheet.properties?.title === title);
  if (exists) return;
  await googleSheetsRequest(`${encodeURIComponent(spreadsheetId)}:batchUpdate`, {
    method: 'POST',
    body: {
      requests: [{ addSheet: { properties: { title } } }]
    }
  });
}

function sheetTitleFor(log) {
  return `Inventory ${log.logDate}`;
}

function buildSheetRows(log) {
  const rows = [
    ['BAKERBAKE INVENTORY SHEET'],
    ['Date', log.logDate],
    ['Status', log.status],
    ['Submitted By', log.submittedBy || ''],
    []
  ];
  let currentCategory = '';
  for (const line of log.lines || []) {
    if (line.categoryName !== currentCategory) {
      currentCategory = line.categoryName;
      rows.push([currentCategory]);
      rows.push(['Item', 'Unit', 'In', 'Out', 'Remaining']);
    }
    rows.push([
      line.itemName,
      line.unitCode,
      Number(line.inQty || 0),
      Number(line.outQty || 0),
      Number(line.remainingQty || 0)
    ]);
  }
  return rows;
}

async function syncLogToGoogleSheet(log) {
  const config = googleConfig();
  const title = sheetTitleFor(log);
  await ensureSheet(config.spreadsheetId, title);
  const range = encodeURIComponent(`'${title}'!A1`);
  await googleSheetsRequest(`${encodeURIComponent(config.spreadsheetId)}/values/${range}?valueInputOption=USER_ENTERED`, {
    method: 'PUT',
    body: { values: buildSheetRows(log) }
  });
}

async function processInventorySheetSync(req, res) {
  assertCanRunSync(req);
  const pendingJobs = await listPendingInventorySyncJobs({ limit: Number(req.query?.limit || 5) });
  if (!ensureGoogleConfig()) {
    return sendJson(res, 200, {
      ok: true,
      configured: false,
      pending: pendingJobs.length,
      message: 'Google Sheets sync is not configured.'
    });
  }
  const results = [];
  for (const job of pendingJobs) {
    try {
      await updateInventorySyncJob(job.id, {
        status: 'processing',
        attempts: Number(job.attempts || 0) + 1,
        last_error: null
      });
      const log = await getInventoryLogById(job.inventory_log_id);
      if (!log) throw new Error('Inventory log not found.');
      await syncLogToGoogleSheet(log);
      await updateInventorySyncJob(job.id, {
        status: 'completed',
        synced_at: new Date().toISOString(),
        last_error: null
      });
      results.push({ id: job.id, inventoryLogId: job.inventory_log_id, status: 'completed' });
    } catch (error) {
      await updateInventorySyncJob(job.id, {
        status: 'failed',
        last_error: error.message || 'Sync failed.'
      });
      results.push({ id: job.id, inventoryLogId: job.inventory_log_id, status: 'failed', error: error.message });
    }
  }
  return sendJson(res, 200, { ok: true, configured: true, processed: results.length, results });
}

module.exports = async function handler(req, res) {
  try {
    const action = String(req.query.action || 'template');

    if (req.method === 'POST' && action === 'sync') {
      return processInventorySheetSync(req, res);
    }

    const user = requireAuth(req);

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
