'use strict';

/**
 * Deterministic Fake Codex App-Server Fixture
 * Uses actual stdio JSONL protocol conforming to current stable Codex App Server schema.
 */

const readline = require('readline');

const args = process.argv.slice(2);
let scenario = 'default';

for (const arg of args) {
  if (arg.startsWith('--scenario=')) {
    scenario = arg.slice('--scenario='.length);
  }
}

function writeLine(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function writeRaw(raw) {
  process.stdout.write(raw + '\n');
}

function logDiag(msg) {
  process.stderr.write(`[fake-codex-app-server] ${msg}\n`);
}

logDiag(`Starting fake Codex app-server with scenario='${scenario}'`);

// Immediate exit scenario
if (scenario === 'exit_pre_init') {
  logDiag('Exiting immediately pre-init (scenario=exit_pre_init)');
  process.exit(42);
}

// Immediate malformed line scenario
if (scenario === 'malformed_json') {
  logDiag('Writing malformed line immediately');
  writeRaw('NOT_VALID_JSON_LINE{{{');
  process.exit(1);
}

// Immediate oversized line scenario
if (scenario === 'oversized_line') {
  logDiag('Writing oversized line (10 MiB)');
  const huge = 'A'.repeat(10 * 1024 * 1024);
  writeRaw(huge);
  process.exit(0);
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

let isInitialized = false;

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch (err) {
    logDiag(`Failed to parse incoming line: ${err.message}`);
    return;
  }

  // Handle client response to server-initiated request
  if (msg.id !== undefined && msg.method === undefined && typeof msg.id === 'string' && msg.id.startsWith('srv_req_')) {
    logDiag(`Received response from client for id=${msg.id}, result=${JSON.stringify(msg.result)}, error=${JSON.stringify(msg.error)}`);
    return;
  }

  // Handle client notifications
  if (msg.method !== undefined && msg.id === undefined) {
    if (msg.method === 'initialized') {
      isInitialized = true;
      logDiag('Client sent initialized notification; handshake complete');

      if (scenario === 'server_request') {
        setTimeout(() => {
          writeLine({
            id: 'srv_req_001',
            method: 'item/commandExecution/requestApproval',
            params: {
              threadId: 'thr_fake_001',
              command: 'run diagnostic check'
            }
          });
        }, 20);
      } else if (scenario === 'server_request_with_ids') {
        setTimeout(() => {
          writeLine({
            id: 'srv_req_002',
            method: 'item/fileChange/requestApproval',
            params: {
              threadId: 'thr_fake_001',
              turnId: 'turn_fake_001',
              itemId: 'item_fake_001',
              reason: 'testing approval fail-closed'
            }
          });
        }, 20);
      }
    }
    return;
  }

  // Handle client requests
  const { id, method, params = {} } = msg;
  logDiag(`Received request id=${id}, method=${method}`);

  // Scenario-driven triggers (applied post-initialization)
  if (isInitialized) {
    if (scenario === 'exit_mid_request') {
      logDiag('Triggered exit mid-request');
      process.exit(1);
    }

    if (scenario === 'provider_error') {
      writeLine({
        id,
        error: {
          code: -32603,
          message: 'Synthetic provider failure'
        }
      });
      return;
    }

    if (scenario === 'both_result_and_error') {
      writeLine({
        id,
        result: { ok: true },
        error: {
          code: -32603,
          message: 'Synthetic ambiguous response with both result and error'
        }
      });
      return;
    }

    if (scenario === 'neither_result_nor_error') {
      writeLine({ id });
      return;
    }

    if (scenario === 'timeout') {
      logDiag(`Ignoring request ${id} (scenario=timeout)`);
      return;
    }

    if (scenario === 'unknown_response_id') {
      writeLine({
        id: 'cas_req_unknown_999',
        result: { status: 'unexpected' }
      });
      return;
    }

    if (scenario === 'duplicate_response') {
      writeLine({ id, result: { first: true } });
      writeLine({ id, result: { second: true } });
      return;
    }
  }

  // Handle method dispatch
  switch (method) {
    case 'initialize': {
      if (scenario === 'init_duplicate_response') {
        writeLine({
          id,
          result: { serverInfo: { name: 'fake-codex', version: '0.154.0' } }
        });
        writeLine({
          id,
          result: { serverInfo: { name: 'fake-codex', version: '0.154.0' } }
        });
        return;
      }

      if (scenario === 'init_unknown_response_id') {
        writeLine({
          id: 'cas_req_unknown_999',
          result: { serverInfo: { name: 'fake-codex', version: '0.154.0' } }
        });
        return;
      }

      writeLine({
        id,
        result: {
          serverInfo: {
            name: 'fake-codex-app-server',
            version: '0.154.0'
          }
        }
      });
      break;
    }

    case 'model/list': {
      writeLine({
        id,
        result: {
          models: [
            { id: 'mock-model-fast', name: 'Mock Model Fast' },
            { id: 'mock-model-standard', name: 'Mock Model Standard' },
            { id: 'mock-model-deep', name: 'Mock Model Deep' }
          ]
        }
      });
      break;
    }

    case 'thread/start': {
      let threadId = 'thr_fake_001';
      let sessionId = 'ses_fake_001';

      if (scenario === 'custom_opaque_ids') {
        threadId = 'thr_exact_opaque_id_98765';
        sessionId = 'ses_exact_opaque_id_54321';
      } else if (params.cwd === 'D:\\test\\a' || params.cwd === '/mock/a') {
        threadId = 'thr_order_1';
        sessionId = 'ses_order_1';
      } else if (params.cwd === 'D:\\test\\b' || params.cwd === '/mock/b') {
        threadId = 'thr_order_2';
        sessionId = 'ses_order_2';
      }

      writeLine({
        id,
        result: {
          thread: {
            id: threadId,
            sessionId,
            cwd: params.cwd,
            approvalPolicy: params.approvalPolicy,
            sandbox: params.sandbox
          }
        }
      });
      break;
    }

    case 'thread/resume': {
      if (params.threadId === 'thr_bad' || params.threadId === 'thr_not_found') {
        writeLine({
          id,
          error: {
            code: -32603,
            message: 'Thread not found'
          }
        });
        return;
      }

      if (scenario === 'resume_thread_mismatch' || params.threadId === 'thr_resume_mismatch') {
        writeLine({
          id,
          result: {
            thread: {
              id: 'thr_wrong_mismatch_999',
              resumed: true
            }
          }
        });
        return;
      }

      const threadId = params.threadId || 'thr_resumed';
      writeLine({
        id,
        result: {
          thread: {
            id: threadId,
            resumed: true
          }
        }
      });
      break;
    }

    case 'thread/read': {
      if (scenario === 'read_thread_mismatch' || params.threadId === 'thr_read_mismatch') {
        writeLine({
          id,
          result: {
            thread: {
              id: 'thr_wrong_mismatch_999',
              cwd: '/mock/workspace'
            }
          }
        });
        return;
      }

      const threadId = params.threadId || 'thr_read';
      writeLine({
        id,
        result: {
          thread: {
            id: threadId,
            cwd: '/mock/workspace',
            turns: params.includeTurns ? [{ id: 'turn_0', status: 'completed' }] : undefined
          }
        }
      });
      break;
    }

    case 'turn/start': {
      let turnId = 'turn_fake_001';
      let targetTurnId = 'turn_fake_001';
      let turnStatus = 'completed';

      if (params.threadId === 'thr_fail_test') {
        turnId = 'turn_fail_001';
        targetTurnId = 'turn_fail_001';
        turnStatus = 'failed';
      } else if (params.threadId === 'thr_interrupted_test') {
        turnId = 'turn_int_001';
        targetTurnId = 'turn_int_001';
        turnStatus = 'interrupted';
      } else if (params.threadId === 'thr_mismatch_test') {
        turnId = 'turn_fake_001';
        targetTurnId = 'turn_mismatch_999';
        turnStatus = 'completed';
      }

      // Step 1: Write turn/start response (status: inProgress)
      writeLine({
        id,
        result: {
          turn: {
            id: turnId,
            status: 'inProgress'
          }
        }
      });

      // Step 2: Stream notifications
      const emitNotifications = () => {
        writeLine({
          method: 'turn/started',
          params: {
            turn: { id: turnId, status: 'inProgress' }
          }
        });

        writeLine({
          method: 'item/started',
          params: {
            item: { id: 'item_fake_001', type: 'message' }
          }
        });

        writeLine({
          method: 'item/completed',
          params: {
            item: { id: 'item_fake_001', type: 'message', text: 'Processing turn...' }
          }
        });

        const completedParams = {
          turn: {
            id: targetTurnId,
            status: turnStatus,
            error: turnStatus === 'failed' ? { message: 'Synthetic turn execution error' } : undefined
          }
        };

        if (scenario === 'turn_completed_with_thread_id') {
          completedParams.threadId = params.threadId;
        }

        writeLine({
          method: 'turn/completed',
          params: completedParams
        });
      };

      if (scenario === 'early_completion') {
        // Emit immediately synchronously to eliminate race and prove waiter cache
        emitNotifications();
      } else {
        setTimeout(emitNotifications, 15);
      }
      break;
    }

    case 'turn/interrupt': {
      writeLine({
        id,
        result: { interrupted: true }
      });

      setTimeout(() => {
        writeLine({
          method: 'turn/completed',
          params: {
            turn: {
              id: params.turnId,
              status: 'interrupted'
            }
          }
        });
      }, 15);
      break;
    }

    case 'review/start': {
      const reviewTurnId = 'turn_rev_001';
      const reviewThreadId = (scenario === 'wrong_review_thread' || params.threadId === 'thr_wrong_review_test')
        ? 'thr_wrong_mismatch'
        : params.threadId;

      writeLine({
        id,
        result: {
          turn: {
            id: reviewTurnId,
            status: 'inProgress'
          },
          reviewThreadId
        }
      });

      // Stream review notifications
      const emitReviewNotifications = () => {
        const evidenceItemId = (scenario === 'unrelated_review_evidence')
          ? 'item_unrelated_999'
          : reviewTurnId;

        writeLine({
          method: 'item/completed',
          params: {
            item: {
              id: evidenceItemId,
              type: 'exitedReviewMode',
              review: 'Review analysis completed successfully: clean codebase'
            }
          }
        });

        writeLine({
          method: 'turn/completed',
          params: {
            turn: {
              id: reviewTurnId,
              status: 'completed'
            }
          }
        });
      };

      if (scenario === 'early_review_evidence') {
        // Emit immediately to prove evidence cache handles arrival before waiter
        emitReviewNotifications();
      } else {
        setTimeout(emitReviewNotifications, 15);
      }
      break;
    }

    default: {
      writeLine({
        id,
        error: {
          code: -32601,
          message: `Method '${method}' not implemented in fake server`
        }
      });
      break;
    }
  }
});

process.on('SIGTERM', () => {
  logDiag('Received SIGTERM; exiting 0');
  process.exit(0);
});
