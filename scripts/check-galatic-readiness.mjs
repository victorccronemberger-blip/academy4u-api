import assert from 'node:assert/strict';

// Read-only deployment probe: no customers, orders, quotes or labels are created.
const origin = String(process.env.GALATIC_AUDIT_API_ORIGIN || 'https://api.academy4u.com.br').replace(/\/$/, '');
const expectedEnvironment = process.argv.find(value => value.startsWith('--environment='))?.split('=')[1] || 'production';
const expectedSales = process.argv.find(value => value.startsWith('--sales-state='))?.split('=')[1] || 'closed';
assert.ok(['production', 'sandbox'].includes(expectedEnvironment));
assert.ok(['closed', 'open'].includes(expectedSales));

async function read(path) {
  const response = await fetch(`${origin}${path}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
  assert.equal(response.status, 200, `${path}: HTTP ${response.status}`);
  return response.json();
}

const [health, checkout, shipping, catalog] = await Promise.all([
  read('/health/galatic'), read('/v1/galatic/checkout/status'),
  read('/v1/galatic/shipping/status'), read('/v1/galatic/catalog/products'),
]);
assert.equal(health.status, 'ok', 'Galatic database/service is not ready');
assert.equal(checkout.environment, expectedEnvironment, 'Unexpected shared payment environment');
assert.equal(checkout.salesEnabled, expectedSales === 'open', 'Sales gate differs from the release decision');
if (expectedSales === 'closed') {
  assert.equal(checkout.enabled, false);
  assert.equal(checkout.reason, 'store_not_open');
} else {
  assert.equal(checkout.enabled, true, 'Payment provider is unavailable');
  assert.equal(shipping.enabled, true, 'Shipping is unavailable');
}
const products = Array.isArray(catalog.products) ? catalog.products : [];
assert.equal(new Set(products.map(product => product.sku)).size, products.length, 'Duplicate product identity');
assert.ok(products.every(product => typeof product.sku === 'string' && product.sku.trim()), 'Invalid product identity');
const active = products.filter(product => Number(product.active) === 1);
assert.ok(active.every(product => Number.isInteger(Number(product.unit_amount)) && Number(product.unit_amount) > 0), 'Active product without a valid price');
if (expectedSales === 'open') assert.ok(active.length > 0, 'Open store without active products');
console.log(JSON.stringify({
  ok: true, probe: 'read-only-readiness', environment: checkout.environment,
  salesEnabled: checkout.salesEnabled, paymentEnabled: checkout.enabled,
  shippingEnabled: shipping.enabled, products: products.length, activeProducts: active.length,
  scope: 'HTTP health, public contracts and sales gate; not payment, delivery or supplier certification',
}, null, 2));
