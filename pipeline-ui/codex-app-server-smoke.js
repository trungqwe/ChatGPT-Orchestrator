'use strict';

/**
 * Codex App Server Smoke Tool
 * Operator opt-in only via --live flag.
 */

const { CodexAuditorAdapter } = require('./lib/auditor/codex-auditor-adapter');

async function runSmoke() {
  const args = process.argv.slice(2);
  const isLive = args.includes('--live');

  if (!isLive) {
    const result = {
      ok: false,
      reason: 'REAL_APP_SERVER_SMOKE: NOT_RUN_OPERATOR_OPT_IN_REQUIRED',
      message: 'Explicit operator opt-in flag --live is required to run live Codex App Server smoke test.'
    };
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    process.exit(0);
  }

  let adapter = null;
  try {
    adapter = new CodexAuditorAdapter({
      codexBinary: 'codex',
      args: ['app-server', '--listen', 'stdio://'],
      timeouts: {
        initialize: 10000,
        default: 10000
      }
    });

    // Step 1: initialize handshake
    await adapter.initialize();

    // Step 2: list models
    const models = await adapter.listModels();

    const output = {
      ok: true,
      transport: 'stdio-jsonl',
      initialized: true,
      model_list: 'PASS',
      model_count: Array.isArray(models) ? models.length : 0,
      thread_created: false,
      turn_started: false
    };

    process.stdout.write(JSON.stringify(output, null, 2) + '\n');
  } catch (err) {
    const failureOutput = {
      ok: false,
      transport: 'stdio-jsonl',
      error: err.message,
      code: err.code || 'SMOKE_ERROR',
      thread_created: false,
      turn_started: false
    };
    process.stdout.write(JSON.stringify(failureOutput, null, 2) + '\n');
    process.exit(1);
  } finally {
    if (adapter) {
      try {
        await adapter.close();
      } catch {
        // ignore close error
      }
    }
  }
}

if (require.main === module) {
  runSmoke();
}

module.exports = { runSmoke };
