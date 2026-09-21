'use strict';

/**
 * Auditor Recover CLI Semantic Test Suite (ARC-001 .. ARC-058)
 *
 * Deterministic test matrix covering:
 * - Strict parser (unknown commands, unknown flags, bounds, forbidden flags, confirm)
 * - Output projections (no raw lifecycle spreads, no forbidden keys at any depth)
 * - Error mapping (exits 0, 2, 5, 6, 8, 9, 10, 11, 12; reserved exits 3, 4, 7)
 * - Adapter factory signature & canonical cwd authority
 * - Runtime initialization phase authority (exit 11)
 * - Operational structured unmapped error fallback (exit 12)
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  runCli,
  parseCliArgs,
  truncateUtf8,
  createAuditorAdapterFactory,
  createAuditorRecoveryCliRuntime
} = require('../../auditor-recover-cli');

const {
  AUDITOR_BOOTSTRAP_STATES,
  LIFECYCLE_ERROR_CODES,
  AuditorLifecycleError
} = require('../../lib/relay/auditor-thread-lifecycle');

const { createSqliteAuditorRecoveryStore } = require('../../lib/relay/sqlite-auditor-recovery-store');

// Temporary directory for isolated tests
const testTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auditor-recover-cli-test-'));

function cleanupTempDir() {
  try {
    fs.rmSync(testTempDir, { recursive: true, force: true });
  } catch {}
}

let testCounter = 0;
function getTempDbPath(name) {
  const file = path.join(testTempDir, `${name}-${Date.now()}-${testCounter++}.sqlite3`);
  return file;
}

/**
 * Recursive assertion that forbidden keys are NEVER present anywhere in response
 */
function assertNoForbiddenKeys(obj, pathContext = 'response') {
  if (obj === null || typeof obj !== 'object') return;

  for (const [key, value] of Object.entries(obj)) {
    const currentPath = `${pathContext}.${key}`;
    assert.notStrictEqual(key, 'decision_json', `Forbidden key 'decision_json' found at ${currentPath}`);
    assert.notStrictEqual(key, 'validated_decision', `Forbidden key 'validated_decision' found at ${currentPath}`);
    assert.notStrictEqual(key, 'decision', `Forbidden key 'decision' found at ${currentPath}`);
    assert.notStrictEqual(key, 'registry_project', `Forbidden key 'registry_project' found at ${currentPath}`);

    if (key === 'worker' && value && typeof value === 'object') {
      assert.strictEqual('session_id' in value, false, `Forbidden key 'worker.session_id' found at ${currentPath}`);
    }

    assertNoForbiddenKeys(value, currentPath);
  }
}

/**
 * Creates a mock runtime with stub ports
 */
function createMockRuntime(overrides = {}) {
  let closed = false;
  return {
    registryPort: overrides.registryPort || {
      getProject: async () => null,
      bindAuditorThread: async () => {}
    },
    recoveryStore: overrides.recoveryStore || {
      getActiveBootstrap: () => null,
      getBootstrapHistory: () => [],
      close: () => { closed = true; }
    },
    adapterFactory: overrides.adapterFactory || (async () => ({})),
    close: async () => {
      closed = true;
      if (overrides.recoveryStore && typeof overrides.recoveryStore.close === 'function') {
        overrides.recoveryStore.close();
      }
    },
    isClosed: () => closed
  };
}

async function runAllTests() {
  console.log('Starting Auditor Recover CLI test suite (ARC-001 .. ARC-058)...\n');

  // ARC-001: inspect — no active bootstrap
  {
    const res = await runCli(['inspect', '--project-id', 'proj-001'], {
      runtime: createMockRuntime(),
      lifecycle: {
        inspectAuditorBootstrap: async ({ projectId }) => ({
          project_id: projectId,
          active_bootstrap: null,
          history: [],
          registry_binding_state: 'AUDITOR_BOUND_READY',
          registry_project: { id: 'proj-001', secret: 'hidden' }
        })
      }
    });

    assert.strictEqual(res.exitCode, 0);
    assert.strictEqual(res.response.ok, true);
    assert.strictEqual(res.response.operation, 'inspect');
    assert.strictEqual(res.response.project_id, 'proj-001');
    assert.strictEqual(res.response.active_bootstrap, null);
    assert.deepStrictEqual(res.response.history, []);
    assert.strictEqual(res.response.registry_binding_state, 'AUDITOR_BOUND_READY');
    assertNoForbiddenKeys(res.response);
    console.log('PASS: ARC-001 — inspect with no active bootstrap');
  }

  // ARC-002: inspect — PROVISIONAL_THREAD
  {
    const res = await runCli(['inspect', '--project-id', 'proj-002'], {
      runtime: createMockRuntime(),
      lifecycle: {
        inspectAuditorBootstrap: async ({ projectId }) => ({
          project_id: projectId,
          active_bootstrap: {
            project_id: projectId,
            operation_id: 'op-002',
            audit_subject_id: 'subj-002',
            thread_id: 'th-002',
            turn_id: null,
            workspace_state_observed: 'clean',
            state: AUDITOR_BOOTSTRAP_STATES.PROVISIONAL_THREAD,
            decision_json: null,
            decision_sha256: null,
            authority_version: 1,
            expected_project_root: '/repo/root',
            expected_auditor_model_policy: 'standard',
            created_at: '2026-09-21T00:00:00.000Z',
            updated_at: '2026-09-21T00:00:00.000Z'
          },
          history: [{
            history_seq: 1,
            operation_id: 'op-002',
            previous_state: null,
            next_state: 'PROVISIONAL_THREAD',
            iso: '2026-09-21T00:00:00.000Z'
          }],
          registry_binding_state: 'AUDITOR_REGISTRATION_REQUIRED',
          registry_project: { id: 'proj-002' }
        })
      }
    });

    assert.strictEqual(res.exitCode, 0);
    assert.strictEqual(res.response.active_bootstrap.state, 'PROVISIONAL_THREAD');
    assert.strictEqual(res.response.active_bootstrap.has_decision, false);
    assert.strictEqual(res.response.history.length, 1);
    assertNoForbiddenKeys(res.response);
    console.log('PASS: ARC-002 — inspect with PROVISIONAL_THREAD active bootstrap');
  }

  // ARC-003: inspect — AUDIT_UNCERTAIN
  {
    const res = await runCli(['inspect', '--project-id', 'proj-003'], {
      runtime: createMockRuntime(),
      lifecycle: {
        inspectAuditorBootstrap: async ({ projectId }) => ({
          project_id: projectId,
          active_bootstrap: {
            project_id: projectId,
            operation_id: 'op-003',
            audit_subject_id: 'subj-003',
            thread_id: 'th-003',
            turn_id: 'turn-003',
            workspace_state_observed: 'clean',
            state: AUDITOR_BOOTSTRAP_STATES.AUDIT_UNCERTAIN,
            decision_json: null,
            decision_sha256: null,
            authority_version: 1,
            expected_project_root: '/repo/root',
            expected_auditor_model_policy: 'standard',
            created_at: '2026-09-21T00:00:00.000Z',
            updated_at: '2026-09-21T00:00:00.000Z'
          },
          history: [],
          registry_binding_state: 'AUDITOR_REGISTRATION_REQUIRED',
          registry_project: { id: 'proj-003' }
        })
      }
    });

    assert.strictEqual(res.exitCode, 0);
    assert.strictEqual(res.response.active_bootstrap.state, 'AUDIT_UNCERTAIN');
    assertNoForbiddenKeys(res.response);
    console.log('PASS: ARC-003 — inspect with AUDIT_UNCERTAIN active bootstrap');
  }

  // ARC-004: inspect — DECISION_VALIDATED, has_decision: true
  {
    const res = await runCli(['inspect', '--project-id', 'proj-004'], {
      runtime: createMockRuntime(),
      lifecycle: {
        inspectAuditorBootstrap: async ({ projectId }) => ({
          project_id: projectId,
          active_bootstrap: {
            project_id: projectId,
            operation_id: 'op-004',
            audit_subject_id: 'subj-004',
            thread_id: 'th-004',
            turn_id: 'turn-004',
            workspace_state_observed: 'clean',
            state: AUDITOR_BOOTSTRAP_STATES.DECISION_VALIDATED,
            decision_json: '{"verdict":"PASS"}',
            decision_sha256: 'dec-sha-444',
            authority_version: 1,
            expected_project_root: '/repo/root',
            expected_auditor_model_policy: 'standard',
            created_at: '2026-09-21T00:00:00.000Z',
            updated_at: '2026-09-21T00:00:00.000Z'
          },
          history: [],
          registry_binding_state: 'AUDITOR_REGISTRATION_REQUIRED',
          registry_project: { id: 'proj-004' }
        })
      }
    });

    assert.strictEqual(res.exitCode, 0);
    assert.strictEqual(res.response.active_bootstrap.has_decision, true);
    assert.strictEqual(res.response.active_bootstrap.decision_sha256, 'dec-sha-444');
    assert.strictEqual('decision_json' in res.response.active_bootstrap, false);
    assertNoForbiddenKeys(res.response);
    console.log('PASS: ARC-004 — inspect with DECISION_VALIDATED has_decision: true');
  }

  // ARC-005: inspect — decision_json absent at every depth of JSON output
  {
    const res = await runCli(['inspect', '--project-id', 'proj-005'], {
      runtime: createMockRuntime(),
      lifecycle: {
        inspectAuditorBootstrap: async ({ projectId }) => ({
          project_id: projectId,
          active_bootstrap: {
            project_id: projectId,
            operation_id: 'op-005',
            decision_json: '{"super_secret":"do_not_expose"}',
            validated_decision: { payload: 'secret' },
            state: 'DECISION_VALIDATED'
          },
          registry_project: { raw_leak: 'forbidden' },
          history: [{ history_seq: 1, decision_json: '{"leak":true}' }]
        })
      }
    });

    assert.strictEqual(res.exitCode, 0);
    assertNoForbiddenKeys(res.response);
    console.log('PASS: ARC-005 — decision_json absent at every depth of JSON output');
  }

  // ARC-006: inspect — Registry read failure mapped to PROJECT_NOT_FOUND
  {
    const res = await runCli(['inspect', '--project-id', 'proj-006'], {
      runtime: createMockRuntime(),
      lifecycle: {
        inspectAuditorBootstrap: async ({ projectId }) => ({
          project_id: projectId,
          active_bootstrap: null,
          history: [],
          registry_binding_state: 'PROJECT_NOT_FOUND',
          registry_project: null
        })
      }
    });

    assert.strictEqual(res.exitCode, 0);
    assert.strictEqual(res.response.registry_binding_state, 'PROJECT_NOT_FOUND');
    assertNoForbiddenKeys(res.response);
    console.log('PASS: ARC-006 — inspect Registry read failure mapped to PROJECT_NOT_FOUND');
  }

  // ARC-007: inspect — unknown flag
  {
    const res = await runCli(['inspect', '--project-id', 'proj-007', '--extra-flag', 'val']);
    assert.strictEqual(res.exitCode, 2);
    assert.strictEqual(res.response.code, 'INVALID_CLI_REQUEST');
    console.log('PASS: ARC-007 — inspect rejects unknown flag with exit 2');
  }

  // ARC-008: inspect — missing --project-id
  {
    const res = await runCli(['inspect']);
    assert.strictEqual(res.exitCode, 2);
    assert.strictEqual(res.response.code, 'INVALID_CLI_REQUEST');
    console.log('PASS: ARC-008 — inspect rejects missing --project-id with exit 2');
  }

  // ARC-009: inspect — --project-id uppercase letters (invalid format)
  {
    const res = await runCli(['inspect', '--project-id', 'INVALID_UPPERCASE']);
    assert.strictEqual(res.exitCode, 2);
    assert.strictEqual(res.response.code, 'INVALID_CLI_REQUEST');
    console.log('PASS: ARC-009 — inspect rejects uppercase --project-id with exit 2');
  }

  // ARC-010: inspect — duplicate --project-id
  {
    const res = await runCli(['inspect', '--project-id', 'proj-a', '--project-id', 'proj-b']);
    assert.strictEqual(res.exitCode, 2);
    assert.strictEqual(res.response.code, 'INVALID_CLI_REQUEST');
    console.log('PASS: ARC-010 — inspect rejects duplicate --project-id with exit 2');
  }

  // ARC-011: inspect — forbidden flag --thread-id
  {
    const res = await runCli(['inspect', '--project-id', 'proj-011', '--thread-id', 'th-123']);
    assert.strictEqual(res.exitCode, 2);
    assert.strictEqual(res.response.code, 'INVALID_CLI_REQUEST');
    console.log('PASS: ARC-011 — inspect rejects forbidden flag --thread-id with exit 2');
  }

  // ARC-012: inspect — positional arg after command
  {
    const res = await runCli(['inspect', 'positional-val', '--project-id', 'proj-012']);
    assert.strictEqual(res.exitCode, 2);
    assert.strictEqual(res.response.code, 'INVALID_CLI_REQUEST');
    console.log('PASS: ARC-012 — inspect rejects unexpected positional arg with exit 2');
  }

  // ARC-013: recover — NO_ACTIVE_BOOTSTRAP
  {
    const res = await runCli(['recover', '--project-id', 'proj-013'], {
      runtime: createMockRuntime(),
      lifecycle: {
        recoverAuditorBootstrap: async ({ projectId }) => ({
          ok: true,
          status: 'NO_ACTIVE_BOOTSTRAP',
          project_id: projectId
        })
      }
    });

    assert.strictEqual(res.exitCode, 0);
    assert.strictEqual(res.response.ok, true);
    assert.strictEqual(res.response.status, 'NO_ACTIVE_BOOTSTRAP');
    assertNoForbiddenKeys(res.response);
    console.log('PASS: ARC-013 — recover NO_ACTIVE_BOOTSTRAP exits 0 (idempotent)');
  }

  // ARC-014: recover — PROVISIONAL_THREAD cleared
  {
    const res = await runCli(['recover', '--project-id', 'proj-014'], {
      runtime: createMockRuntime(),
      lifecycle: {
        recoverAuditorBootstrap: async ({ projectId }) => ({
          ok: true,
          status: 'RECOVERED_CLEARED',
          project_id: projectId,
          previous_state: 'PROVISIONAL_THREAD',
          thread_id: 'th-014'
        })
      }
    });

    assert.strictEqual(res.exitCode, 0);
    assert.strictEqual(res.response.status, 'RECOVERED_CLEARED');
    assert.strictEqual(res.response.previous_state, 'PROVISIONAL_THREAD');
    assert.strictEqual(res.response.thread_id, 'th-014');
    assertNoForbiddenKeys(res.response);
    console.log('PASS: ARC-014 — recover PROVISIONAL_THREAD cleared exits 0');
  }

  // ARC-015: recover — FIRST_TURN_STARTING -> AUDIT_UNCERTAIN
  {
    const res = await runCli(['recover', '--project-id', 'proj-015'], {
      runtime: createMockRuntime(),
      lifecycle: {
        recoverAuditorBootstrap: async ({ projectId }) => ({
          ok: false,
          status: 'AUDIT_UNCERTAIN',
          project_id: projectId,
          thread_id: 'th-015',
          message: 'Transitioned to AUDIT_UNCERTAIN'
        })
      }
    });

    assert.strictEqual(res.exitCode, 5);
    assert.strictEqual(res.response.ok, false);
    assert.strictEqual(res.response.status, 'AUDIT_UNCERTAIN');
    assert.strictEqual(res.response.code, 'AUDIT_UNCERTAIN');
    assertNoForbiddenKeys(res.response);
    console.log('PASS: ARC-015 — recover FIRST_TURN_STARTING -> AUDIT_UNCERTAIN exits 5');
  }

  // ARC-016: recover — FIRST_TURN_IN_FLIGHT -> AUDIT_UNCERTAIN
  {
    const res = await runCli(['recover', '--project-id', 'proj-016'], {
      runtime: createMockRuntime(),
      lifecycle: {
        recoverAuditorBootstrap: async ({ projectId }) => ({
          ok: false,
          status: 'AUDIT_UNCERTAIN',
          project_id: projectId,
          thread_id: 'th-016',
          message: 'In flight turn transition to AUDIT_UNCERTAIN'
        })
      }
    });

    assert.strictEqual(res.exitCode, 5);
    assert.strictEqual(res.response.status, 'AUDIT_UNCERTAIN');
    assertNoForbiddenKeys(res.response);
    console.log('PASS: ARC-016 — recover FIRST_TURN_IN_FLIGHT -> AUDIT_UNCERTAIN exits 5');
  }

  // ARC-017: recover — AUDIT_UNCERTAIN already -> preserved
  {
    const res = await runCli(['recover', '--project-id', 'proj-017'], {
      runtime: createMockRuntime(),
      lifecycle: {
        recoverAuditorBootstrap: async ({ projectId }) => ({
          ok: false,
          status: 'AUDIT_UNCERTAIN',
          project_id: projectId,
          thread_id: 'th-017',
          message: 'Already AUDIT_UNCERTAIN'
        })
      }
    });

    assert.strictEqual(res.exitCode, 5);
    assert.strictEqual(res.response.status, 'AUDIT_UNCERTAIN');
    assertNoForbiddenKeys(res.response);
    console.log('PASS: ARC-017 — recover AUDIT_UNCERTAIN already exits 5');
  }

  // ARC-018: recover — DECISION_VALIDATED -> DURABLE_BOUND (bind invoked when Registry unbound)
  {
    let bindInvoked = false;
    const res = await runCli(['recover', '--project-id', 'proj-018'], {
      runtime: createMockRuntime({
        registryPort: {
          bindAuditorThread: async () => { bindInvoked = true; }
        }
      }),
      lifecycle: {
        recoverAuditorBootstrap: async ({ projectId, registryPort }) => {
          await registryPort.bindAuditorThread(projectId, 'th-018');
          return {
            ok: true,
            status: 'DURABLE_BOUND',
            project_id: projectId,
            thread_id: 'th-018',
            reconciled: false
          };
        }
      }
    });

    assert.strictEqual(res.exitCode, 0);
    assert.strictEqual(res.response.status, 'DURABLE_BOUND');
    assert.strictEqual(bindInvoked, true, 'bindAuditorThread must be invoked when unbound');
    assertNoForbiddenKeys(res.response);
    console.log('PASS: ARC-018 — recover DECISION_VALIDATED binds Registry when unbound');
  }

  // ARC-019: recover — RESUME_VERIFYING -> DURABLE_BOUND (bind invoked when Registry unbound)
  {
    let bindInvoked = false;
    const res = await runCli(['recover', '--project-id', 'proj-019'], {
      runtime: createMockRuntime({
        registryPort: {
          bindAuditorThread: async () => { bindInvoked = true; }
        }
      }),
      lifecycle: {
        recoverAuditorBootstrap: async ({ projectId, registryPort }) => {
          await registryPort.bindAuditorThread(projectId, 'th-019');
          return {
            ok: true,
            status: 'DURABLE_BOUND',
            project_id: projectId,
            thread_id: 'th-019',
            reconciled: false
          };
        }
      }
    });

    assert.strictEqual(res.exitCode, 0);
    assert.strictEqual(res.response.status, 'DURABLE_BOUND');
    assert.strictEqual(bindInvoked, true, 'bindAuditorThread must be invoked when unbound');
    assertNoForbiddenKeys(res.response);
    console.log('PASS: ARC-019 — recover RESUME_VERIFYING binds Registry when unbound');
  }

  // ARC-020: recover — RESUME_VERIFIED -> DURABLE_BOUND (bind invoked when Registry unbound)
  {
    let bindInvoked = false;
    const res = await runCli(['recover', '--project-id', 'proj-020'], {
      runtime: createMockRuntime({
        registryPort: {
          bindAuditorThread: async () => { bindInvoked = true; }
        }
      }),
      lifecycle: {
        recoverAuditorBootstrap: async ({ projectId, registryPort }) => {
          await registryPort.bindAuditorThread(projectId, 'th-020');
          return {
            ok: true,
            status: 'DURABLE_BOUND',
            project_id: projectId,
            thread_id: 'th-020',
            reconciled: false
          };
        }
      }
    });

    assert.strictEqual(res.exitCode, 0);
    assert.strictEqual(res.response.status, 'DURABLE_BOUND');
    assert.strictEqual(bindInvoked, true, 'bindAuditorThread must be invoked when unbound');
    assertNoForbiddenKeys(res.response);
    console.log('PASS: ARC-020 — recover RESUME_VERIFIED binds Registry when unbound');
  }

  // ARC-021: recover — REGISTRY_BINDING already bound same thread (idempotent, NO Registry write)
  {
    let bindInvoked = false;
    const res = await runCli(['recover', '--project-id', 'proj-021'], {
      runtime: createMockRuntime({
        registryPort: {
          bindAuditorThread: async () => { bindInvoked = true; }
        }
      }),
      lifecycle: {
        recoverAuditorBootstrap: async ({ projectId }) => {
          // Already bound exact same thread: skip bindAuditorThread
          return {
            ok: true,
            status: 'DURABLE_BOUND',
            project_id: projectId,
            thread_id: 'th-021',
            reconciled: true
          };
        }
      }
    });

    assert.strictEqual(res.exitCode, 0);
    assert.strictEqual(res.response.status, 'DURABLE_BOUND');
    assert.strictEqual(bindInvoked, false, 'bindAuditorThread must NOT be invoked when already bound');
    assertNoForbiddenKeys(res.response);
    console.log('PASS: ARC-021 — recover REGISTRY_BINDING already bound skips Registry write');
  }

  // ARC-022: recover — AUDIT_TERMINAL_NO_DECISION cleared
  {
    const res = await runCli(['recover', '--project-id', 'proj-022'], {
      runtime: createMockRuntime(),
      lifecycle: {
        recoverAuditorBootstrap: async ({ projectId }) => ({
          ok: true,
          status: 'RECOVERED_TERMINAL_NO_DECISION_CLEARED',
          project_id: projectId,
          previous_state: 'AUDIT_TERMINAL_NO_DECISION',
          thread_id: 'th-022'
        })
      }
    });

    assert.strictEqual(res.exitCode, 0);
    assert.strictEqual(res.response.status, 'RECOVERED_TERMINAL_NO_DECISION_CLEARED');
    assertNoForbiddenKeys(res.response);
    console.log('PASS: ARC-022 — recover AUDIT_TERMINAL_NO_DECISION cleared exits 0');
  }

  // ARC-023: recover — authority_version === 0 in DECISION_VALIDATED -> precondition failure
  {
    const res = await runCli(['recover', '--project-id', 'proj-023'], {
      runtime: createMockRuntime(),
      lifecycle: {
        recoverAuditorBootstrap: async () => {
          throw new AuditorLifecycleError(
            LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED,
            'Cannot recover DECISION_VALIDATED for authority_version 0'
          );
        }
      }
    });

    assert.strictEqual(res.exitCode, 6);
    assert.strictEqual(res.response.code, 'AUDITOR_LIFECYCLE_PRECONDITION_FAILED');
    console.log('PASS: ARC-023 — recover authority_version 0 fails with exit 6');
  }

  // ARC-024: recover — authority drift (project_root changed) -> precondition failure
  {
    const res = await runCli(['recover', '--project-id', 'proj-024'], {
      runtime: createMockRuntime(),
      lifecycle: {
        recoverAuditorBootstrap: async () => {
          throw new AuditorLifecycleError(
            LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED,
            'Authority drift detected: canonical project_root mismatch'
          );
        }
      }
    });

    assert.strictEqual(res.exitCode, 6);
    assert.strictEqual(res.response.code, 'AUDITOR_LIFECYCLE_PRECONDITION_FAILED');
    console.log('PASS: ARC-024 — recover authority drift fails with exit 6');
  }

  // ARC-025: recover — resume verification fails (wrong thread ID returned)
  {
    const res = await runCli(['recover', '--project-id', 'proj-025'], {
      runtime: createMockRuntime(),
      lifecycle: {
        recoverAuditorBootstrap: async () => {
          throw new AuditorLifecycleError(
            LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_RESUME_VERIFY_FAILED,
            'Resume verified wrong thread ID'
          );
        }
      }
    });

    assert.strictEqual(res.exitCode, 9);
    assert.strictEqual(res.response.code, 'AUDITOR_LIFECYCLE_RESUME_VERIFY_FAILED');
    console.log('PASS: ARC-025 — recover resume verification failure exits 9');
  }

  // ARC-026: recover — Registry bind fails
  {
    const res = await runCli(['recover', '--project-id', 'proj-026'], {
      runtime: createMockRuntime(),
      lifecycle: {
        recoverAuditorBootstrap: async () => {
          throw new AuditorLifecycleError(
            LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_REGISTRY_BIND_FAILED,
            'Failed to bind auditor in registry'
          );
        }
      }
    });

    assert.strictEqual(res.exitCode, 10);
    assert.strictEqual(res.response.code, 'AUDITOR_LIFECYCLE_REGISTRY_BIND_FAILED');
    console.log('PASS: ARC-026 — recover Registry bind failure exits 10');
  }

  // ARC-027: recover — corrupt recovery (decision hash mismatch)
  {
    const res = await runCli(['recover', '--project-id', 'proj-027'], {
      runtime: createMockRuntime(),
      lifecycle: {
        recoverAuditorBootstrap: async () => {
          throw new AuditorLifecycleError(
            LIFECYCLE_ERROR_CODES.AUDITOR_RECOVERY_CORRUPT,
            'Recovery corrupt: decision hash mismatch'
          );
        }
      }
    });

    assert.strictEqual(res.exitCode, 8);
    assert.strictEqual(res.response.code, 'AUDITOR_RECOVERY_CORRUPT');
    console.log('PASS: ARC-027 — recover corrupt recovery exits 8');
  }

  // ARC-028: recover — terminal-no-decision, project missing
  {
    const res = await runCli(['recover', '--project-id', 'proj-028'], {
      runtime: createMockRuntime(),
      lifecycle: {
        recoverAuditorBootstrap: async () => {
          throw new AuditorLifecycleError(
            LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED,
            "Project 'proj-028' not found in registry"
          );
        }
      }
    });

    assert.strictEqual(res.exitCode, 6);
    assert.strictEqual(res.response.code, 'AUDITOR_LIFECYCLE_PRECONDITION_FAILED');
    console.log('PASS: ARC-028 — recover terminal-no-decision project missing exits 6');
  }

  // ARC-029: recover — forbidden flag --operation-id
  {
    const res = await runCli(['recover', '--project-id', 'proj-029', '--operation-id', 'op-manual']);
    assert.strictEqual(res.exitCode, 2);
    assert.strictEqual(res.response.code, 'INVALID_CLI_REQUEST');
    console.log('PASS: ARC-029 — recover rejects --operation-id with exit 2');
  }

  // ARC-030: resolve-uncertainty — not in AUDIT_UNCERTAIN state
  {
    const res = await runCli(['resolve-uncertainty', '--project-id', 'proj-030'], {
      runtime: createMockRuntime(),
      lifecycle: {
        resolveAuditorBootstrapUncertainty: async () => {
          throw new AuditorLifecycleError(
            LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED,
            "Active bootstrap is in state 'PROVISIONAL_THREAD', expected 'AUDIT_UNCERTAIN'"
          );
        }
      }
    });

    assert.strictEqual(res.exitCode, 6);
    assert.strictEqual(res.response.code, 'AUDITOR_LIFECYCLE_PRECONDITION_FAILED');
    console.log('PASS: ARC-030 — resolve-uncertainty not in AUDIT_UNCERTAIN exits 6');
  }

  // ARC-031: resolve-uncertainty — no active bootstrap
  {
    const res = await runCli(['resolve-uncertainty', '--project-id', 'proj-031'], {
      runtime: createMockRuntime(),
      lifecycle: {
        resolveAuditorBootstrapUncertainty: async () => {
          throw new AuditorLifecycleError(
            LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED,
            "No active bootstrap record found for project 'proj-031'"
          );
        }
      }
    });

    assert.strictEqual(res.exitCode, 6);
    assert.strictEqual(res.response.code, 'AUDITOR_LIFECYCLE_PRECONDITION_FAILED');
    console.log('PASS: ARC-031 — resolve-uncertainty no active bootstrap exits 6');
  }

  // ARC-032: resolve-uncertainty — AUDIT_UNCERTAIN, no turn_id -> preserved
  {
    const res = await runCli(['resolve-uncertainty', '--project-id', 'proj-032'], {
      runtime: createMockRuntime(),
      lifecycle: {
        resolveAuditorBootstrapUncertainty: async ({ projectId }) => ({
          ok: false,
          status: 'AUDIT_UNCERTAIN',
          project_id: projectId,
          thread_id: 'th-032',
          turn_id: null,
          reason: 'TURN_HISTORY_INVALID: Active bootstrap record contains no turn_id'
        })
      }
    });

    assert.strictEqual(res.exitCode, 5);
    assert.strictEqual(res.response.status, 'AUDIT_UNCERTAIN');
    assert.strictEqual(res.response.code, 'AUDIT_UNCERTAIN');
    assert(res.response.reason.includes('TURN_HISTORY_INVALID'));
    assertNoForbiddenKeys(res.response);
    console.log('PASS: ARC-032 — resolve-uncertainty no turn_id preserves AUDIT_UNCERTAIN (exit 5)');
  }

  // ARC-033: resolve-uncertainty — provider readThread fails -> AUDIT_UNCERTAIN preserved (NOT exit 7)
  {
    const res = await runCli(['resolve-uncertainty', '--project-id', 'proj-033'], {
      runtime: createMockRuntime(),
      lifecycle: {
        resolveAuditorBootstrapUncertainty: async ({ projectId }) => ({
          ok: false,
          status: 'AUDIT_UNCERTAIN',
          project_id: projectId,
          thread_id: 'th-033',
          turn_id: 'turn-033',
          reason: 'PROVIDER_INSPECTION_FAILED: readThread transport connection reset'
        })
      }
    });

    assert.strictEqual(res.exitCode, 5);
    assert.strictEqual(res.response.status, 'AUDIT_UNCERTAIN');
    assert(res.response.reason.includes('PROVIDER_INSPECTION_FAILED'));
    assertNoForbiddenKeys(res.response);
    console.log('PASS: ARC-033 — resolve-uncertainty provider read failure preserves AUDIT_UNCERTAIN (exit 5)');
  }

  // ARC-034: resolve-uncertainty — thread ID mismatch from provider -> preserved
  {
    const res = await runCli(['resolve-uncertainty', '--project-id', 'proj-034'], {
      runtime: createMockRuntime(),
      lifecycle: {
        resolveAuditorBootstrapUncertainty: async ({ projectId }) => ({
          ok: false,
          status: 'AUDIT_UNCERTAIN',
          project_id: projectId,
          thread_id: 'th-034',
          turn_id: 'turn-034',
          reason: "THREAD_ID_MISMATCH: readThread returned thread ID 'th-other'"
        })
      }
    });

    assert.strictEqual(res.exitCode, 5);
    assert.strictEqual(res.response.status, 'AUDIT_UNCERTAIN');
    assert(res.response.reason.includes('THREAD_ID_MISMATCH'));
    assertNoForbiddenKeys(res.response);
    console.log('PASS: ARC-034 — resolve-uncertainty thread ID mismatch preserves AUDIT_UNCERTAIN (exit 5)');
  }

  // ARC-035: resolve-uncertainty — turn count != 1 -> preserved
  {
    const res = await runCli(['resolve-uncertainty', '--project-id', 'proj-035'], {
      runtime: createMockRuntime(),
      lifecycle: {
        resolveAuditorBootstrapUncertainty: async ({ projectId }) => ({
          ok: false,
          status: 'AUDIT_UNCERTAIN',
          project_id: projectId,
          thread_id: 'th-035',
          turn_id: 'turn-035',
          reason: 'TURN_HISTORY_INVALID: thread contains 2 turns, expected exactly 1'
        })
      }
    });

    assert.strictEqual(res.exitCode, 5);
    assert.strictEqual(res.response.status, 'AUDIT_UNCERTAIN');
    assert(res.response.reason.includes('TURN_HISTORY_INVALID'));
    assertNoForbiddenKeys(res.response);
    console.log('PASS: ARC-035 — resolve-uncertainty turn count != 1 preserves AUDIT_UNCERTAIN (exit 5)');
  }

  // ARC-036: resolve-uncertainty — turn interrupted -> AUDIT_TERMINAL_NO_DECISION
  {
    const res = await runCli(['resolve-uncertainty', '--project-id', 'proj-036'], {
      runtime: createMockRuntime(),
      lifecycle: {
        resolveAuditorBootstrapUncertainty: async ({ projectId }) => ({
          ok: true,
          status: 'AUDIT_TERMINAL_NO_DECISION',
          project_id: projectId,
          thread_id: 'th-036',
          turn_id: 'turn-036',
          turn_status: 'interrupted'
        })
      }
    });

    assert.strictEqual(res.exitCode, 0);
    assert.strictEqual(res.response.status, 'AUDIT_TERMINAL_NO_DECISION');
    assert.strictEqual(res.response.turn_status, 'interrupted');
    assertNoForbiddenKeys(res.response);
    console.log('PASS: ARC-036 — resolve-uncertainty interrupted turn resolves to terminal no-decision');
  }

  // ARC-037: resolve-uncertainty — turn failed -> AUDIT_TERMINAL_NO_DECISION
  {
    const res = await runCli(['resolve-uncertainty', '--project-id', 'proj-037'], {
      runtime: createMockRuntime(),
      lifecycle: {
        resolveAuditorBootstrapUncertainty: async ({ projectId }) => ({
          ok: true,
          status: 'AUDIT_TERMINAL_NO_DECISION',
          project_id: projectId,
          thread_id: 'th-037',
          turn_id: 'turn-037',
          turn_status: 'failed'
        })
      }
    });

    assert.strictEqual(res.exitCode, 0);
    assert.strictEqual(res.response.status, 'AUDIT_TERMINAL_NO_DECISION');
    assert.strictEqual(res.response.turn_status, 'failed');
    assertNoForbiddenKeys(res.response);
    console.log('PASS: ARC-037 — resolve-uncertainty failed turn resolves to terminal no-decision');
  }

  // ARC-038: resolve-uncertainty — turn completed, valid decision -> DECISION_VALIDATED
  {
    const res = await runCli(['resolve-uncertainty', '--project-id', 'proj-038'], {
      runtime: createMockRuntime(),
      lifecycle: {
        resolveAuditorBootstrapUncertainty: async ({ projectId }) => ({
          ok: true,
          status: 'DECISION_VALIDATED',
          project_id: projectId,
          thread_id: 'th-038',
          turn_id: 'turn-038',
          decision_sha256: 'sha256-038-abc',
          decision: { verdict: 'PASS' }
        })
      }
    });

    assert.strictEqual(res.exitCode, 0);
    assert.strictEqual(res.response.status, 'DECISION_VALIDATED');
    assert.strictEqual(res.response.decision_sha256, 'sha256-038-abc');
    assert.strictEqual('decision' in res.response, false, 'decision object must NOT be in response');
    assertNoForbiddenKeys(res.response);
    console.log('PASS: ARC-038 — resolve-uncertainty valid decision validates and omits raw decision object');
  }

  // ARC-039: resolve-uncertainty — turn completed, invalid decision -> preserved
  {
    const res = await runCli(['resolve-uncertainty', '--project-id', 'proj-039'], {
      runtime: createMockRuntime(),
      lifecycle: {
        resolveAuditorBootstrapUncertainty: async ({ projectId }) => ({
          ok: false,
          status: 'AUDIT_UNCERTAIN',
          project_id: projectId,
          thread_id: 'th-039',
          turn_id: 'turn-039',
          reason: 'DECISION_VALIDATION_FAILED: Schema validation error'
        })
      }
    });

    assert.strictEqual(res.exitCode, 5);
    assert.strictEqual(res.response.status, 'AUDIT_UNCERTAIN');
    assert(res.response.reason.includes('DECISION_VALIDATION_FAILED'));
    assertNoForbiddenKeys(res.response);
    console.log('PASS: ARC-039 — resolve-uncertainty invalid decision preserves AUDIT_UNCERTAIN (exit 5)');
  }

  // ARC-040: resolve-uncertainty — turn non-terminal (inProgress) -> preserved
  {
    const res = await runCli(['resolve-uncertainty', '--project-id', 'proj-040'], {
      runtime: createMockRuntime(),
      lifecycle: {
        resolveAuditorBootstrapUncertainty: async ({ projectId }) => ({
          ok: false,
          status: 'AUDIT_UNCERTAIN',
          project_id: projectId,
          thread_id: 'th-040',
          turn_id: 'turn-040',
          reason: "TURN_NONTERMINAL: Turn has non-terminal status 'inProgress'"
        })
      }
    });

    assert.strictEqual(res.exitCode, 5);
    assert.strictEqual(res.response.status, 'AUDIT_UNCERTAIN');
    assert(res.response.reason.includes('TURN_NONTERMINAL'));
    assertNoForbiddenKeys(res.response);
    console.log('PASS: ARC-040 — resolve-uncertainty inProgress turn preserves AUDIT_UNCERTAIN (exit 5)');
  }

  // ARC-041: resolve-uncertainty — authority_version === 0 -> precondition failure
  {
    const res = await runCli(['resolve-uncertainty', '--project-id', 'proj-041'], {
      runtime: createMockRuntime(),
      lifecycle: {
        resolveAuditorBootstrapUncertainty: async () => {
          throw new AuditorLifecycleError(
            LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED,
            'Cannot resolve uncertainty: authority_version is 0'
          );
        }
      }
    });

    assert.strictEqual(res.exitCode, 6);
    assert.strictEqual(res.response.code, 'AUDITOR_LIFECYCLE_PRECONDITION_FAILED');
    console.log('PASS: ARC-041 — resolve-uncertainty authority_version 0 fails with exit 6');
  }

  // ARC-042: resolve-uncertainty — authority drift -> precondition failure
  {
    const res = await runCli(['resolve-uncertainty', '--project-id', 'proj-042'], {
      runtime: createMockRuntime(),
      lifecycle: {
        resolveAuditorBootstrapUncertainty: async () => {
          throw new AuditorLifecycleError(
            LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED,
            'Authority drift detected: canonical project_root mismatch'
          );
        }
      }
    });

    assert.strictEqual(res.exitCode, 6);
    assert.strictEqual(res.response.code, 'AUDITOR_LIFECYCLE_PRECONDITION_FAILED');
    console.log('PASS: ARC-042 — resolve-uncertainty authority drift fails with exit 6');
  }

  // ARC-043: resolve-uncertainty — forbidden flag --turn-id
  {
    const res = await runCli(['resolve-uncertainty', '--project-id', 'proj-043', '--turn-id', 'turn-xyz']);
    assert.strictEqual(res.exitCode, 2);
    assert.strictEqual(res.response.code, 'INVALID_CLI_REQUEST');
    console.log('PASS: ARC-043 — resolve-uncertainty rejects forbidden flag --turn-id with exit 2');
  }

  // ARC-044: retire-legacy — authority_version === 0, unbound -> success
  {
    const res = await runCli(['retire-legacy', '--project-id', 'proj-044', '--confirm'], {
      runtime: createMockRuntime(),
      lifecycle: {
        retireLegacyAuditorBootstrapWithoutAuthority: async ({ projectId }) => ({
          ok: true,
          operation: 'retire-legacy',
          project_id: projectId,
          operation_id: 'op-legacy-044',
          status: 'RETIRED_LEGACY_AUTHORITY_UNAVAILABLE'
        })
      }
    });

    assert.strictEqual(res.exitCode, 0);
    assert.strictEqual(res.response.ok, true);
    assert.strictEqual(res.response.status, 'RETIRED_LEGACY_AUTHORITY_UNAVAILABLE');
    assert.strictEqual(res.response.operation_id, 'op-legacy-044');
    assertNoForbiddenKeys(res.response);
    console.log('PASS: ARC-044 — retire-legacy with --confirm succeeds with exit 0');
  }

  // ARC-045: retire-legacy — no active bootstrap
  {
    const res = await runCli(['retire-legacy', '--project-id', 'proj-045', '--confirm'], {
      runtime: createMockRuntime(),
      lifecycle: {
        retireLegacyAuditorBootstrapWithoutAuthority: async () => {
          throw new AuditorLifecycleError(
            LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED,
            "No active bootstrap found for project 'proj-045'"
          );
        }
      }
    });

    assert.strictEqual(res.exitCode, 6);
    assert.strictEqual(res.response.code, 'AUDITOR_LIFECYCLE_PRECONDITION_FAILED');
    console.log('PASS: ARC-045 — retire-legacy no active bootstrap fails with exit 6');
  }

  // ARC-046: retire-legacy — authority_version === 1 (not legacy)
  {
    const res = await runCli(['retire-legacy', '--project-id', 'proj-046', '--confirm'], {
      runtime: createMockRuntime(),
      lifecycle: {
        retireLegacyAuditorBootstrapWithoutAuthority: async () => {
          throw new AuditorLifecycleError(
            LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED,
            'authority_version is 1, expected 0'
          );
        }
      }
    });

    assert.strictEqual(res.exitCode, 6);
    assert.strictEqual(res.response.code, 'AUDITOR_LIFECYCLE_PRECONDITION_FAILED');
    console.log('PASS: ARC-046 — retire-legacy authority_version 1 fails with exit 6');
  }

  // ARC-047: retire-legacy — Registry auditor bound (thread_id !== null)
  {
    const res = await runCli(['retire-legacy', '--project-id', 'proj-047', '--confirm'], {
      runtime: createMockRuntime(),
      lifecycle: {
        retireLegacyAuditorBootstrapWithoutAuthority: async () => {
          throw new AuditorLifecycleError(
            LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED,
            "Project 'proj-047' auditor is not unbound in registry"
          );
        }
      }
    });

    assert.strictEqual(res.exitCode, 6);
    assert.strictEqual(res.response.code, 'AUDITOR_LIFECYCLE_PRECONDITION_FAILED');
    console.log('PASS: ARC-047 — retire-legacy bound registry auditor fails with exit 6');
  }

  // ARC-048: retire-legacy — missing --confirm
  {
    const res = await runCli(['retire-legacy', '--project-id', 'proj-048']);
    assert.strictEqual(res.exitCode, 2);
    assert.strictEqual(res.response.code, 'INVALID_CLI_REQUEST');
    console.log('PASS: ARC-048 — retire-legacy missing --confirm rejects with exit 2');
  }

  // ARC-049: retire-legacy — forbidden flag --operation-id
  {
    const res = await runCli(['retire-legacy', '--project-id', 'proj-049', '--confirm', '--operation-id', 'op-manual']);
    assert.strictEqual(res.exitCode, 2);
    assert.strictEqual(res.response.code, 'INVALID_CLI_REQUEST');
    console.log('PASS: ARC-049 — retire-legacy rejects --operation-id with exit 2');
  }

  // ARC-050: --help
  {
    const res = await runCli(['--help']);
    assert.strictEqual(res.exitCode, 0);
    assert.strictEqual(res.response.operation, 'help');
    assert(Array.isArray(res.response.commands));
    assert(res.response.commands.includes('inspect'));
    assert(res.response.commands.includes('recover'));
    assert(res.response.commands.includes('resolve-uncertainty'));
    assert(res.response.commands.includes('retire-legacy'));
    console.log('PASS: ARC-050 — --help emits valid help JSON listing all 4 commands');
  }

  // ARC-051: Unknown command
  {
    const res = await runCli(['unknown-cmd', '--project-id', 'proj-051']);
    assert.strictEqual(res.exitCode, 2);
    assert.strictEqual(res.response.code, 'INVALID_CLI_REQUEST');
    console.log('PASS: ARC-051 — unknown command rejected with exit 2');
  }

  // ARC-052: No command at all
  {
    const res = await runCli([]);
    assert.strictEqual(res.exitCode, 2);
    assert.strictEqual(res.response.code, 'INVALID_CLI_REQUEST');
    console.log('PASS: ARC-052 — empty argv rejected with exit 2');
  }

  // ARC-053: inspect — no decision_json field in history entries
  {
    const res = await runCli(['inspect', '--project-id', 'proj-053'], {
      runtime: createMockRuntime(),
      lifecycle: {
        inspectAuditorBootstrap: async ({ projectId }) => ({
          project_id: projectId,
          active_bootstrap: null,
          history: [
            {
              history_seq: 1,
              operation_id: 'op-053',
              previous_state: 'PROVISIONAL_THREAD',
              next_state: 'FIRST_TURN_STARTING',
              iso: '2026-09-21T00:00:00.000Z',
              decision_json: '{"leak":true}',
              extra_unauthorized_key: 'danger'
            }
          ],
          registry_binding_state: 'AUDITOR_BOUND_READY',
          registry_project: { id: 'proj-053' }
        })
      }
    });

    assert.strictEqual(res.exitCode, 0);
    assert.strictEqual(res.response.history.length, 1);
    assert.strictEqual('decision_json' in res.response.history[0], false);
    assert.strictEqual('extra_unauthorized_key' in res.response.history[0], false);
    assertNoForbiddenKeys(res.response);
    console.log('PASS: ARC-053 — inspect projects history without decision_json or unauthorized keys');
  }

  // ARC-054: unmapped operational structured error fallback
  {
    const res = await runCli(['recover', '--project-id', 'proj-054'], {
      runtime: createMockRuntime(),
      lifecycle: {
        recoverAuditorBootstrap: async () => {
          const err = new Error('Conflict detected on active bootstrap');
          err.code = 'AUDITOR_RECOVERY_BOOTSTRAP_CONFLICT';
          throw err;
        }
      }
    });

    assert.strictEqual(res.exitCode, 12);
    assert.strictEqual(res.response.ok, false);
    assert.strictEqual(res.response.code, 'AUDITOR_RECOVERY_BOOTSTRAP_CONFLICT');
    assert.strictEqual('stack' in res.response, false);
    console.log('PASS: ARC-054 — unmapped operational structured error maps to exit 12 (CLI_RUNTIME_FAILURE)');
  }

  // ARC-055: adapterFactory receives { phase, cwd } signature
  {
    const factory = createAuditorAdapterFactory();
    const adapter = await factory({
      phase: 'resume_verify',
      cwd: '/canonical/project'
    });

    assert(adapter, 'Adapter instance should be created');
    const receivedCwd = adapter.cwd || (adapter._options && adapter._options.cwd);
    assert.strictEqual(typeof receivedCwd, 'string', "Adapter must receive string cwd");
    assert.strictEqual(receivedCwd, '/canonical/project', "Adapter must receive exact canonical cwd string");
    assert.strictEqual(adapter._client._cwd, '/canonical/project', "Underlying client must receive canonical cwd");
    console.log('PASS: ARC-055 — adapterFactory correctly accepts { phase, cwd } signature');
  }

  // ARC-056: adapterFactory authority cwd overrides injected adapterOptions.cwd
  {
    const factory = createAuditorAdapterFactory({
      adapterOptions: {
        cwd: '/attacker/override',
        timeoutMs: 5000
      }
    });

    const adapter = await factory({
      phase: 'uncertainty_inspect',
      cwd: '/canonical/project'
    });

    const receivedCwd = adapter.cwd || (adapter._options && adapter._options.cwd);
    assert.strictEqual(receivedCwd, '/canonical/project', 'Lifecycle canonical cwd must win over adapterOptions.cwd');
    assert.strictEqual(adapter._client._cwd, '/canonical/project', 'Underlying client cwd must be lifecycle canonical cwd');
    console.log('PASS: ARC-056 — lifecycle canonical cwd takes precedence over adapterOptions.cwd');
  }

  // ARC-057: runtime factory throws AUDITOR_RECOVERY_SCHEMA_INVALID -> exit 11
  {
    const res = await runCli(['recover', '--project-id', 'proj-057'], {
      runtimeFactory: async () => {
        const err = new Error('Database schema version mismatch');
        err.code = 'AUDITOR_RECOVERY_SCHEMA_INVALID';
        throw err;
      }
    });

    assert.strictEqual(res.exitCode, 11);
    assert.strictEqual(res.response.code, 'AUDITOR_RECOVERY_SCHEMA_INVALID');
    assert.strictEqual('stack' in res.response, false);
    console.log('PASS: ARC-057 — runtime init AUDITOR_RECOVERY_SCHEMA_INVALID maps to exit 11');
  }

  // ARC-058: runtime factory throws REGISTRY_CORRUPT -> exit 11
  {
    const res = await runCli(['recover', '--project-id', 'proj-058'], {
      runtimeFactory: async () => {
        const err = new Error('Projects registry JSON is corrupted');
        err.code = 'REGISTRY_CORRUPT';
        throw err;
      }
    });

    assert.strictEqual(res.exitCode, 11);
    assert.strictEqual(res.response.code, 'REGISTRY_CORRUPT');
    assert.strictEqual('stack' in res.response, false);
    console.log('PASS: ARC-058 — runtime init REGISTRY_CORRUPT maps to exit 11');
  }

  // Additional non-ARC boundary verification: adapterOptions.client blocked in production factory
  {
    assert.throws(() => {
      createAuditorAdapterFactory({
        adapterOptions: {
          client: { fake: true }
        }
      });
    }, (err) => {
      return err.code === 'AUDITOR_CLI_RUNTIME_INVALID_OPTION';
    }, 'adapterOptions.client must be blocked in production adapter factory');
  }

  // Additional non-ARC boundary verification: truncateUtf8 multibyte safety
  {
    const multiByteStr = '🔥'.repeat(300); // 4 bytes each = 1200 bytes
    const truncated = truncateUtf8(multiByteStr, 1024);
    assert(Buffer.byteLength(truncated, 'utf8') <= 1024);
    assert.strictEqual(truncated.endsWith('\uFFFD'), false);
  }

  console.log('\n======================================================================');
  console.log('ALL AUDITOR RECOVER CLI TESTS PASSED (ARC-001 .. ARC-058: 58/58 PASS)');
  console.log('======================================================================');
}

runAllTests()
  .catch((err) => {
    console.error('[TEST SUITE FAILURE]', err);
    process.exit(1);
  })
  .finally(() => {
    cleanupTempDir();
  });
