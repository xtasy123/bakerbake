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
  const normalizedItems = Array.isArray(row.order_items)
    ? row.order_items
      .sort((a, b) => Number(a.id) - Number(b.id))
      .map(item => ({
        productId: item.product_id,
        name: item.product_name,
        variantId: item.variant_key,
        size: item.size_label,
        qty: Number(item.quantity),
        price: Number(item.unit_price)
      }))
    : null;
  const request = Array.isArray(row.void_requests)
    ? [...row.void_requests].sort((a, b) => new Date(b.requested_at) - new Date(a.requested_at))[0]
    : null;
  const order = {
    id: row.id,
    requestId: row.request_id || null,
    items: normalizedItems || row.items || row.payload?.items || [],
    total: Number(row.total || 0),
    customerName: row.customer_name || 'Walk-in',
    cashier: row.cashier || 'Unknown',
    status: row.status || 'pending',
    createdAt: row.created_at,
    completedAt: row.completed_at,
    payment: row.payment || null,
    method: row.payment_method || 'cash',
    previousStatus: row.previous_status || undefined,
    previouslyCompleted: row.previously_completed || false,
    lastCompletedAt: row.last_completed_at || undefined,
    voidReason: row.void_reason || undefined,
    voidedAt: row.voided_at || undefined,
    voidedBy: row.voided_by || undefined,
    authorizedBy: row.authorized_by || undefined
  };
  if (request) {
    order.voidRequest = {
      id: request.id,
      status: request.status,
      reason: request.reason,
      requestedBy: request.requested_by,
      requestedAt: request.requested_at,
      reviewedBy: request.reviewed_by,
      reviewedAt: request.reviewed_at
    };
  }
  return { ...order, updatedAt: row.updated_at || order.updatedAt || null };
}

function mapOrderToSupabase(order) {
  return {
    id: order.id,
    request_id: order.requestId || null,
    customer_name: order.customerName || 'Walk-in',
    cashier: order.cashier || 'Unknown',
    status: order.status || 'pending',
    total: Number(order.total || 0),
    payment_method: order.payment?.method || order.method || 'cash',
    payment: order.payment || null,
    items: [],
    payload: {},
    created_at: order.createdAt || new Date().toISOString(),
    completed_at: order.completedAt || null,
    previous_status: order.previousStatus || null,
    previously_completed: order.previouslyCompleted === true,
    last_completed_at: order.lastCompletedAt || null,
    void_reason: order.voidReason || null,
    voided_at: order.voidedAt || null,
    voided_by: order.voidedBy || null,
    authorized_by: order.authorizedBy || null,
    updated_at: new Date().toISOString()
  };
}

function mapOrderItemToSupabase(orderId, item) {
  return {
    order_id: orderId,
    product_id: item.productId || null,
    product_name: item.name || 'Unknown item',
    variant_key: item.variantId || null,
    size_label: item.size || null,
    quantity: Number(item.qty || 1),
    unit_price: Number(item.price || 0)
  };
}

function mapProductFromSupabase(row) {
  const variants = (row.product_variants || [])
    .sort((a, b) => Number(a.sort_order) - Number(b.sort_order))
    .map(variant => ({
      id: variant.variant_key,
      label: variant.label,
      price: Number(variant.price)
    }));
  const product = {
    id: Number(row.id),
    name: row.name,
    filter: row.category,
    subgroup: row.subgroup,
    imageUrl: row.image_url || '',
    active: row.active !== false
  };
  if (variants.length === 1 && variants[0].id === 'single') product.price = variants[0].price;
  else product.variants = variants;
  return product;
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
    supabaseFetch('orders', { query: '?select=*,order_items(*),void_requests(*)&order=id.desc' }),
    supabaseFetch('app_state', { query: '?key=eq.order_counter&select=value&limit=1' }),
    supabaseFetch('products', { query: '?select=*,product_variants(*)&order=sort_order.asc,id.asc' }),
    supabaseFetch('closeouts', { query: '?select=*&order=created_at.desc' })
  ]);
  const orders = (ordersRows || []).map(mapOrderFromSupabase);
  const savedCounter = Number(counterRows?.[0]?.value);
  const nextCounter = orders.reduce((max, order) => Math.max(max, Number(order.id || 0) + 1), 1001);
  return {
    ...defaultDb(),
    orders,
    orderCounter: Number.isInteger(savedCounter) ? Math.max(savedCounter, nextCounter) : nextCounter,
    products: (productRows || []).map(mapProductFromSupabase),
    closeouts: (closeoutRows || []).map(mapCloseoutFromSupabase),
    updatedAt: new Date().toISOString()
  };
}

async function writeDb(db) {
  const next = { ...defaultDb(), ...db };
  if (next.orders.length) {
    await supabaseFetch('orders', {
      method: 'POST',
      query: '?on_conflict=id',
      prefer: 'resolution=merge-duplicates,return=minimal',
      body: next.orders.map(mapOrderToSupabase)
    });
  }
  if (next.closeouts.length) {
    await supabaseFetch('closeouts', {
      method: 'POST',
      query: '?on_conflict=id',
      prefer: 'resolution=merge-duplicates,return=minimal',
      body: next.closeouts.map(mapCloseoutToSupabase)
    });
  }
  await supabaseFetch('app_state', {
    method: 'POST',
    query: '?on_conflict=key',
    prefer: 'resolution=merge-duplicates,return=representation',
    body: [
      { key: 'order_counter', value: next.orderCounter }
    ]
  });
  return readDb();
}

async function writeProducts(products) {
  const rows = products.map((product, index) => ({
    id: product.id,
    name: product.name,
    category: product.filter,
    subgroup: product.subgroup || null,
    image_url: product.imageUrl || null,
    active: product.active !== false,
    sort_order: index,
    updated_at: new Date().toISOString()
  }));
  if (rows.length) {
    await supabaseFetch('products', {
      method: 'POST',
      query: '?on_conflict=id',
      prefer: 'resolution=merge-duplicates,return=minimal',
      body: rows
    });
  }
  for (const product of products) {
    await supabaseFetch('product_variants', {
      method: 'DELETE',
      query: `?product_id=eq.${encodeURIComponent(product.id)}`,
      prefer: 'return=minimal'
    });
    const variants = Array.isArray(product.variants)
      ? product.variants
      : [{ id: 'single', label: 'Single', price: product.price }];
    if (variants.length) {
      await supabaseFetch('product_variants', {
        method: 'POST',
        body: variants.map((variant, index) => ({
          product_id: product.id,
          variant_key: variant.id,
          label: variant.label || variant.id,
          price: Number(variant.price || 0),
          sort_order: index
        }))
      });
    }
  }
  return products;
}

async function upsertOrder(order) {
  const rows = await supabaseFetch('orders', {
    method: 'POST',
    query: '?on_conflict=id',
    prefer: 'resolution=merge-duplicates,return=representation',
    body: [mapOrderToSupabase(order)]
  });
  return replaceOrderItemsAndRead(rows[0], order.items);
}

async function insertOrder(order) {
  const rows = await supabaseFetch('orders', {
    method: 'POST',
    prefer: 'return=representation',
    body: [mapOrderToSupabase(order)]
  });
  return replaceOrderItemsAndRead(rows[0], order.items);
}

async function replaceOrderItemsAndRead(orderRow, items) {
  await supabaseFetch('order_items', {
    method: 'DELETE',
    query: `?order_id=eq.${encodeURIComponent(orderRow.id)}`,
    prefer: 'return=minimal'
  });
  if (Array.isArray(items) && items.length) {
    await supabaseFetch('order_items', {
      method: 'POST',
      prefer: 'return=minimal',
      body: items.map(item => mapOrderItemToSupabase(orderRow.id, item))
    });
  }
  const rows = await supabaseFetch('orders', {
    query: `?id=eq.${encodeURIComponent(orderRow.id)}&select=*,order_items(*),void_requests(*)&limit=1`
  });
  return mapOrderFromSupabase(rows[0]);
}

async function createVoidRequest(order, reason, actor) {
  const rows = await supabaseFetch('void_requests', {
    method: 'POST',
    body: [{
      order_id: order.id,
      status: 'pending',
      reason,
      requested_by: actor
    }]
  });
  return rows[0];
}

async function reviewVoidRequest(orderId, decision, actor) {
  const status = decision === 'approve' ? 'approved' : 'rejected';
  const rows = await supabaseFetch('void_requests', {
    method: 'PATCH',
    query: `?order_id=eq.${encodeURIComponent(orderId)}&status=eq.pending`,
    body: {
      status,
      reviewed_by: actor,
      reviewed_at: new Date().toISOString()
    }
  });
  return rows[0];
}

async function findUserByUsername(username) {
  const rows = await supabaseFetch('pos_users', {
    query: `?username=eq.${encodeURIComponent(username)}&active=eq.true&select=*&limit=1`
  });
  return rows?.[0] || null;
}

async function upsertUsers(users) {
  if (!users.length) return;
  await supabaseFetch('pos_users', {
    method: 'POST',
    query: '?on_conflict=username',
    prefer: 'resolution=merge-duplicates,return=minimal',
    body: users.map(user => ({
      username: String(user.username).toLowerCase(),
      name: user.name,
      role: user.role || 'cashier',
      password_hash: user.passwordHash,
      active: user.active !== false,
      updated_at: new Date().toISOString()
    }))
  });
}

async function writeAudit({ actor, action, entityType, entityId, details = {} }) {
  await supabaseFetch('audit_logs', {
    method: 'POST',
    prefer: 'return=minimal',
    body: [{
      actor_username: actor?.sub || actor?.username || null,
      actor_role: actor?.role || null,
      action,
      entity_type: entityType,
      entity_id: entityId == null ? null : String(entityId),
      details
    }]
  });
}

async function writeOrderCounter(orderCounter) {
  await supabaseFetch('app_state', {
    method: 'POST',
    query: '?on_conflict=key',
    prefer: 'resolution=merge-duplicates,return=representation',
    body: [{ key: 'order_counter', value: orderCounter }]
  });
}

async function insertCloseout(closeout) {
  const rows = await supabaseFetch('closeouts', {
    method: 'POST',
    body: [mapCloseoutToSupabase(closeout)]
  });
  return mapCloseoutFromSupabase(rows[0]);
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
  console.error(JSON.stringify({
    level: 'error',
    message: error.message || 'Server error',
    statusCode: error.statusCode || 500,
    stack: process.env.NODE_ENV === 'production' ? undefined : error.stack,
    timestamp: new Date().toISOString()
  }));
  sendJson(res, error.statusCode || 500, { error: error.message || 'Server error' });
}

module.exports = {
  SUPABASE_URL,
  supabaseFetch,
  readDb,
  writeDb,
  upsertOrder,
  insertOrder,
  createVoidRequest,
  reviewVoidRequest,
  findUserByUsername,
  upsertUsers,
  writeAudit,
  writeOrderCounter,
  insertCloseout,
  writeProducts,
  uploadProductImage,
  readJson,
  sendJson,
  sendError
};
