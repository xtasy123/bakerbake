const crypto = require('crypto');
const {
  getInventoryLogById,
  listPendingInventorySyncJobs,
  sendError,
  sendJson,
  updateInventorySyncJob
} = require('./_lib/supabase-storage');
const { requireAuth } = require('./_lib/auth');

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

function base64Url(value) {
  return Buffer.from(value).toString('base64url');
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

module.exports = async function handler(req, res) {
  try {
    assertCanRunSync(req);
    const pendingJobs = await listPendingInventorySyncJobs({ limit: Number(req.query?.limit || 5) });
    if (!ensureGoogleConfig()) {
      sendJson(res, 200, {
        ok: true,
        configured: false,
        pending: pendingJobs.length,
        message: 'Google Sheets sync is not configured.'
      });
      return;
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
    sendJson(res, 200, { ok: true, configured: true, processed: results.length, results });
  } catch (error) {
    sendError(res, error);
  }
};
