const assert = require('node:assert');
const http = require('node:http');
const app = require('../server');

function request(port, method, route, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: route, method, headers: { 'Content-Type': 'application/json' } }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(raw) }));
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function runTests() {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  try {
    const models = await request(port, 'GET', '/api/models');
    assert.strictEqual(models.status, 200);
    assert.deepStrictEqual(models.json.chatgpt, { status: 'unavailable', state: 'NATIVE_AUDITOR_NOT_IMPLEMENTED', defaultModel: null, models: [] });
    assert.ok(models.json.antigravity.models.length > 0);

    const routes = [
      ['/api/orchestrator/create-workorder', { goal: 'test' }],
      ['/api/orchestrator/audit', { workOrder: {}, workerReport: {} }],
      ['/api/orchestrator/audit-and-direct', { projectId: 'test' }],
      ['/api/orchestrator/user-directive', { projectId: 'test', userPrompt: 'test' }]
    ];
    for (const [route, body] of routes) {
      const response = await request(port, 'POST', route, body);
      assert.strictEqual(response.status, 410, route);
      assert.strictEqual(response.json.code, 'LEGACY_AUDITOR_REMOVED');
      assert.strictEqual(response.json.state, 'NATIVE_AUDITOR_NOT_IMPLEMENTED');
    }
    console.log('✓ Legacy closed-loop surface is quarantined pending Native Codex transport.');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

if (require.main === module) runTests().catch((error) => { console.error(error); process.exit(1); });
module.exports = { runTests };
