'use strict';

/**
 * Deterministic Fake Codex App-Server Fixture
 * Uses actual stdio JSONL protocol.
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
  if (msg.id !== undefined && msg.method === undefined) {
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
            method: 'item/command/requestApproval',
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

  // Dynamic request triggers
  if (params._trigger === 'exit') {
    logDiag('Triggered exit mid-request');
    process.exit(1);
  }

  if (params._trigger === 'malformed') {
    writeRaw('GARBAGE_JSON_OUTPUT_LINE_<<<');
    return;
  }

  if (params._trigger === 'unknown_id') {
    writeLine({ id: 'cas_req_999999', result: { unexpected: true } });
    return;
  }

  if (params._trigger === 'duplicate') {
    writeLine({ id, result: { first: true } });
    writeLine({ id, result: { second: true } });
    return;
  }

  if (params._trigger === 'provider_error' || scenario === 'provider_error') {
    writeLine({
      id,
      error: {
        code: -32603,
        message: params._errorMessage || 'Synthetic provider failure'
      }
    });
    return;
  }

  if (scenario === 'timeout' || params._trigger === 'timeout') {
    logDiag(`Ignoring request ${id} (scenario=timeout)`);
    return;
  }

  // Handle method dispatch
  switch (method) {
    case 'initialize': {
      if (scenario === 'duplicate_response') {
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

      if (scenario === 'unknown_response_id') {
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
      const threadId = params._threadId || 'thr_fake_001';
      const sessionId = params._sessionId || 'ses_fake_001';
      writeLine({
        id,
        result: {
          thread: {
            id: threadId,
            sessionId,
            cwd: params.cwd,
            readOnly: params.readOnly
          }
        }
      });
      break;
    }

    case 'thread/resume': {
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
      const turnId = params._turnId || 'turn_fake_001';
      writeLine({
        id,
        result: {
          turn: {
            id: turnId,
            status: 'in_progress'
          }
        }
      });

      // Stream notifications
      setTimeout(() => {
        writeLine({
          method: 'turn/started',
          params: {
            threadId: params.threadId,
            turn: { id: turnId, status: 'in_progress' }
          }
        });

        writeLine({
          method: 'item/started',
          params: {
            threadId: params.threadId,
            item: { id: 'item_fake_001', type: 'message' }
          }
        });

        writeLine({
          method: 'item/completed',
          params: {
            threadId: params.threadId,
            item: { id: 'item_fake_001', type: 'message', text: 'Processing turn...' }
          }
        });

        const targetTurnId = params._wrongTurnId ? 'turn_mismatch_999' : turnId;
        const turnStatus = params._failTurn ? 'failed' : (params._interruptTurn ? 'interrupted' : 'completed');

        writeLine({
          method: 'turn/completed',
          params: {
            threadId: params.threadId,
            turn: {
              id: targetTurnId,
              status: turnStatus,
              error: turnStatus === 'failed' ? { message: 'Synthetic turn execution error' } : undefined
            }
          }
        });
      }, 10);
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
            threadId: params.threadId,
            turn: {
              id: params.turnId,
              status: 'interrupted'
            }
          }
        });
      }, 10);
      break;
    }

    case 'review/start': {
      const reviewTurnId = params._reviewTurnId || 'turn_rev_001';
      const reviewThreadId = params._wrongReviewThread || (scenario === 'wrong_review_thread')
        ? 'thr_wrong_mismatch'
        : params.threadId;

      writeLine({
        id,
        result: {
          turn: {
            id: reviewTurnId,
            status: 'in_progress'
          },
          reviewThreadId
        }
      });

      // Stream review notifications
      setTimeout(() => {
        writeLine({
          method: 'item/completed',
          params: {
            threadId: reviewThreadId,
            item: {
              id: 'item_rev_001',
              type: 'exitedReviewMode',
              text: 'Review analysis completed successfully: clean codebase'
            }
          }
        });

        writeLine({
          method: 'turn/completed',
          params: {
            threadId: reviewThreadId,
            turn: {
              id: reviewTurnId,
              status: 'completed'
            }
          }
        });
      }, 10);
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
