'use strict';

/**
 * Deterministic Fake Codex App-Server Fixture
 * Uses actual stdio JSONL protocol conforming to current stable Codex App Server schema.
 */

const fs = require('fs');
const readline = require('readline');

const args = process.argv.slice(2);
let scenario = 'default';
let durabilityStateFile = null;
let decisionFile = null;
let decisionProjectId = null;
let decisionSubjectId = null;
let decisionWorkspaceState = null;
let decisionType = null;

for (const arg of args) {
  if (arg.startsWith('--scenario=')) {
    scenario = arg.slice('--scenario='.length);
  } else if (arg.startsWith('--durability-state-file=')) {
    durabilityStateFile = arg.slice('--durability-state-file='.length);
  } else if (arg.startsWith('--decision-file=')) {
    decisionFile = arg.slice('--decision-file='.length);
  } else if (arg.startsWith('--decision-project-id=')) {
    decisionProjectId = arg.slice('--decision-project-id='.length);
  } else if (arg.startsWith('--decision-subject-id=')) {
    decisionSubjectId = arg.slice('--decision-subject-id='.length);
  } else if (arg.startsWith('--decision-workspace-state=')) {
    decisionWorkspaceState = arg.slice('--decision-workspace-state='.length);
  } else if (arg.startsWith('--decision-type=')) {
    decisionType = arg.slice('--decision-type='.length);
  }
}

function loadMaterializedThreads() {
  if (!durabilityStateFile) return new Set();
  try {
    if (!fs.existsSync(durabilityStateFile)) return new Set();
    const content = fs.readFileSync(durabilityStateFile, 'utf8');
    const lines = content.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    return new Set(lines);
  } catch (err) {
    logDiag(`Failed to read durability state file: ${err.message}`);
    return new Set();
  }
}

function markThreadMaterialized(threadId) {
  if (!durabilityStateFile || !threadId) return;
  try {
    const set = loadMaterializedThreads();
    if (!set.has(threadId)) {
      fs.appendFileSync(durabilityStateFile, `${threadId}\n`, 'utf8');
      logDiag(`Marked thread '${threadId}' materialized in durability state file`);
    }
  } catch (err) {
    logDiag(`Failed to append to durability state file: ${err.message}`);
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
      if (scenario === 'model_list_pagination') {
        if (!params.cursor) {
          writeLine({
            id,
            result: {
              data: [
                {
                  id: 'mock-model-p1',
                  model: 'mock-model-p1',
                  displayName: 'Mock Model P1',
                  description: 'Page 1 mock model',
                  hidden: false,
                  isDefault: false,
                  defaultReasoningEffort: 'low',
                  supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Low' }]
                }
              ],
              nextCursor: 'page_2_token'
            }
          });
        } else if (params.cursor === 'page_2_token') {
          writeLine({
            id,
            result: {
              data: [
                {
                  id: 'mock-model-p2',
                  model: 'mock-model-p2',
                  displayName: 'Mock Model P2',
                  description: 'Page 2 mock model',
                  hidden: false,
                  isDefault: true,
                  defaultReasoningEffort: 'medium',
                  supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Medium' }]
                }
              ],
              nextCursor: null
            }
          });
        } else {
          writeLine({
            id,
            error: {
              code: -32602,
              message: `Unknown cursor: ${params.cursor}`
            }
          });
        }
        break;
      }

      if (scenario === 'model_list_repeated_cursor') {
        writeLine({
          id,
          result: {
            data: [
              {
                id: 'mock-model-loop',
                model: 'mock-model-loop',
                displayName: 'Mock Model Loop',
                description: 'Loop mock model',
                hidden: false,
                isDefault: true,
                defaultReasoningEffort: 'low',
                supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Low' }]
              }
            ],
            nextCursor: 'same_repeated_cursor'
          }
        });
        break;
      }

      if (scenario === 'model_list_malformed_cursor') {
        writeLine({
          id,
          result: {
            data: [
              {
                id: 'mock-model-bad-cursor',
                model: 'mock-model-bad-cursor',
                displayName: 'Mock Model Bad Cursor',
                description: 'Bad cursor mock model',
                hidden: false,
                isDefault: true,
                defaultReasoningEffort: 'low',
                supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Low' }]
              }
            ],
            nextCursor: '   '
          }
        });
        break;
      }

      const defaultModels = [
        {
          id: 'mock-model-fast',
          model: 'mock-model-fast',
          name: 'Mock Model Fast',
          displayName: 'Mock Model Fast',
          description: 'Fast mock model',
          hidden: false,
          isDefault: false,
          defaultReasoningEffort: 'low',
          supportedReasoningEfforts: [
            { reasoningEffort: 'none', description: 'No reasoning' },
            { reasoningEffort: 'minimal', description: 'Minimal reasoning' },
            { reasoningEffort: 'low', description: 'Low reasoning' },
            { reasoningEffort: 'medium', description: 'Medium reasoning' }
          ]
        },
        {
          id: 'mock-model-standard',
          model: 'mock-model-standard',
          name: 'Mock Model Standard',
          displayName: 'Mock Model Standard',
          description: 'Standard mock model',
          hidden: false,
          isDefault: true,
          defaultReasoningEffort: 'medium',
          supportedReasoningEfforts: [
            { reasoningEffort: 'low', description: 'Low reasoning' },
            { reasoningEffort: 'medium', description: 'Medium reasoning' },
            { reasoningEffort: 'high', description: 'High reasoning' }
          ]
        },
        {
          id: 'mock-model-deep',
          model: 'mock-model-deep',
          name: 'Mock Model Deep',
          displayName: 'Mock Model Deep',
          description: 'Deep mock model',
          hidden: false,
          isDefault: false,
          defaultReasoningEffort: 'high',
          supportedReasoningEfforts: [
            { reasoningEffort: 'medium', description: 'Medium reasoning' },
            { reasoningEffort: 'high', description: 'High reasoning' },
            { reasoningEffort: 'ultra', description: 'Ultra reasoning' }
          ]
        }
      ];

      writeLine({
        id,
        result: {
          data: defaultModels,
          models: defaultModels,
          nextCursor: null
        }
      });
      break;
    }

    case 'thread/start': {
      // Validate sandbox against official SandboxMode enum ('read-only' | 'workspace-write' | 'danger-full-access')
      const VALID_SANDBOX_MODES = new Set(['read-only', 'workspace-write', 'danger-full-access']);
      if (params.sandbox !== undefined && !VALID_SANDBOX_MODES.has(params.sandbox)) {
        writeLine({
          id,
          error: {
            code: -32602,
            message: `Invalid params for thread/start: invalid sandbox mode '${params.sandbox}', expected one of ['read-only', 'workspace-write', 'danger-full-access']`
          }
        });
        return;
      }

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

      if (durabilityStateFile) {
        const materialized = loadMaterializedThreads();
        if (!materialized.has(params.threadId)) {
          logDiag(`thread/resume rejected: thread '${params.threadId}' not yet materialized`);
          writeLine({
            id,
            error: {
              code: -32600,
              message: `Thread ${params.threadId} not found or not yet materialized (zero-turn thread has no rollout)`
            }
          });
          return;
        }
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
      // Provider materialization on first accepted turn/start (lazy rollout emulation)
      if (durabilityStateFile && params.threadId) {
        markThreadMaterialized(params.threadId);
      }

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

      // Early token usage notification before turn/start response (Section 10 race test)
      if (scenario === 'early_token_usage') {
        writeLine({
          method: 'thread/tokenUsage/updated',
          params: {
            threadId: params.threadId || 'thr_fake_001',
            turnId: turnId,
            tokenUsage: {
              total: {
                totalTokens: 12000,
                inputTokens: 10000,
                cachedInputTokens: 5000,
                cacheWriteInputTokens: 0,
                outputTokens: 2000,
                reasoningOutputTokens: 500
              },
              last: {
                totalTokens: 12000,
                inputTokens: 10000,
                cachedInputTokens: 5000,
                cacheWriteInputTokens: 0,
                outputTokens: 2000,
                reasoningOutputTokens: 500
              },
              modelContextWindow: 258400
            }
          }
        });
      }

      // Step 1: Write turn/start response (status: inProgress)
      writeLine({
        id,
        result: {
          turn: {
            id: turnId,
            status: 'inProgress',
            model: params.model,
            effort: params.effort
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

        if (scenario === 'turn_with_token_usage' || scenario === 'repeated_token_usage' || scenario === 'token_usage_thread_mismatch' || scenario === 'malformed_token_usage' || scenario === 'token_usage_missing_mcw') {
          if (scenario === 'token_usage_missing_mcw') {
            writeLine({
              method: 'thread/tokenUsage/updated',
              params: {
                threadId: params.threadId || 'thr_fake_001',
                turnId: turnId,
                tokenUsage: {
                  total: {
                    totalTokens: 15650,
                    inputTokens: 12000,
                    cachedInputTokens: 8000,
                    cacheWriteInputTokens: 0,
                    outputTokens: 3650,
                    reasoningOutputTokens: 1500
                  },
                  last: {
                    totalTokens: 4632,
                    inputTokens: 3200,
                    cachedInputTokens: 2000,
                    cacheWriteInputTokens: 0,
                    outputTokens: 1432,
                    reasoningOutputTokens: 500
                  }
                  // modelContextWindow intentionally omitted
                }
              }
            });
          } else if (scenario === 'malformed_token_usage') {
            writeLine({
              method: 'thread/tokenUsage/updated',
              params: {
                threadId: params.threadId || 'thr_fake_001',
                turnId: turnId,
                tokenUsage: {
                  total: { totalTokens: -50, inputTokens: 'not_a_number' }
                }
              }
            });
          } else if (scenario === 'token_usage_thread_mismatch') {
            writeLine({
              method: 'thread/tokenUsage/updated',
              params: {
                threadId: 'thr_mismatch_other',
                turnId: turnId,
                tokenUsage: {
                  total: {
                    totalTokens: 15650,
                    inputTokens: 12000,
                    cachedInputTokens: 8000,
                    cacheWriteInputTokens: 0,
                    outputTokens: 3650,
                    reasoningOutputTokens: 1500
                  },
                  last: {
                    totalTokens: 4632,
                    inputTokens: 3200,
                    cachedInputTokens: 2000,
                    cacheWriteInputTokens: 0,
                    outputTokens: 1432,
                    reasoningOutputTokens: 500
                  },
                  modelContextWindow: 258400
                }
              }
            });
          } else {
            writeLine({
              method: 'thread/tokenUsage/updated',
              params: {
                threadId: params.threadId || 'thr_fake_001',
                turnId: turnId,
                tokenUsage: {
                  total: {
                    totalTokens: 15650,
                    inputTokens: 12000,
                    cachedInputTokens: 8000,
                    cacheWriteInputTokens: 0,
                    outputTokens: 3650,
                    reasoningOutputTokens: 1500
                  },
                  last: {
                    totalTokens: 4632,
                    inputTokens: 3200,
                    cachedInputTokens: 2000,
                    cacheWriteInputTokens: 0,
                    outputTokens: 1432,
                    reasoningOutputTokens: 500
                  },
                  modelContextWindow: 258400
                }
              }
            });

            if (scenario === 'repeated_token_usage') {
              writeLine({
                method: 'thread/tokenUsage/updated',
                params: {
                  threadId: params.threadId || 'thr_fake_001',
                  turnId: turnId,
                  tokenUsage: {
                    total: {
                      totalTokens: 19800,
                      inputTokens: 14000,
                      cachedInputTokens: 9000,
                      cacheWriteInputTokens: 0,
                      outputTokens: 5800,
                      reasoningOutputTokens: 2000
                    },
                    last: {
                      totalTokens: 4150,
                      inputTokens: 2000,
                      cachedInputTokens: 1000,
                      cacheWriteInputTokens: 0,
                      outputTokens: 2150,
                      reasoningOutputTokens: 500
                    },
                    modelContextWindow: 258400
                  }
                }
              });
            }
          }
        }

        const completedParams = {
          turn: {
            id: targetTurnId,
            status: turnStatus,
            itemsView: 'full',
            items: [],
            error: turnStatus === 'failed' ? { message: 'Synthetic turn execution error' } : undefined
          }
        };

        if (scenario === 'turn_completed_with_thread_id' || scenario === 'audit_decision' || scenario.startsWith('audit_decision_')) {
          completedParams.threadId = params.threadId;
        }

        if (scenario === 'audit_decision') {
          completedParams.threadId = params.threadId || 'thr_fake_001';
          completedParams.turn.itemsView = 'full';
          let decisionPayload;
          if (decisionFile && fs.existsSync(decisionFile)) {
            decisionPayload = JSON.parse(fs.readFileSync(decisionFile, 'utf8'));
          } else {
            const decType = decisionType || 'DISPATCH_WORKER';
            decisionPayload = {
              schema_version: 1,
              decision: decType,
              project_id: decisionProjectId || 'test-project-01',
              audit_subject_id: decisionSubjectId || 'subj-001',
              auditor_thread_id: params.threadId || 'thr_fake_001',
              workspace_state_observed: decisionWorkspaceState || 'ws-state-001',
              summary: 'Fake decision summary for integration testing',
              independent_verification: [
                {
                  kind: 'SOURCE_INSPECTION',
                  result: 'PASS',
                  evidence: 'Inspected fake source'
                }
              ],
              work_order: decType === 'DISPATCH_WORKER' ? {
                work_order_id: 'wo-fake-01',
                directive: 'Execute worker implementation',
                verification: ['Run tests'],
                worker_model_policy: 'worker_standard'
              } : null,
              requested_evidence: [],
              blocker: null
            };
          }
          completedParams.turn.items = [
            {
              type: 'agentMessage',
              id: 'item_agent_decision_001',
              phase: 'final_answer',
              text: JSON.stringify(decisionPayload)
            }
          ];
        } else if (scenario === 'audit_decision_partial_items') {
          completedParams.threadId = params.threadId || 'thr_fake_001';
          completedParams.turn.itemsView = 'summary';
          completedParams.turn.items = [];
        } else if (scenario === 'audit_decision_multiple_finals') {
          completedParams.threadId = params.threadId || 'thr_fake_001';
          completedParams.turn.itemsView = 'full';
          completedParams.turn.items = [
            { type: 'agentMessage', id: 'm1', phase: 'final_answer', text: '{"a":1}' },
            { type: 'agentMessage', id: 'm2', phase: 'final_answer', text: '{"a":2}' }
          ];
        } else if (scenario === 'audit_decision_commentary_only') {
          completedParams.threadId = params.threadId || 'thr_fake_001';
          completedParams.turn.itemsView = 'full';
          completedParams.turn.items = [
            { type: 'agentMessage', id: 'm1', phase: 'commentary', text: '{"decision":"APPROVE_WORK_PACKAGE"}' }
          ];
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
