const http = require('http');
const assert = require('node:assert');
const app = require('../server');

const TEST_PORT = 4199;
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
      timeout: 75000
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
  console.log('===========================================================');
  console.log('🧪 Starting Closed-Loop Orchestration Automated Tests');
  console.log('===========================================================');

  await new Promise((resolve) => {
    server = app.listen(TEST_PORT, () => {
      console.log(`[TEST SERVER] Running on http://127.0.0.1:${TEST_PORT}`);
      resolve();
    });
  });

  try {
    // 1. Model Catalog Verification
    console.log('\n[TEST 1] Verifying Model Catalogs & Defaults (GET /api/models)...');
    const modelsRes = await makeRequest('/api/models');
    assert.strictEqual(modelsRes.statusCode, 200);
    assert.ok(modelsRes.json.chatgpt, 'Has chatgpt config');
    assert.ok(modelsRes.json.antigravity, 'Has antigravity config');

    // ChatGPT default model check: chatgpt-web/high
    assert.strictEqual(
      modelsRes.json.chatgpt.defaultModel,
      'chatgpt-web/high',
      'ChatGPT default model must be chatgpt-web/high (Highest verified)'
    );
    const highGpt = modelsRes.json.chatgpt.models.find(m => m.id === 'chatgpt-web/high');
    assert.ok(highGpt, 'chatgpt-web/high exists in model list');
    assert.strictEqual(highGpt.recommended, true, 'chatgpt-web/high marked recommended');

    // Antigravity default model check: gemini-3.8-flash-high
    assert.strictEqual(
      modelsRes.json.antigravity.defaultModel,
      'gemini-3.8-flash-high',
      'Antigravity default model must be gemini-3.8-flash-high'
    );
    const flashHigh = modelsRes.json.antigravity.models.find(m => m.id === 'gemini-3.8-flash-high');
    assert.ok(flashHigh, 'gemini-3.8-flash-high exists in model list');
    assert.strictEqual(flashHigh.recommended, true, 'gemini-3.8-flash-high marked recommended');

    console.log('✓ PASS: Model catalogs and defaults verified.');
    console.log(`  - ChatGPT default: ${modelsRes.json.chatgpt.defaultModel}`);
    console.log(`  - Antigravity default: ${modelsRes.json.antigravity.defaultModel}`);

    // 2. Model Live Ping Test API (Antigravity ping)
    console.log('\n[TEST 2] Verifying Live Model Ping (POST /api/models/test)...');
    const pingRes = await makeRequest('/api/models/test', {
      method: 'POST',
      body: { provider: 'antigravity', model: 'gemini-3.8-flash-high' }
    });
    assert.strictEqual(pingRes.statusCode, 200);
    assert.strictEqual(pingRes.json.provider, 'antigravity');
    assert.strictEqual(pingRes.json.model, 'gemini-3.8-flash-high');
    assert.strictEqual(pingRes.json.success, true, 'Antigravity ping succeeded');
    assert.ok(pingRes.json.durationMs > 0, 'Measured response latency');
    console.log(`✓ PASS: Antigravity model ping succeeded in ${pingRes.json.durationMs}ms.`);

    // 3. WorkOrder Creation Engine (POST /api/orchestrator/create-workorder)
    console.log('\n[TEST 3] Verifying WorkOrder Generation from Goal...');
    const woRes = await makeRequest('/api/orchestrator/create-workorder', {
      method: 'POST',
      body: {
        goal: 'Build an expression evaluator in calc.js supporting addition and subtraction',
        model: 'chatgpt-web/high'
      }
    });
    assert.strictEqual(woRes.statusCode, 200);
    assert.ok(woRes.json.workOrder, 'Returned workOrder object');
    const wo = woRes.json.workOrder;
    assert.ok(wo.workOrderId, 'WorkOrder has workOrderId');
    assert.ok(wo.title, 'WorkOrder has title');
    assert.ok(wo.objective, 'WorkOrder has objective');
    assert.ok(Array.isArray(wo.acceptanceCriteria), 'acceptanceCriteria is an array');
    assert.ok(wo.testCommand, 'testCommand is present');
    assert.ok(wo.workerPrompt, 'workerPrompt is present');
    console.log('✓ PASS: WorkOrder generated cleanly:');
    console.log(`  - ID: ${wo.workOrderId}`);
    console.log(`  - Title: ${wo.title}`);
    console.log(`  - Criteria: ${wo.acceptanceCriteria.join('; ')}`);
    console.log(`  - Test Command: ${wo.testCommand}`);

    // 4. Audit Gate - Passing Report (verdict: COMPLETE or PASS)
    console.log('\n[TEST 4] Verifying Audit Gate with passing report (POST /api/orchestrator/audit)...');
    const passAuditRes = await makeRequest('/api/orchestrator/audit', {
      method: 'POST',
      body: {
        workOrder: wo,
        workerReport: {
          workOrderId: wo.workOrderId,
          filesModified: ['calc.js', 'test.js'],
          testCommand: 'node test.js',
          testPassed: true,
          testOutput: '✓ Test passed: 2+2=4\n✓ Test passed: 10-3=7\nAll tests passed.',
          gitDiff: 'diff --git a/calc.js b/calc.js\n+function calc(exp){...}'
        },
        model: 'chatgpt-web/high'
      }
    });
    assert.strictEqual(passAuditRes.statusCode, 200);
    assert.ok(passAuditRes.json.auditResult, 'Has auditResult');
    const passAudit = passAuditRes.json.auditResult;
    assert.ok(['PASS', 'COMPLETE'].includes(passAudit.verdict), `Verdict should be PASS or COMPLETE, got ${passAudit.verdict}`);
    console.log(`✓ PASS: Audit Gate issued positive verdict: ${passAudit.verdict} (${passAudit.summary})`);

    // 5. Audit Gate - Failing Report (verdict: FIX)
    console.log('\n[TEST 5] Verifying Audit Gate with failing report (POST /api/orchestrator/audit)...');
    const failAuditRes = await makeRequest('/api/orchestrator/audit', {
      method: 'POST',
      body: {
        workOrder: wo,
        workerReport: {
          workOrderId: wo.workOrderId,
          filesModified: ['calc.js'],
          testCommand: 'node test.js',
          testPassed: false,
          testOutput: 'TypeError: calc is not a function at test.js:4:1\nAssertionError: expected 4 got undefined',
          gitDiff: ''
        },
        model: 'chatgpt-web/high'
      }
    });
    assert.strictEqual(failAuditRes.statusCode, 200);
    assert.ok(failAuditRes.json.auditResult, 'Has auditResult');
    const failAudit = failAuditRes.json.auditResult;
    assert.strictEqual(failAudit.verdict, 'FIX', `Failing test must trigger FIX verdict, got ${failAudit.verdict}`);
    assert.ok(failAudit.fixInstructions, 'FIX verdict must provide fixInstructions');
    console.log(`✓ PASS: Audit Gate correctly flagged failure with FIX verdict:`);
    console.log(`  - Summary: ${failAudit.summary}`);
    console.log(`  - Fix Instructions: ${failAudit.fixInstructions}`);

    // 6. Antigravity Sessions Discovery (GET /api/projects/:id/antigravity-sessions)
    console.log('\n[TEST 6] Verifying Antigravity Sessions Discovery...');
    const agySessRes = await makeRequest('/api/projects/calc-engine/antigravity-sessions');
    assert.strictEqual(agySessRes.statusCode, 200);
    assert.strictEqual(agySessRes.json.projectId, 'calc-engine');
    assert.ok(Array.isArray(agySessRes.json.sessions), 'sessions is an array');
    assert.ok(agySessRes.json.sessions.length > 0, 'Found active/historical Antigravity sessions');
    const firstSess = agySessRes.json.sessions[0];
    assert.ok(firstSess.id, 'Session has id');
    assert.ok(firstSess.source, 'Session has source');
    console.log(`✓ PASS: Discovered ${agySessRes.json.sessions.length} Antigravity sessions (e.g. ${firstSess.title})`);

    // 7. Technical Context Discovery (GET /api/projects/:id/technical-context)
    console.log('\n[TEST 7] Verifying Technical Context Discovery (ROADMAP.md, HANDOFF.md, etc.)...');
    const techRes = await makeRequest('/api/projects/calc-engine/technical-context');
    assert.strictEqual(techRes.statusCode, 200);
    assert.strictEqual(techRes.json.projectId, 'calc-engine');
    assert.ok(Array.isArray(techRes.json.files), 'files is an array');
    assert.ok(techRes.json.files.length > 0, 'Discovered technical files in calc-engine');
    const roadmapFile = techRes.json.files.find(f => f.name === 'ROADMAP.md');
    assert.ok(roadmapFile, 'ROADMAP.md discovered in calc-engine');
    console.log(`✓ PASS: Discovered ${techRes.json.files.length} technical files. Found: ${techRes.json.files.map(f => f.name).join(', ')}`);

    // 8. Observer & Orchestrator Audit & Direct Engine (POST /api/orchestrator/audit-and-direct)
    console.log('\n[TEST 8] Verifying Observer ChatGPT Web Audit & Directive Generation...');
    const auditDirectRes = await makeRequest('/api/orchestrator/audit-and-direct', {
      method: 'POST',
      body: {
        projectId: 'calc-engine',
        antigravitySessionId: firstSess.id,
        antigravityReport: {
          summary: 'Completed Phase 1 basic operators (+, -, *, /). All 12 unit tests pass.',
          filesModified: ['src/calculator.js', 'test/calculator.test.js'],
          testPassed: true,
          testOutput: 'PASS test/calculator.test.js (12 tests passed)',
          notes: 'Ready for Phase 2: Power and Modulo operators.'
        },
        model: 'chatgpt-web/high'
      }
    });
    assert.strictEqual(auditDirectRes.statusCode, 200);
    assert.ok(auditDirectRes.json.item, 'Has exchange item');
    const exchangeItem = auditDirectRes.json.item;
    assert.ok(exchangeItem.chatgptAudit, 'Has chatgptAudit block');
    assert.ok(exchangeItem.chatgptAudit.verdict, 'Has verdict');
    assert.ok(exchangeItem.chatgptAudit.auditSummary, 'Has audit summary');
    assert.ok(exchangeItem.chatgptAudit.nextDirectivePrompt, 'Has next directive prompt for Antigravity');
    console.log(`✓ PASS: ChatGPT Web issued directive without code implementation:`);
    console.log(`  - Verdict: ${exchangeItem.chatgptAudit.verdict}`);
    console.log(`  - Audit: ${exchangeItem.chatgptAudit.auditSummary}`);
    console.log(`  - Directive Prompt: ${exchangeItem.chatgptAudit.nextDirectivePrompt.slice(0, 100)}...`);

    // 9. Exchange Stream History & Dispatch
    console.log('\n[TEST 9] Verifying Exchange Stream & Dispatch to Antigravity...');
    const streamRes = await makeRequest('/api/orchestrator/exchange-stream/calc-engine');
    assert.strictEqual(streamRes.statusCode, 200);
    assert.ok(Array.isArray(streamRes.json.history), 'history is an array');
    assert.ok(streamRes.json.history.length > 0, 'Stream history contains recent turn');

    const dispatchRes = await makeRequest('/api/antigravity/dispatch', {
      method: 'POST',
      body: {
        sessionId: firstSess.id,
        prompt: exchangeItem.chatgptAudit.nextDirectivePrompt
      }
    });
    assert.strictEqual(dispatchRes.statusCode, 200);
    assert.strictEqual(dispatchRes.json.dispatched, true, 'Dispatch acknowledged');
    console.log(`✓ PASS: Exchange stream verified and prompt successfully dispatched to Antigravity session.`);

    console.log('\n===========================================================');
    console.log('🎉 ALL ORCHESTRATOR & OBSERVER PIPELINE TESTS PASSED 100%!');
    console.log('===========================================================');
  } finally {
    if (server) server.close();
  }
}

if (require.main === module) {
  runTests().catch(err => {
    console.error('❌ Test suite failed:', err);
    if (server) server.close();
    process.exit(1);
  });
}

module.exports = { runTests };
