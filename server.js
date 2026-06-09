const http = require('http');
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;

loadDotEnv();

const DATA_DIR = path.join(ROOT, 'data');
const DB_PATH = path.join(DATA_DIR, 'db.json');
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 3000);
const SUPABASE_URL = normalizeSupabaseUrl(process.env.SUPABASE_URL || '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const USE_SUPABASE = Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const POS_USERS_JSON = process.env.POS_USERS_JSON || '[]';
const TOKEN_TTL_SECONDS = Number(process.env.TOKEN_TTL_SECONDS || 60 * 60 * 12);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon'
};

function loadDotEnv() {
  try {
    const envPath = path.join(ROOT, '.env');
    const raw = require('fs').readFileSync(envPath, 'utf8');
    raw.split(/\r?\n/).forEach(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      const eq = trimmed.indexOf('=');
      if (eq === -1) return;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      if (key && process.env[key] === undefined) {
        process.env[key] = value;
      }
    });
  } catch {
    // .env is optional. Without it, the backend uses local JSON storage.
  }
}

function normalizeSupabaseUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    return url.origin;
  } catch {
    return raw.replace(/\/rest\/v1\/?$/i, '').replace(/\/$/, '');
  }
}

function base64Url(input) {
  return Buffer.from(input).toString('base64url');
}

function sign(value) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('base64url');
}

function getUsers() {
  try {
    const users = JSON.parse(POS_USERS_JSON);
    return Array.isArray(users) ? users : [];
  } catch {
    return [];
  }
}

function verifyPassword(password, passwordHash) {
  const parts = String(passwordHash || '').split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = Number(parts[1]);
  const salt = parts[2];
  const expected = parts[3];
  if (!Number.isInteger(iterations) || !salt || !expected) return false;
  const actual = crypto.pbkdf2Sync(String(password), salt, iterations, 32, 'sha256').toString('base64url');
  return crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

function publicUser(user) {
  return {
    username: user.username,
    name: user.name,
    role: user.role || 'cashier'
  };
}

function createToken(user) {
  if (!SESSION_SECRET) {
    const error = new Error('SESSION_SECRET is not configured.');
    error.statusCode = 500;
    throw error;
  }
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: user.username,
    name: user.name,
    role: user.role || 'cashier',
    iat: now,
    exp: now + TOKEN_TTL_SECONDS
  };
  const encoded = base64Url(JSON.stringify(payload));
  return `${encoded}.${sign(encoded)}`;
}

function verifyToken(token) {
  if (!SESSION_SECRET || !token || !token.includes('.')) return null;
  const [encoded, signature] = token.split('.');
  const expected = sign(encoded);
  if (!signature || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

function requireAuth(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const user = verifyToken(token);
  if (!user) {
    const error = new Error('Unauthorized');
    error.statusCode = 401;
    throw error;
  }
  return user;
}

function requireRole(req, role) {
  const user = requireAuth(req);
  if (user.role !== role) {
    const error = new Error('Forbidden');
    error.statusCode = 403;
    throw error;
  }
  return user;
}

function defaultDb() {
  return {
    cart: {},
    orders: [],
    orderCounter: 1001,
    closeouts: [],
    products: [],
    updatedAt: null
  };
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

async function supabaseFetch(table, options = {}) {
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

async function readSupabaseDb() {
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
    cart: {},
    orders,
    orderCounter: Number.isInteger(savedCounter) ? Math.max(savedCounter, nextCounter) : nextCounter,
    products: Array.isArray(productRows?.[0]?.value) ? productRows[0].value : [],
    closeouts: (closeoutRows || []).map(mapCloseoutFromSupabase),
    updatedAt: new Date().toISOString(),
    storage: 'supabase'
  };
}

async function writeSupabaseDb(db) {
  const next = { ...defaultDb(), ...db };
  const ordersPayload = next.orders.map(mapOrderToSupabase);
  await Promise.all([
    supabaseFetch('orders', { method: 'DELETE', query: '?id=gte.0', prefer: 'return=minimal' }),
    supabaseFetch('closeouts', { method: 'DELETE', query: '?id=gte.0', prefer: 'return=minimal' })
  ]);
  if (ordersPayload.length) {
    await supabaseFetch('orders', { method: 'POST', body: ordersPayload });
  }
  if (next.closeouts.length) {
    await supabaseFetch('closeouts', { method: 'POST', body: next.closeouts.map(mapCloseoutToSupabase) });
  }
  await supabaseFetch('app_state', {
    method: 'POST',
    query: '?on_conflict=key',
    prefer: 'resolution=merge-duplicates,return=representation',
    body: [
      { key: 'order_counter', value: next.orderCounter },
      { key: 'product_catalog', value: Array.isArray(next.products) ? next.products : [] }
    ]
  });
  return readSupabaseDb();
}

async function ensureDb() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(DB_PATH);
  } catch {
    await writeDb(defaultDb());
  }
}

async function readDb() {
  if (USE_SUPABASE) return readSupabaseDb();
  await ensureDb();
  try {
    const raw = await fs.readFile(DB_PATH, 'utf8');
    return { ...defaultDb(), ...JSON.parse(raw) };
  } catch {
    return defaultDb();
  }
}

async function writeDb(db) {
  if (USE_SUPABASE) return writeSupabaseDb(db);
  await fs.mkdir(DATA_DIR, { recursive: true });
  const payload = {
    ...defaultDb(),
    ...db,
    updatedAt: new Date().toISOString()
  };
  await fs.writeFile(DB_PATH, JSON.stringify(payload, null, 2));
  return payload;
}

async function writeProducts(products) {
  if (USE_SUPABASE) {
    await supabaseFetch('app_state', {
      method: 'POST',
      query: '?on_conflict=key',
      prefer: 'resolution=merge-duplicates,return=representation',
      body: [{ key: 'product_catalog', value: products }]
    });
    return products;
  }
  const db = await readDb();
  db.products = products;
  const saved = await writeDb(db);
  return saved.products;
}

async function readJson(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 2_000_000) {
      const error = new Error('Request body too large');
      error.statusCode = 413;
      throw error;
    }
  }
  return body ? JSON.parse(body) : {};
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(data));
}

function sendError(res, error) {
  sendJson(res, error.statusCode || 500, {
    error: error.message || 'Server error'
  });
}

async function handleApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/health') {
    let supabaseOk = false;
    let supabaseError = null;
    if (USE_SUPABASE) {
      try {
        await supabaseFetch('app_state', { query: '?key=eq.order_counter&select=key&limit=1' });
        supabaseOk = true;
      } catch (error) {
        supabaseError = error.message;
      }
    }
    sendJson(res, 200, {
      ok: true,
      name: 'BakerBake POS API',
      storage: USE_SUPABASE ? 'supabase' : 'json',
      auth: {
        configured: Boolean(SESSION_SECRET && getUsers().length)
      },
      supabase: USE_SUPABASE
        ? { ok: supabaseOk, url: SUPABASE_URL, error: supabaseError }
        : null
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/login') {
    const body = await readJson(req);
    const username = String(body.username || '').trim().toLowerCase();
    const password = String(body.password || '');
    const users = getUsers();
    const user = users.find(candidate => String(candidate.username || '').toLowerCase() === username);

    if (!SESSION_SECRET || !users.length) {
      sendJson(res, 500, { error: 'Backend authentication is not configured.' });
      return;
    }

    if (!user || !verifyPassword(password, user.passwordHash)) {
      sendJson(res, 401, { error: 'Invalid username or password.' });
      return;
    }

    sendJson(res, 200, {
      user: publicUser(user),
      token: createToken(user)
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/session') {
    const user = requireAuth(req);
    sendJson(res, 200, { user });
    return;
  }

  const authenticatedUser = requireAuth(req);

  if (req.method === 'GET' && url.pathname === '/api/state') {
    const db = await readDb();
    sendJson(res, 200, authenticatedUser.role === 'admin'
      ? { ...db, cart: {} }
      : { cart: db.cart, orders: db.orders, orderCounter: db.orderCounter, products: db.products, updatedAt: db.updatedAt, storage: db.storage });
    return;
  }

  if (req.method === 'PUT' && url.pathname === '/api/state') {
    if (authenticatedUser.role !== 'cashier') {
      sendJson(res, 403, { error: 'Forbidden' });
      return;
    }
    const body = await readJson(req);
    const currentDb = await readDb();
    const nextDb = {
      ...currentDb,
      cart: body.cart && typeof body.cart === 'object' ? body.cart : {},
      orders: Array.isArray(body.orders) ? body.orders : [],
      orderCounter: Number.isInteger(body.orderCounter) ? body.orderCounter : currentDb.orderCounter
    };
    sendJson(res, 200, await writeDb(nextDb));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/orders') {
    const db = await readDb();
    sendJson(res, 200, { orders: db.orders, orderCounter: db.orderCounter });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/orders') {
    requireRole(req, 'cashier');
    const order = await readJson(req);
    const db = await readDb();
    const id = Number.isInteger(order.id) ? order.id : db.orderCounter;
    const savedOrder = { ...order, id };
    db.orders = [savedOrder, ...db.orders.filter(existing => existing.id !== id)];
    db.orderCounter = Math.max(db.orderCounter, id + 1);
    await writeDb(db);
    sendJson(res, 201, { order: savedOrder, orderCounter: db.orderCounter });
    return;
  }

  const orderMatch = url.pathname.match(/^\/api\/orders\/(\d+)$/);
  if (orderMatch && req.method === 'PATCH') {
    requireRole(req, 'cashier');
    const id = Number(orderMatch[1]);
    const patch = await readJson(req);
    const db = await readDb();
    const index = db.orders.findIndex(order => order.id === id);
    if (index === -1) {
      sendJson(res, 404, { error: 'Order not found' });
      return;
    }
    db.orders[index] = { ...db.orders[index], ...patch, id };
    await writeDb(db);
    sendJson(res, 200, { order: db.orders[index] });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/closeouts') {
    requireRole(req, 'admin');
    const db = await readDb();
    sendJson(res, 200, { closeouts: db.closeouts || [] });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/closeouts') {
    requireRole(req, 'admin');
    const closeout = await readJson(req);
    const db = await readDb();
    const saved = {
      id: closeout.id || Date.now(),
      createdAt: closeout.createdAt || new Date().toISOString(),
      ...closeout
    };
    db.closeouts = [saved, ...(db.closeouts || [])];
    await writeDb(db);
    sendJson(res, 201, { closeout: saved });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/products') {
    const db = await readDb();
    sendJson(res, 200, { products: db.products || [] });
    return;
  }

  if (req.method === 'PUT' && url.pathname === '/api/products') {
    requireRole(req, 'admin');
    const body = await readJson(req);
    if (!Array.isArray(body.products)) {
      sendJson(res, 400, { error: 'Products must be an array.' });
      return;
    }
    const products = await writeProducts(body.products);
    sendJson(res, 200, { products });
    return;
  }

  sendJson(res, 404, { error: 'API route not found' });
}

function safeStaticPath(urlPath) {
  const decoded = decodeURIComponent(urlPath);
  const requested = decoded === '/' ? '/index.html' : decoded;
  const resolved = path.resolve(ROOT, `.${requested}`);
  if (!resolved.startsWith(ROOT)) return null;
  return resolved;
}

async function serveStatic(req, res, url) {
  const filePath = safeStaticPath(url.pathname);
  if (!filePath) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  try {
    const data = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream'
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      return;
    }
    await serveStatic(req, res, url);
  } catch (error) {
    sendError(res, error);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`BakerBake POS running at http://${HOST}:${PORT}`);
});
