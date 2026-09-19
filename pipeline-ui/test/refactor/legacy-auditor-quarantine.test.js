const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const app = require(path.join(ROOT, 'server'));

function request(port, method, route, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path: route, method,
      headers: { 'Content-Type': 'application/json' }
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function run() {
  const productionFiles = [
    'server.js', 'public/index.html', 'public/app.js', 'desktop-main.js', 'package.json'
  ];
  for (const relative of productionFiles) {
    const source = fs.readFileSync(path.join(ROOT, relative), 'utf8');
    assert.doesNotMatch(source, /codex-chatgpt-web|127\.0\.0\.1:17841|chatgpt-web\//i, `${relative} still references the removed bridge`);
  }

  const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  assert.match(html, /Đang chuyển sang Native Codex/);

  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  try {
    const cases = [
      ['GET', '/api/chatgpt/status', null],
      ['POST', '/api/chatgpt/login', {}],
      ['POST', '/api/chatgpt/logout', {}],
      ['POST', '/api/chatgpt/verify', {}],
      ['POST', '/api/models/test', { provider: 'chatgpt' }],
      ['POST', '/api/orchestrator/create-workorder', { goal: 'test' }],
      ['POST', '/api/orchestrator/audit', { workOrder: {}, workerReport: {} }],
      ['POST', '/api/orchestrator/audit-and-direct', { projectId: 'test' }],
      ['POST', '/api/orchestrator/user-directive', { projectId: 'test', userPrompt: 'test' }]
    ];
    for (const [method, route, body] of cases) {
      const response = await request(port, method, route, body);
      assert.strictEqual(response.status, 410, route);
      assert.strictEqual(response.body.code, 'LEGACY_AUDITOR_REMOVED', route);
      assert.strictEqual(response.body.state, 'NATIVE_AUDITOR_NOT_IMPLEMENTED', route);
      assert.strictEqual(response.body.ok, false, route);
    }

    const status = await request(port, 'GET', '/api/status');
    assert.strictEqual(status.status, 200);
    assert.deepStrictEqual(status.body.auditor, {
      status: 'unavailable',
      state: 'NATIVE_AUDITOR_NOT_IMPLEMENTED'
    });
    assert.ok(!Object.hasOwn(status.body, 'chatgptProxy'));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  console.log('✓ WP-V4-02A legacy auditor quarantine contract passed.');
}

if (require.main === module) {
  run().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { run };
