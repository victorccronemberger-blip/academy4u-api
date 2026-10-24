import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/check-galatic-readiness.mjs', import.meta.url));
async function probe({ open = false, args = [] } = {}) {
  const calls = [];
  const server = http.createServer((request, response) => {
    calls.push({ method: request.method, path: request.url });
    const bodies = {
      '/health/galatic': { status: 'ok' },
      '/v1/galatic/checkout/status': { environment: 'production', salesEnabled: open, enabled: open, reason: open ? null : 'store_not_open' },
      '/v1/galatic/shipping/status': { enabled: open },
      '/v1/galatic/catalog/products': { products: open ? [{ sku: 'SYNTHETIC', active: 1, unit_amount: 100 }] : [] },
    };
    response.writeHead(Object.hasOwn(bodies, request.url) ? 200 : 404, { 'content-type': 'application/json' });
    response.end(JSON.stringify(bodies[request.url] || {}));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const child = spawn(process.execPath, [script, ...args], { env: { ...process.env, GALATIC_AUDIT_API_ORIGIN: `http://127.0.0.1:${server.address().port}` } });
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    return { code, output, calls };
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test('deployment probe accepts a healthy closed store with no sellable catalog using GET only', async () => {
  const result = await probe();
  assert.equal(result.code, 0, result.output);
  assert.equal(JSON.parse(result.output).salesEnabled, false);
  assert.equal(result.calls.length, 4);
  assert.ok(result.calls.every(call => call.method === 'GET'));
});
test('deployment probe rejects sales unexpectedly enabled', async () => {
  const result = await probe({ open: true });
  assert.notEqual(result.code, 0);
  assert.match(result.output, /Sales gate differs/);
});
test('opening probe requires an explicit sales-state flag', async () => {
  const result = await probe({ open: true, args: ['--sales-state=open'] });
  assert.equal(result.code, 0, result.output);
  assert.ok(result.calls.every(call => call.method === 'GET'));
});
