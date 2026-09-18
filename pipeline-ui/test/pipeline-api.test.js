const http = require('http');
const assert = require('node:assert');
const app = require('../server');

const TEST_PORT = 4099;
let server;

function makeRequest(path, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path,
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {})
      },
      timeout: 10000
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (e) {}
        resolve({ statusCode: res.statusCode, headers: res.headers, raw: data, json });
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    if (options.body) req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    req.end();
  });
}

async function runTests() {
  console.log('--- Starting Pipeline Portal Automated Tests ---');

  // Start test server
  await new Promise((resolve) => {
    server = app.listen(TEST_PORT, () => {
      console.log(`[TEST] Server listening on http://127.0.0.1:${TEST_PORT}`);
      resolve();
    });
  });

  try {
    // 1. Static HTML Delivery
    console.log('[TEST 1] Testing static UI delivery (GET /)...');
    const indexRes = await makeRequest('/');
    assert.strictEqual(indexRes.statusCode, 200);
    assert.ok(indexRes.raw.includes('Pipeline') && indexRes.raw.includes('Portal'), 'index.html contains branding');
    console.log('✓ PASS: Static UI delivery verified.');

    // 2. System Status API
    console.log('[TEST 2] Testing system health status (GET /api/status)...');
    const statusRes = await makeRequest('/api/status');
    assert.strictEqual(statusRes.statusCode, 200);
    assert.ok(statusRes.json, 'Status returned JSON');
    assert.ok(statusRes.json.aoDaemon, 'Has aoDaemon field');
    assert.ok(statusRes.json.chatgptProxy, 'Has chatgptProxy field');
    assert.ok(statusRes.json.agents.agy.installed, 'Antigravity agy installed');
    console.log(`✓ PASS: Health status verified. AO: ${statusRes.json.aoDaemon.status}, ChatGPT: ${statusRes.json.chatgptProxy.status}, Agy: ${statusRes.json.agents.agy.version}`);

    // 3. Projects API
    console.log('[TEST 3] Testing projects API (GET /api/projects)...');
    const projRes = await makeRequest('/api/projects');
    assert.strictEqual(projRes.statusCode, 200);
    assert.ok(Array.isArray(projRes.json.projects), 'Returns projects array');
    const testProj = projRes.json.projects.find(p => p.id === 'workspace-test');
    assert.ok(testProj, 'Found registered project workspace-test');
    console.log(`✓ PASS: Projects API verified. Found ${projRes.json.projects.length} projects.`);

    // 4. Sessions API & Filtering
    console.log('[TEST 4] Testing sessions API with role filtering (GET /api/sessions)...');
    const sessAll = await makeRequest('/api/sessions');
    assert.strictEqual(sessAll.statusCode, 200);
    assert.ok(sessAll.json.sessions.length > 0, 'Has sessions');

    const sessOrch = await makeRequest('/api/sessions?role=orchestrator');
    assert.strictEqual(sessOrch.statusCode, 200);
    assert.ok(sessOrch.json.sessions.every(s => s.role === 'orchestrator'), 'All filtered are orchestrators');

    const sessWorker = await makeRequest('/api/sessions?role=worker');
    assert.strictEqual(sessWorker.statusCode, 200);
    assert.ok(sessWorker.json.sessions.every(s => s.role === 'worker'), 'All filtered are workers');
    console.log(`✓ PASS: Sessions API filtering verified. Total: ${sessAll.json.count}, Orch: ${sessOrch.json.count}, Worker: ${sessWorker.json.count}.`);

    // 5. Orchestrator Plan Extractor
    console.log('[TEST 5] Testing Orchestrator Plan Extractor (GET /api/extract/plan/workspace-test-2)...');
    const planRes = await makeRequest('/api/extract/plan/workspace-test-2');
    assert.strictEqual(planRes.statusCode, 200);
    assert.ok(planRes.json.extractedPlan, 'Has extracted plan');
    assert.ok(planRes.json.workerPromptTemplate, 'Has worker prompt template');
    assert.ok(planRes.json.workerPromptTemplate.includes('greeting'), 'Worker prompt template mentions greeting');
    console.log('✓ PASS: Orchestrator plan extraction verified:');
    console.log('  -> Worker Prompt Sample:\n' + planRes.json.workerPromptTemplate.slice(0, 120) + '...');

    // 6. Worker Artifact Extractor
    console.log('[TEST 6] Testing Worker Worktree Artifact Extractor (GET /api/extract/worktree/workspace-test-3)...');
    const wtRes = await makeRequest('/api/extract/worktree/workspace-test-3');
    assert.strictEqual(wtRes.statusCode, 200);
    assert.ok(wtRes.json.files.length > 0, 'Files found in worktree');
    const hasIndex = wtRes.json.files.some(f => f.name === 'index.js');
    const hasTest = wtRes.json.files.some(f => f.name === 'test.js');
    assert.ok(hasIndex, 'index.js found in worktree');
    assert.ok(hasTest, 'test.js found in worktree');
    console.log(`✓ PASS: Worktree file listing verified. Files count: ${wtRes.json.fileCount}.`);

    // 7. Worker File Content Extractor
    console.log('[TEST 7] Testing specific file content inspection (index.js)...');
    const fileRes = await makeRequest('/api/extract/worktree/workspace-test-3?file=index.js');
    assert.strictEqual(fileRes.statusCode, 200);
    assert.ok(fileRes.json.content.includes('function greet'), 'index.js contains greet function');
    console.log('✓ PASS: File content inspection verified.');

    // 8. Worktree Test Runner Execution
    console.log('[TEST 8] Testing worktree automated test execution (POST /api/extract/worktree/workspace-test-3/test)...');
    const testExec = await makeRequest('/api/extract/worktree/workspace-test-3/test', {
      method: 'POST',
      body: { command: 'node test.js' }
    });
    assert.strictEqual(testExec.statusCode, 200);
    assert.strictEqual(testExec.json.passed, true, 'Test passed');
    assert.strictEqual(testExec.json.exitCode, 0, 'Exit code 0');
    assert.ok(testExec.json.stdout.includes('Test passed: greet'), 'Stdout confirms passed');
    console.log('✓ PASS: In-worktree test execution verified. Output: ' + testExec.json.stdout);

    console.log('\n========================================');
    console.log('🎉 ALL 8 PIPELINE PORTAL TESTS PASSED!');
    console.log('========================================');
  } catch (err) {
    console.error('❌ TEST FAILED:', err);
    process.exitCode = 1;
  } finally {
    if (server) {
      server.close();
      console.log('[TEST] Server closed.');
    }
  }
}

runTests();
