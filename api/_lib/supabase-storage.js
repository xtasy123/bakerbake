const crypto = require('crypto');
const SUPABASE_URL = normalizeSupabaseUrl(process.env.SUPABASE_URL || '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const PRODUCT_IMAGE_BUCKET = process.env.PRODUCT_IMAGE_BUCKET || 'product-images';

function normalizeSupabaseUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    return new URL(raw).origin;
  } catch {
    return raw.replace(/\/rest\/v1\/?$/i, '').replace(/\/$/, '');
  }
}

function ensureSupabaseConfig() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    const error = new Error('Supabase environment variables are not configured.');
    error.statusCode = 500;
    throw error;
  }
}

async function supabaseFetch(table, options = {}) {
  ensureSupabaseConfig();
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${table}${options.query || ''}`, {
    method: options.method || 'GET',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: options.prefer || 'return=representation',
      ...(options.headers || {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const error = new Error(data?.message || data?.error || `Supabase request failed: ${response.status}`);
    error.statusCode = response.status;
    throw error;
  }
  return data;
}

function defaultDb() {
  return { cart: {}, orders: [], orderCounter: 1001, closeouts: [], products: [], updatedAt: null, storage: 'supabase' };
}

function mapOrderFromSupabase(row) {
  return row.payload || {
    id: row.id,
    items: row.items || [],
    total: Number(row.total || 0),
    customerName: row.customer_name || 'Walk-in',
    cashier: row.cashier || 'Unknown',
    status: row.status || 'pending',
    createdAt: row.created_at,
    completedAt: row.completed_at,
    payment: row.payment || null,
    method: row.payment_method || 'cash'
  };
}

function mapOrderToSupabase(order) {
  return {
    id: order.id,
    customer_name: order.customerName || 'Walk-in',
    cashier: order.cashier || 'Unknown',
    status: order.status || 'pending',
    total: Number(order.total || 0),
    payment_method: order.payment?.method || order.method || 'cash',
    payment: order.payment || null,
    items: Array.isArray(order.items) ? order.items : [],
    payload: order,
    created_at: order.createdAt || new Date().toISOString(),
    completed_at: order.completedAt || null,
    updated_at: new Date().toISOString()
  };
}

function mapCloseoutFromSupabase(row) {
  return row.payload || {
    id: row.id,
    expectedCash: Number(row.expected_cash || 0),
    actualCash: Number(row.actual_cash || 0),
    difference: Number(row.difference || 0),
    note: row.note || '',
    cashier: row.cashier || 'Unknown',
    createdAt: row.created_at
  };
}

function mapCloseoutToSupabase(closeout) {
  return {
    id: closeout.id,
    expected_cash: Number(closeout.expectedCash || closeout.expected_cash || 0),
    actual_cash: Number(closeout.actualCash || closeout.actual_cash || 0),
    difference: Number(closeout.difference || 0),
    note: closeout.note || '',
    cashier: closeout.cashier || 'Unknown',
    payload: closeout,
    created_at: closeout.createdAt || new Date().toISOString()
  };
}

async function readDb() {
  const [ordersRows, counterRows, productRows, closeoutRows] = await Promise.all([
    supabaseFetch('orders', { query: '?select=*&order=id.desc' }),
    supabaseFetch('app_state', { query: '?key=eq.order_counter&select=value&limit=1' }),
    supabaseFetch('app_state', { query: '?key=eq.product_catalog&select=value&limit=1' }),
    supabaseFetch('closeouts', { query: '?select=*&order=created_at.desc' })
  ]);
  const orders = (ordersRows || []).map(mapOrderFromSupabase);
  const savedCounter = Number(counterRows?.[0]?.value);
  const nextCounter = orders.reduce((max, order) => Math.max(max, Number(order.id || 0) + 1), 1001);
  return {
    ...defaultDb(),
    orders,
    orderCounter: Number.isInteger(savedCounter) ? Math.max(savedCounter, nextCounter) : nextCounter,
    products: Array.isArray(productRows?.[0]?.value) ? productRows[0].value : [],
    closeouts: (closeoutRows || []).map(mapCloseoutFromSupabase),
    updatedAt: new Date().toISOString()
  };
}

async function writeDb(db) {
  const next = { ...defaultDb(), ...db };
  await Promise.all([
    supabaseFetch('orders', { method: 'DELETE', query: '?id=gte.0', prefer: 'return=minimal' }),
    supabaseFetch('closeouts', { method: 'DELETE', query: '?id=gte.0', prefer: 'return=minimal' })
  ]);
  if (next.orders.length) await supabaseFetch('orders', { method: 'POST', body: next.orders.map(mapOrderToSupabase) });
  if (next.closeouts.length) await supabaseFetch('closeouts', { method: 'POST', body: next.closeouts.map(mapCloseoutToSupabase) });
  await supabaseFetch('app_state', {
    method: 'POST',
    query: '?on_conflict=key',
    prefer: 'resolution=merge-duplicates,return=representation',
    body: [
      { key: 'order_counter', value: next.orderCounter },
      { key: 'product_catalog', value: Array.isArray(next.products) ? next.products : [] }
    ]
  });
  return readDb();
}

async function writeProducts(products) {
  await supabaseFetch('app_state', {
    method: 'POST',
    query: '?on_conflict=key',
    prefer: 'resolution=merge-duplicates,return=representation',
    body: [{ key: 'product_catalog', value: products }]
  });
  return products;
}

async function uploadProductImage({ data, contentType }) {
  ensureSupabaseConfig();
  const extensions = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/avif': 'avif'
  };
  const extension = extensions[contentType];
  if (!extension || typeof data !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
    const error = new Error('Invalid image upload.');
    error.statusCode = 400;
    throw error;
  }
  const bytes = Buffer.from(data, 'base64');
  if (!bytes.length || bytes.length > 2_000_000) {
    const error = new Error('Image must be 2 MB or smaller after processing.');
    error.statusCode = 413;
    throw error;
  }
  const validSignature =
    (contentType === 'image/jpeg' && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) ||
    (contentType === 'image/png' && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) ||
    (contentType === 'image/webp' && bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') ||
    (contentType === 'image/avif' && bytes.subarray(4, 12).toString().startsWith('ftypavi'));
  if (!validSignature) {
    const error = new Error('Uploaded file does not match its image type.');
    error.statusCode = 400;
    throw error;
  }
  const objectPath = `products/${Date.now()}-${crypto.randomUUID()}.${extension}`;
  const response = await fetch(`${SUPABASE_URL}/storage/v1/object/${PRODUCT_IMAGE_BUCKET}/${objectPath}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': contentType,
      'x-upsert': 'false'
    },
    body: bytes
  });
  const responseBody = await response.text();
  if (!response.ok) {
    let message = responseBody;
    try {
      const parsed = JSON.parse(responseBody);
      message = parsed.message || parsed.error || message;
    } catch {}
    const error = new Error(message || `Image upload failed: ${response.status}`);
    error.statusCode = response.status;
    throw error;
  }
  return {
    path: objectPath,
    url: `${SUPABASE_URL}/storage/v1/object/public/${PRODUCT_IMAGE_BUCKET}/${objectPath}`
  };
}

async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return req.body ? JSON.parse(req.body) : {};
  return {};
}

function sendJson(res, statusCode, data) {
  res.status(statusCode).json(data);
}

function sendError(res, error) {
  sendJson(res, error.statusCode || 500, { error: error.message || 'Server error' });
}

module.exports = {
  SUPABASE_URL,
  supabaseFetch,
  readDb,
  writeDb,
  writeProducts,
  uploadProductImage,
  readJson,
  sendJson,
  sendError
};
