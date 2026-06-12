const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

const index = read('index.html');
const stateApi = read('api/state.js');
const ordersApi = read('api/orders.js');
const storage = read('api/_lib/supabase-storage.js');
const server = read('server.js');

assert.match(index, /const CART_STORAGE_KEY = 'bakerbake-pos-cart-v1'/);
assert.match(index, /localStorage\.setItem\(CART_STORAGE_KEY, JSON\.stringify\(cart\)\)/);
assert.doesNotMatch(index, /scheduleBackendSave|pushStateToBackend|preserveCart/);
assert.match(index, /async function confirmPayment\(\)/);
assert.match(index, /paymentSubmissionInProgress/);
assert.match(index, /requestId: activePaymentRequestId/);
assert.match(index, /async function patchOrder\(order, patch\)/);

assert.match(stateApi, /req\.method === 'PUT'/);
assert.match(stateApi, /sendJson\(res, 405/);
assert.doesNotMatch(stateApi, /writeDb|body\.cart/);

assert.match(ordersApi, /order\.requestId/);
assert.match(ordersApi, /insertOrder/);
assert.doesNotMatch(ordersApi, /upsertOrder/);
assert.match(storage, /async function upsertOrder/);
assert.match(storage, /async function insertOrder/);
assert.doesNotMatch(storage, /supabaseFetch\('orders',\s*\{\s*method: 'DELETE'/);
assert.doesNotMatch(server, /supabaseFetch\('orders',\s*\{\s*method: 'DELETE'/);
assert.match(server, /Use the resource-specific order and product endpoints/);

console.log('Reliability checks passed.');
