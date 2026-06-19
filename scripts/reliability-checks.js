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
const migration = read('supabase/migrations/20260612_normalize_pos.sql');
const orderRpcMigration = read('supabase/migrations/20260612_create_order_rpc.sql');
const inventoryMigration = read('supabase/migrations/20260619_inventory_feature.sql');
const auth = read('api/_lib/auth.js');
const inventoryApi = read('api/inventory.js');

assert.match(index, /const CART_STORAGE_KEY = 'bakerbake-pos-cart-v1'/);
assert.match(index, /localStorage\.setItem\(CART_STORAGE_KEY, JSON\.stringify\(cart\)\)/);
assert.doesNotMatch(index, /scheduleBackendSave|pushStateToBackend|preserveCart/);
assert.match(index, /async function confirmPayment\(\)/);
assert.match(index, /paymentSubmissionInProgress/);
assert.match(index, /requestId: activePaymentRequestId/);
assert.match(index, /async function patchOrder\(order, patch\)/);
assert.match(index, /connectRealtime/);
assert.match(index, /startFallbackSync/);
assert.match(index, /table: 'orders'/);
assert.match(index, /table: 'void_requests'/);
assert.doesNotMatch(index, /syncFromBackend\(\);\s*\}\s*}, 15000/);
assert.match(index, /id="view-inventory"/);
assert.match(index, /Daily Inventory Log/);
assert.match(index, /function inventoryPayloadLines\(\)/);
assert.match(index, /api\/inventory\?action=submit/);
assert.match(index, /data-inventory-remaining/);

assert.match(stateApi, /req\.method === 'PUT'/);
assert.match(stateApi, /sendJson\(res, 405/);
assert.doesNotMatch(stateApi, /writeDb|body\.cart/);

assert.match(ordersApi, /createOrderTransaction/);
assert.doesNotMatch(ordersApi, /upsertOrder/);
assert.doesNotMatch(ordersApi, /writeOrderCounter|writeAudit/);
assert.match(storage, /async function upsertOrder/);
assert.match(storage, /async function insertOrder/);
assert.match(storage, /rpc\/create_pos_order/);
assert.match(storage, /createOrderCompatibility/);
assert.match(storage, /schema cache/);
assert.match(storage, /order_items/);
assert.match(storage, /product_variants/);
assert.match(storage, /async function writeAudit/);
assert.match(auth, /async function authenticate/);
assert.match(auth, /createSupabaseToken/);
for (const table of ['products', 'product_variants', 'order_items', 'void_requests', 'pos_users', 'audit_logs']) {
  assert.match(migration, new RegExp(`create table if not exists public\\.${table}`));
}
assert.match(migration, /alter publication supabase_realtime add table public\.orders/);
assert.match(orderRpcMigration, /create or replace function public\.create_pos_order/);
assert.match(orderRpcMigration, /v_request_id/);
assert.match(orderRpcMigration, /'duplicate', true/);
assert.match(orderRpcMigration, /for update/);
assert.match(orderRpcMigration, /insert into public\.order_items/);
assert.match(orderRpcMigration, /insert into public\.audit_logs/);
assert.match(orderRpcMigration, /notify pgrst, 'reload schema'/);
for (const table of ['inventory_units', 'inventory_categories', 'inventory_items', 'inventory_logs', 'inventory_log_lines', 'inventory_sheet_sync_jobs']) {
  assert.match(inventoryMigration, new RegExp(`create table if not exists public\\.${table}`));
}
assert.match(inventoryMigration, /Coffee Items/);
assert.match(inventoryMigration, /Cookie - Mix-ins & Toppings/);
assert.match(inventoryMigration, /alter publication supabase_realtime add table public\.inventory_logs/);
assert.match(storage, /async function submitInventoryLog/);
assert.match(storage, /inventory_sheet_sync_jobs/);
assert.match(storage, /listPendingInventorySyncJobs/);
assert.match(inventoryApi, /action === 'template'/);
assert.match(inventoryApi, /action === 'submit'/);
assert.match(inventoryApi, /action === 'sync'/);
assert.match(inventoryApi, /GOOGLE_SHEETS_SPREADSHEET_ID/);
assert.match(inventoryApi, /listPendingInventorySyncJobs/);
assert.match(inventoryApi, /valueInputOption=USER_ENTERED/);
assert.doesNotMatch(storage, /supabaseFetch\('orders',\s*\{\s*method: 'DELETE'/);
assert.doesNotMatch(server, /supabaseFetch\('orders',\s*\{\s*method: 'DELETE'/);
assert.match(server, /Use the resource-specific order and product endpoints/);

console.log('Reliability checks passed.');
