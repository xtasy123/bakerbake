const crypto = require('crypto');

const SESSION_SECRET = process.env.SESSION_SECRET || '';
const POS_USERS_JSON = process.env.POS_USERS_JSON || '[]';
const TOKEN_TTL_SECONDS = Number(process.env.TOKEN_TTL_SECONDS || 60 * 60 * 12);
const SUPABASE_JWT_SECRET = process.env.SUPABASE_JWT_SECRET || '';

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

function createSupabaseToken(user) {
  if (!SUPABASE_JWT_SECRET) return '';
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64Url(JSON.stringify({
    sub: user.username || user.sub,
    role: 'authenticated',
    app_role: user.role || 'cashier',
    name: user.name,
    iat: now,
    exp: now + Math.min(TOKEN_TTL_SECONDS, 60 * 60)
  }));
  const signature = crypto
    .createHmac('sha256', SUPABASE_JWT_SECRET)
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${signature}`;
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

async function authenticate(username, password) {
  const { findUserByUsername, upsertUsers } = require('./supabase-storage');
  const fallbackUsers = getUsers();
  if (!SESSION_SECRET) {
    const error = new Error('Backend authentication is not configured.');
    error.statusCode = 500;
    throw error;
  }
  const normalized = String(username || '').trim().toLowerCase();
  let user = null;
  try {
    user = await findUserByUsername(normalized);
  } catch (error) {
    if (!fallbackUsers.length) throw error;
  }
  if (!user && fallbackUsers.length) {
    await upsertUsers(fallbackUsers);
    user = fallbackUsers.find(candidate => String(candidate.username || '').toLowerCase() === normalized);
  }
  if (user?.password_hash && !user.passwordHash) {
    user = { ...user, passwordHash: user.password_hash };
  }
  if (!user || !verifyPassword(password, user.passwordHash)) {
    const error = new Error('Invalid username or password.');
    error.statusCode = 401;
    throw error;
  }
  return {
    user: publicUser(user),
    token: createToken(user),
    realtimeToken: createSupabaseToken(user)
  };
}

module.exports = {
  authenticate,
  createToken,
  createSupabaseToken,
  publicUser,
  requireAuth,
  requireRole,
  verifyToken,
  getUsers,
  SESSION_SECRET
};
