'use strict';

/**
 * Auditor Recovery Store Test Suite (ARS-001 .. ARS-078)
 * Verifies SQLite recovery store authority, single active bootstrap,
 * transition matrix, append-only history, decision hash & schema verification,
 * reopen semantics, schema v2 immutable authority, and legacy retirement.
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const {
  AUDITOR_BOOTSTRAP_STATES,
  RECOVERY_ERROR_CODES,
  createSqliteAuditorRecoveryStore: createSqliteAuditorRecoveryStoreRaw
} = require('../../lib/relay/sqlite-auditor-recovery-store');

function createSqliteAuditorRecoveryStore(options) {
  const store = createSqliteAuditorRecoveryStoreRaw(options);
  const rawBeginBootstrap = store.beginBootstrap.bind(store);
  store.beginBootstrap = function (bootstrapOptions) {
    if (!bootstrapOptions || typeof bootstrapOptions !== 'object') {
      return rawBeginBootstrap(bootstrapOptions);
    }
    const defaulted = {
      authority_version: 1,
      expected_project_root: 'd:/TU_CODE/Orchestrator',
      expected_project_root_identity: 'd:/tu_code/orchestrator',
      expected_auditor_model_policy: 'strict-read-only',
      ...bootstrapOptions
    };
    return rawBeginBootstrap(defaulted);
  };
  return store;
}

const {
  AUDIT_DECISIONS,
  INDEPENDENT_VERIFICATION_KINDS,
  VERIFICATION_RESULTS,
  WORKER_MODEL_POLICIES
} = require('../../lib/relay/audit-decision');

function createTempDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ars-test-'));
  return {
    dir,
    dbPath: path.join(dir, 'recovery.sqlite3')
  };
}

function cleanupTempDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}

function makeValidDecision(ctx) {
  return {
    schema_version: 1,
    decision: AUDIT_DECISIONS.DISPATCH_WORKER,
    project_id: ctx.project_id,
    audit_subject_id: ctx.audit_subject_id,
    auditor_thread_id: ctx.auditor_thread_id,
    workspace_state_observed: ctx.workspace_state_observed,
    summary: 'Decision verified cleanly for worker dispatch.',
    independent_verification: [
      {
        kind: INDEPENDENT_VERIFICATION_KINDS.SOURCE_INSPECTION,
        result: VERIFICATION_RESULTS.PASS,
        evidence: 'Source verified against spec.'
      }
    ],
    work_order: {
      work_order_id: 'wo-bootstrap-01',
      directive: 'Execute bootstrap validation steps.',
      verification: ['Run npm test.'],
      worker_model_policy: WORKER_MODEL_POLICIES.WORKER_STANDARD
    },
    requested_evidence: [],
    blocker: null
  };
}

async function runTests() {
  console.log('Starting Auditor Recovery Store test suite (ARS-001 .. ARS-061)...');

  // ARS-001: Fresh DB creation and schema initialization
  {
    const { dir, dbPath } = createTempDbPath();
    try {
      const store = createSqliteAuditorRecoveryStore({ dbPath });
      const active = store.listActiveBootstraps();
      assert.strictEqual(active.length, 0);
      store.close();
      console.log('PASS: ARS-001 — Fresh DB creation and schema initialization');
    } finally {
      cleanupTempDir(dir);
    }
  }

  // ARS-002: Begin bootstrap creates PROVISIONAL_THREAD record and history
  {
    const { dir, dbPath } = createTempDbPath();
    try {
      const store = createSqliteAuditorRecoveryStore({ dbPath });
      const row = store.beginBootstrap({
        project_id: 'proj-alpha',
        operation_id: 'op-001',
        audit_subject_id: 'sub-01',
        thread_id: 'thr_opaque_123',
        workspace_state_observed: 'ws_hash_abc'
      });
      assert.strictEqual(row.project_id, 'proj-alpha');
      assert.strictEqual(row.operation_id, 'op-001');
      assert.strictEqual(row.state, AUDITOR_BOOTSTRAP_STATES.PROVISIONAL_THREAD);
      assert.strictEqual(row.thread_id, 'thr_opaque_123');
      assert.strictEqual(row.turn_id, null);

      const history = store.getHistory('proj-alpha', 'op-001');
      assert.strictEqual(history.length, 1);
      assert.strictEqual(history[0].previous_state, null);
      assert.strictEqual(history[0].next_state, AUDITOR_BOOTSTRAP_STATES.PROVISIONAL_THREAD);
      store.close();
      console.log('PASS: ARS-002 — Begin bootstrap creates PROVISIONAL_THREAD record and initial history');
    } finally {
      cleanupTempDir(dir);
    }
  }

  // ARS-003: Single active bootstrap per project enforced
  {
    const { dir, dbPath } = createTempDbPath();
    try {
      const store = createSqliteAuditorRecoveryStore({ dbPath });
      store.beginBootstrap({
        project_id: 'proj-alpha',
        operation_id: 'op-001',
        audit_subject_id: 'sub-01',
        thread_id: 'thr_1',
        workspace_state_observed: 'ws_1'
      });

      assert.throws(
        () => store.beginBootstrap({
          project_id: 'proj-alpha',
          operation_id: 'op-002',
          audit_subject_id: 'sub-02',
          thread_id: 'thr_2',
          workspace_state_observed: 'ws_2'
        }),
        { code: RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_BOOTSTRAP_CONFLICT }
      );
      store.close();
      console.log('PASS: ARS-003 — Single active bootstrap per project enforced');
    } finally {
      cleanupTempDir(dir);
    }
  }

  // ARS-004: Multiple projects can have independent active bootstraps
  {
    const { dir, dbPath } = createTempDbPath();
    try {
      const store = createSqliteAuditorRecoveryStore({ dbPath });
      store.beginBootstrap({
        project_id: 'proj-alpha',
        operation_id: 'op-alpha-01',
        audit_subject_id: 'sub-01',
        thread_id: 'thr_alpha',
        workspace_state_observed: 'ws_alpha'
      });
      store.beginBootstrap({
        project_id: 'proj-beta',
        operation_id: 'op-beta-01',
        audit_subject_id: 'sub-02',
        thread_id: 'thr_beta',
        workspace_state_observed: 'ws_beta'
      });

      const list = store.listActiveBootstraps();
      assert.strictEqual(list.length, 2);
      store.close();
      console.log('PASS: ARS-004 — Multiple projects can have independent active bootstraps');
    } finally {
      cleanupTempDir(dir);
    }
  }

  // ARS-005: Duplicate operation_id across projects rejected by DB unique constraint
  {
    const { dir, dbPath } = createTempDbPath();
    try {
      const store = createSqliteAuditorRecoveryStore({ dbPath });
      store.beginBootstrap({
        project_id: 'proj-alpha',
        operation_id: 'op-shared-id',
        audit_subject_id: 'sub-01',
        thread_id: 'thr_alpha',
        workspace_state_observed: 'ws_alpha'
      });

      assert.throws(
        () => store.beginBootstrap({
          project_id: 'proj-beta',
          operation_id: 'op-shared-id',
          audit_subject_id: 'sub-02',
          thread_id: 'thr_beta',
          workspace_state_observed: 'ws_beta'
        }),
        { code: RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_BOOTSTRAP_CONFLICT }
      );
      store.close();
      console.log('PASS: ARS-005 — Duplicate operation_id rejected by DB constraint');
    } finally {
      cleanupTempDir(dir);
    }
  }

  // ARS-006: Thread ID bounds validation
  {
    const { dir, dbPath } = createTempDbPath();
    try {
      const store = createSqliteAuditorRecoveryStore({ dbPath });
      // Empty
      assert.throws(
        () => store.beginBootstrap({ project_id: 'p1', operation_id: 'op1', audit_subject_id: 's1', thread_id: '', workspace_state_observed: 'ws1' }),
        { code: RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_INVALID_REQUEST }
      );
      // Oversized (> 512 bytes)
      assert.throws(
        () => store.beginBootstrap({ project_id: 'p1', operation_id: 'op1', audit_subject_id: 's1', thread_id: 't'.repeat(513), workspace_state_observed: 'ws1' }),
        { code: RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_INVALID_REQUEST }
      );
      // Control characters
      assert.throws(
        () => store.beginBootstrap({ project_id: 'p1', operation_id: 'op1', audit_subject_id: 's1', thread_id: 'thr_test\x00_bad', workspace_state_observed: 'ws1' }),
        { code: RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_INVALID_REQUEST }
      );
      store.close();
      console.log('PASS: ARS-006 — Thread ID bounds validation enforced');
    } finally {
      cleanupTempDir(dir);
    }
  }

  // ARS-007: Operation ID bounds validation
  {
    const { dir, dbPath } = createTempDbPath();
    try {
      const store = createSqliteAuditorRecoveryStore({ dbPath });
      assert.throws(
        () => store.beginBootstrap({ project_id: 'p1', operation_id: '', audit_subject_id: 's1', thread_id: 't1', workspace_state_observed: 'ws1' }),
        { code: RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_INVALID_REQUEST }
      );
      assert.throws(
        () => store.beginBootstrap({ project_id: 'p1', operation_id: 'op'.repeat(65), audit_subject_id: 's1', thread_id: 't1', workspace_state_observed: 'ws1' }),
        { code: RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_INVALID_REQUEST }
      );
      store.close();
      console.log('PASS: ARS-007 — Operation ID bounds validation enforced');
    } finally {
      cleanupTempDir(dir);
    }
  }

  // ARS-008: Valid transition: PROVISIONAL_THREAD -> FIRST_TURN_STARTING
  {
    const { dir, dbPath } = createTempDbPath();
    try {
      const store = createSqliteAuditorRecoveryStore({ dbPath });
      store.beginBootstrap({
        project_id: 'proj-alpha',
        operation_id: 'op-001',
        audit_subject_id: 'sub-01',
        thread_id: 'thr_1',
        workspace_state_observed: 'ws_1'
      });

      const updated = store.transitionState({
        project_id: 'proj-alpha',
        operation_id: 'op-001',
        next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_STARTING
      });
      assert.strictEqual(updated.state, AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_STARTING);

      const history = store.getHistory('proj-alpha', 'op-001');
      assert.strictEqual(history.length, 2);
      assert.strictEqual(history[1].previous_state, AUDITOR_BOOTSTRAP_STATES.PROVISIONAL_THREAD);
      assert.strictEqual(history[1].next_state, AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_STARTING);
      store.close();
      console.log('PASS: ARS-008 — Valid transition PROVISIONAL_THREAD -> FIRST_TURN_STARTING');
    } finally {
      cleanupTempDir(dir);
    }
  }

  // ARS-009: Valid transition: FIRST_TURN_STARTING -> FIRST_TURN_IN_FLIGHT with turn_id patch
  {
    const { dir, dbPath } = createTempDbPath();
    try {
      const store = createSqliteAuditorRecoveryStore({ dbPath });
      store.beginBootstrap({
        project_id: 'proj-alpha',
        operation_id: 'op-001',
        audit_subject_id: 'sub-01',
        thread_id: 'thr_1',
        workspace_state_observed: 'ws_1'
      });
      store.transitionState({
        project_id: 'proj-alpha',
        operation_id: 'op-001',
        next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_STARTING
      });

      const inFlight = store.transitionState({
        project_id: 'proj-alpha',
        operation_id: 'op-001',
        next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_IN_FLIGHT,
        patch: { turn_id: 'turn_abc_123' }
      });
      assert.strictEqual(inFlight.state, AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_IN_FLIGHT);
      assert.strictEqual(inFlight.turn_id, 'turn_abc_123');
      store.close();
      console.log('PASS: ARS-009 — Valid transition FIRST_TURN_STARTING -> FIRST_TURN_IN_FLIGHT with turn_id');
    } finally {
      cleanupTempDir(dir);
    }
  }

  // ARS-010: Illegal transitions rejected fail-closed
  {
    const { dir, dbPath } = createTempDbPath();
    try {
      const store = createSqliteAuditorRecoveryStore({ dbPath });
      store.beginBootstrap({
        project_id: 'proj-alpha',
        operation_id: 'op-001',
        audit_subject_id: 'sub-01',
        thread_id: 'thr_1',
        workspace_state_observed: 'ws_1'
      });

      // Cannot jump from PROVISIONAL_THREAD to DECISION_VALIDATED
      assert.throws(
        () => store.transitionState({
          project_id: 'proj-alpha',
          operation_id: 'op-001',
          next_state: AUDITOR_BOOTSTRAP_STATES.DECISION_VALIDATED
        }),
        { code: RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_INVALID_TRANSITION }
      );

      // State remains PROVISIONAL_THREAD
      const active = store.getActiveBootstrap('proj-alpha');
      assert.strictEqual(active.state, AUDITOR_BOOTSTRAP_STATES.PROVISIONAL_THREAD);
      store.close();
      console.log('PASS: ARS-010 — Illegal state transitions rejected fail-closed');
    } finally {
      cleanupTempDir(dir);
    }
  }

  // ARS-011: Transition with operation_id mismatch rejected
  {
    const { dir, dbPath } = createTempDbPath();
    try {
      const store = createSqliteAuditorRecoveryStore({ dbPath });
      store.beginBootstrap({
        project_id: 'proj-alpha',
        operation_id: 'op-001',
        audit_subject_id: 'sub-01',
        thread_id: 'thr_1',
        workspace_state_observed: 'ws_1'
      });

      assert.throws(
        () => store.transitionState({
          project_id: 'proj-alpha',
          operation_id: 'op-wrong-id',
          next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_STARTING
        }),
        { code: RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_BOOTSTRAP_CONFLICT }
      );
      store.close();
      console.log('PASS: ARS-011 — Transition with operation_id mismatch rejected');
    } finally {
      cleanupTempDir(dir);
    }
  }

  // ARS-012: Transition on unknown project rejected
  {
    const { dir, dbPath } = createTempDbPath();
    try {
      const store = createSqliteAuditorRecoveryStore({ dbPath });
      assert.throws(
        () => store.transitionState({
          project_id: 'nonexistent-proj',
          operation_id: 'op-001',
          next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_STARTING
        }),
        { code: RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_NOT_FOUND }
      );
      store.close();
      console.log('PASS: ARS-012 — Transition on unknown project rejected');
    } finally {
      cleanupTempDir(dir);
    }
  }

  // ARS-013: Valid transition to DECISION_VALIDATED stores decision JSON and verifies hash
  {
    const { dir, dbPath } = createTempDbPath();
    try {
      const store = createSqliteAuditorRecoveryStore({ dbPath });
      const ctx = {
        project_id: 'proj-alpha',
        audit_subject_id: 'sub-01',
        auditor_thread_id: 'thr_1',
        workspace_state_observed: 'ws_1'
      };

      store.beginBootstrap({
        project_id: ctx.project_id,
        operation_id: 'op-001',
        audit_subject_id: ctx.audit_subject_id,
        thread_id: ctx.auditor_thread_id,
        workspace_state_observed: ctx.workspace_state_observed
      });
      store.transitionState({
        project_id: ctx.project_id,
        operation_id: 'op-001',
        next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_STARTING
      });
      store.transitionState({
        project_id: ctx.project_id,
        operation_id: 'op-001',
        next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_IN_FLIGHT,
        patch: { turn_id: 'turn_1' }
      });

      const decisionObj = makeValidDecision(ctx);
      const decisionJson = JSON.stringify(decisionObj);
      const decisionSha256 = crypto.createHash('sha256').update(decisionJson, 'utf8').digest('hex');

      const validated = store.transitionState({
        project_id: ctx.project_id,
        operation_id: 'op-001',
        next_state: AUDITOR_BOOTSTRAP_STATES.DECISION_VALIDATED,
        patch: {
          decision_json: decisionJson,
          decision_sha256: decisionSha256
        }
      });

      assert.strictEqual(validated.state, AUDITOR_BOOTSTRAP_STATES.DECISION_VALIDATED);
      assert.strictEqual(validated.decision_sha256, decisionSha256);
      assert.ok(validated.validated_decision !== null);
      assert.strictEqual(validated.validated_decision.decision, AUDIT_DECISIONS.DISPATCH_WORKER);
      store.close();
      console.log('PASS: ARS-013 — Valid transition to DECISION_VALIDATED with decision hash verification');
    } finally {
      cleanupTempDir(dir);
    }
  }

  // ARS-014: Storing invalid decision JSON rejected during transitionState
  {
    const { dir, dbPath } = createTempDbPath();
    try {
      const store = createSqliteAuditorRecoveryStore({ dbPath });
      store.beginBootstrap({
        project_id: 'proj-alpha',
        operation_id: 'op-001',
        audit_subject_id: 'sub-01',
        thread_id: 'thr_1',
        workspace_state_observed: 'ws_1'
      });
      store.transitionState({
        project_id: 'proj-alpha',
        operation_id: 'op-001',
        next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_STARTING
      });
      store.transitionState({
        project_id: 'proj-alpha',
        operation_id: 'op-001',
        next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_IN_FLIGHT,
        patch: { turn_id: 'turn_1' }
      });

      // Context mismatch in decision (wrong project_id)
      const badDecisionJson = JSON.stringify({
        ...makeValidDecision({
          project_id: 'wrong-proj',
          audit_subject_id: 'sub-01',
          auditor_thread_id: 'thr_1',
          workspace_state_observed: 'ws_1'
        })
      });

      assert.throws(
        () => store.transitionState({
          project_id: 'proj-alpha',
          operation_id: 'op-001',
          next_state: AUDITOR_BOOTSTRAP_STATES.DECISION_VALIDATED,
          patch: { decision_json: badDecisionJson }
        }),
        { code: 'AUDIT_DECISION_CONTEXT_MISMATCH' }
      );
      store.close();
      console.log('PASS: ARS-014 — Storing context-mismatched decision JSON rejected during transition');
    } finally {
      cleanupTempDir(dir);
    }
  }

  // ARS-015: Storing mismatched decision SHA-256 rejected
  {
    const { dir, dbPath } = createTempDbPath();
    try {
      const store = createSqliteAuditorRecoveryStore({ dbPath });
      const ctx = {
        project_id: 'proj-alpha',
        audit_subject_id: 'sub-01',
        auditor_thread_id: 'thr_1',
        workspace_state_observed: 'ws_1'
      };
      store.beginBootstrap({
        project_id: ctx.project_id,
        operation_id: 'op-001',
        audit_subject_id: ctx.audit_subject_id,
        thread_id: ctx.auditor_thread_id,
        workspace_state_observed: ctx.workspace_state_observed
      });
      store.transitionState({
        project_id: ctx.project_id,
        operation_id: 'op-001',
        next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_STARTING
      });
      store.transitionState({
        project_id: ctx.project_id,
        operation_id: 'op-001',
        next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_IN_FLIGHT,
        patch: { turn_id: 'turn_1' }
      });

      const decisionJson = JSON.stringify(makeValidDecision(ctx));
      const bogusSha256 = 'a'.repeat(64);

      assert.throws(
        () => store.transitionState({
          project_id: ctx.project_id,
          operation_id: 'op-001',
          next_state: AUDITOR_BOOTSTRAP_STATES.DECISION_VALIDATED,
          patch: {
            decision_json: decisionJson,
            decision_sha256: bogusSha256
          }
        }),
        { code: RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_INVALID_REQUEST }
      );
      store.close();
      console.log('PASS: ARS-015 — Storing mismatched decision SHA-256 rejected');
    } finally {
      cleanupTempDir(dir);
    }
  }

  // ARS-016: Complete sequential lifecycle through REGISTRY_BINDING
  {
    const { dir, dbPath } = createTempDbPath();
    try {
      const store = createSqliteAuditorRecoveryStore({ dbPath });
      const ctx = {
        project_id: 'proj-alpha',
        audit_subject_id: 'sub-01',
        auditor_thread_id: 'thr_1',
        workspace_state_observed: 'ws_1'
      };

      store.beginBootstrap({
        project_id: ctx.project_id,
        operation_id: 'op-001',
        audit_subject_id: ctx.audit_subject_id,
        thread_id: ctx.auditor_thread_id,
        workspace_state_observed: ctx.workspace_state_observed
      });
      store.transitionState({
        project_id: ctx.project_id,
        operation_id: 'op-001',
        next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_STARTING
      });
      store.transitionState({
        project_id: ctx.project_id,
        operation_id: 'op-001',
        next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_IN_FLIGHT,
        patch: { turn_id: 'turn_1' }
      });
      store.transitionState({
        project_id: ctx.project_id,
        operation_id: 'op-001',
        next_state: AUDITOR_BOOTSTRAP_STATES.DECISION_VALIDATED,
        patch: { decision_json: JSON.stringify(makeValidDecision(ctx)) }
      });
      store.transitionState({
        project_id: ctx.project_id,
        operation_id: 'op-001',
        next_state: AUDITOR_BOOTSTRAP_STATES.RESUME_VERIFYING
      });
      store.transitionState({
        project_id: ctx.project_id,
        operation_id: 'op-001',
        next_state: AUDITOR_BOOTSTRAP_STATES.RESUME_VERIFIED
      });
      const binding = store.transitionState({
        project_id: ctx.project_id,
        operation_id: 'op-001',
        next_state: AUDITOR_BOOTSTRAP_STATES.REGISTRY_BINDING
      });

      assert.strictEqual(binding.state, AUDITOR_BOOTSTRAP_STATES.REGISTRY_BINDING);

      const history = store.getHistory(ctx.project_id, 'op-001');
      assert.strictEqual(history.length, 7);
      assert.strictEqual(history[6].next_state, AUDITOR_BOOTSTRAP_STATES.REGISTRY_BINDING);
      store.close();
      console.log('PASS: ARS-016 — Complete sequential lifecycle through REGISTRY_BINDING verified');
    } finally {
      cleanupTempDir(dir);
    }
  }

  // ARS-017: Delete active bootstrap row upon successful bind cleanup
  {
    const { dir, dbPath } = createTempDbPath();
    try {
      const store = createSqliteAuditorRecoveryStore({ dbPath });
      store.beginBootstrap({
        project_id: 'proj-alpha',
        operation_id: 'op-001',
        audit_subject_id: 'sub-01',
        thread_id: 'thr_1',
        workspace_state_observed: 'ws_1'
      });

      const res = store.deleteActiveBootstrap('proj-alpha', 'op-001');
      assert.strictEqual(res.ok, true);
      assert.strictEqual(res.deleted, true);

      // Active row is gone
      const active = store.getActiveBootstrap('proj-alpha');
      assert.strictEqual(active, null);

      // History is preserved
      const history = store.getHistory('proj-alpha', 'op-001');
      assert.strictEqual(history.length, 1);
      store.close();
      console.log('PASS: ARS-017 — Delete active bootstrap removes row and retains history');
    } finally {
      cleanupTempDir(dir);
    }
  }

  // ARS-018: Deleting nonexistent bootstrap is a safe no-op
  {
    const { dir, dbPath } = createTempDbPath();
    try {
      const store = createSqliteAuditorRecoveryStore({ dbPath });
      const res = store.deleteActiveBootstrap('nonexistent-proj', 'op-001');
      assert.strictEqual(res.ok, true);
      assert.strictEqual(res.deleted, false);
      store.close();
      console.log('PASS: ARS-018 — Deleting nonexistent bootstrap is safe no-op');
    } finally {
      cleanupTempDir(dir);
    }
  }

  // ARS-019: Deleting bootstrap with operation_id mismatch rejected
  {
    const { dir, dbPath } = createTempDbPath();
    try {
      const store = createSqliteAuditorRecoveryStore({ dbPath });
      store.beginBootstrap({
        project_id: 'proj-alpha',
        operation_id: 'op-001',
        audit_subject_id: 'sub-01',
        thread_id: 'thr_1',
        workspace_state_observed: 'ws_1'
      });

      assert.throws(
        () => store.deleteActiveBootstrap('proj-alpha', 'op-different'),
        { code: RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_BOOTSTRAP_CONFLICT }
      );
      store.close();
      console.log('PASS: ARS-019 — Deleting bootstrap with mismatched operation_id rejected');
    } finally {
      cleanupTempDir(dir);
    }
  }

  // ARS-020: Restart / reopen persistence preserves state and history losslessly
  {
    const { dir, dbPath } = createTempDbPath();
    try {
      const store1 = createSqliteAuditorRecoveryStore({ dbPath });
      const ctx = {
        project_id: 'proj-alpha',
        audit_subject_id: 'sub-01',
        auditor_thread_id: 'thr_1',
        workspace_state_observed: 'ws_1'
      };
      store1.beginBootstrap({
        project_id: ctx.project_id,
        operation_id: 'op-001',
        audit_subject_id: ctx.audit_subject_id,
        thread_id: ctx.auditor_thread_id,
        workspace_state_observed: ctx.workspace_state_observed
      });
      store1.transitionState({
        project_id: ctx.project_id,
        operation_id: 'op-001',
        next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_STARTING
      });
      store1.transitionState({
        project_id: ctx.project_id,
        operation_id: 'op-001',
        next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_IN_FLIGHT,
        patch: { turn_id: 'turn_99' }
      });
      store1.transitionState({
        project_id: ctx.project_id,
        operation_id: 'op-001',
        next_state: AUDITOR_BOOTSTRAP_STATES.DECISION_VALIDATED,
        patch: { decision_json: JSON.stringify(makeValidDecision(ctx)) }
      });
      store1.close();

      // Reopen with fresh instance
      const store2 = createSqliteAuditorRecoveryStore({ dbPath });
      const active = store2.getActiveBootstrap(ctx.project_id);
      assert.ok(active !== null);
      assert.strictEqual(active.state, AUDITOR_BOOTSTRAP_STATES.DECISION_VALIDATED);
      assert.strictEqual(active.turn_id, 'turn_99');
      assert.ok(active.validated_decision !== null);
      assert.strictEqual(active.validated_decision.decision, AUDIT_DECISIONS.DISPATCH_WORKER);

      const history = store2.getHistory(ctx.project_id, 'op-001');
      assert.strictEqual(history.length, 4);
      assert.strictEqual(history[3].next_state, AUDITOR_BOOTSTRAP_STATES.DECISION_VALIDATED);
      store2.close();
      console.log('PASS: ARS-020 — Restart/reopen persistence preserves state, decision, and history');
    } finally {
      cleanupTempDir(dir);
    }
  }

  // ARS-021: Reopening DB with corrupted decision hash fails closed with AUDITOR_RECOVERY_CORRUPT
  {
    const { dir, dbPath } = createTempDbPath();
    try {
      const store1 = createSqliteAuditorRecoveryStore({ dbPath });
      const ctx = {
        project_id: 'proj-alpha',
        audit_subject_id: 'sub-01',
        auditor_thread_id: 'thr_1',
        workspace_state_observed: 'ws_1'
      };
      store1.beginBootstrap({
        project_id: ctx.project_id,
        operation_id: 'op-001',
        audit_subject_id: ctx.audit_subject_id,
        thread_id: ctx.auditor_thread_id,
        workspace_state_observed: ctx.workspace_state_observed
      });
      store1.transitionState({
        project_id: ctx.project_id,
        operation_id: 'op-001',
        next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_STARTING
      });
      store1.transitionState({
        project_id: ctx.project_id,
        operation_id: 'op-001',
        next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_IN_FLIGHT,
        patch: { turn_id: 'turn_1' }
      });
      store1.transitionState({
        project_id: ctx.project_id,
        operation_id: 'op-001',
        next_state: AUDITOR_BOOTSTRAP_STATES.DECISION_VALIDATED,
        patch: { decision_json: JSON.stringify(makeValidDecision(ctx)) }
      });
      store1.close();

      // Corrupt the decision_sha256 directly in sqlite
      const { DatabaseSync } = require('node:sqlite');
      const rawDb = new DatabaseSync(dbPath);
      rawDb.exec(`UPDATE auditor_bootstrap SET decision_sha256 = '${'0'.repeat(64)}' WHERE project_id = 'proj-alpha'`);
      rawDb.close();

      assert.throws(
        () => createSqliteAuditorRecoveryStore({ dbPath }),
        { code: RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_CORRUPT }
      );
      console.log('PASS: ARS-021 — Reopening DB with corrupt decision hash fails closed');
    } finally {
      cleanupTempDir(dir);
    }
  }

  // ARS-022: Reopening DB with corrupt decision JSON body fails closed
  {
    const { dir, dbPath } = createTempDbPath();
    try {
      const store1 = createSqliteAuditorRecoveryStore({ dbPath });
      const ctx = {
        project_id: 'proj-alpha',
        audit_subject_id: 'sub-01',
        auditor_thread_id: 'thr_1',
        workspace_state_observed: 'ws_1'
      };
      store1.beginBootstrap({
        project_id: ctx.project_id,
        operation_id: 'op-001',
        audit_subject_id: ctx.audit_subject_id,
        thread_id: ctx.auditor_thread_id,
        workspace_state_observed: ctx.workspace_state_observed
      });
      store1.transitionState({
        project_id: ctx.project_id,
        operation_id: 'op-001',
        next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_STARTING
      });
      store1.transitionState({
        project_id: ctx.project_id,
        operation_id: 'op-001',
        next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_IN_FLIGHT,
        patch: { turn_id: 'turn_1' }
      });
      store1.transitionState({
        project_id: ctx.project_id,
        operation_id: 'op-001',
        next_state: AUDITOR_BOOTSTRAP_STATES.DECISION_VALIDATED,
        patch: { decision_json: JSON.stringify(makeValidDecision(ctx)) }
      });
      store1.close();

      // Replace decision_json with valid hash but invalid decision schema
      const corruptJson = '{"decision":"UNKNOWN"}';
      const corruptHash = crypto.createHash('sha256').update(corruptJson, 'utf8').digest('hex');
      const { DatabaseSync } = require('node:sqlite');
      const rawDb = new DatabaseSync(dbPath);
      rawDb.exec(`UPDATE auditor_bootstrap SET decision_json = '${corruptJson}', decision_sha256 = '${corruptHash}' WHERE project_id = 'proj-alpha'`);
      rawDb.close();

      assert.throws(
        () => createSqliteAuditorRecoveryStore({ dbPath }),
        { code: RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_CORRUPT }
      );
      console.log('PASS: ARS-022 — Reopening DB with corrupt decision JSON body fails closed');
    } finally {
      cleanupTempDir(dir);
    }
  }

  // ARS-023: Reopening DB with unrecognized state fails closed
  {
    const { dir, dbPath } = createTempDbPath();
    try {
      const store1 = createSqliteAuditorRecoveryStore({ dbPath });
      store1.beginBootstrap({
        project_id: 'proj-alpha',
        operation_id: 'op-001',
        audit_subject_id: 'sub-01',
        thread_id: 'thr_1',
        workspace_state_observed: 'ws_1'
      });
      store1.close();

      const { DatabaseSync } = require('node:sqlite');
      const rawDb = new DatabaseSync(dbPath);
      rawDb.exec("UPDATE auditor_bootstrap SET state = 'HACKED_STATE' WHERE project_id = 'proj-alpha'");
      rawDb.close();

      assert.throws(
        () => createSqliteAuditorRecoveryStore({ dbPath }),
        { code: RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_CORRUPT }
      );
      console.log('PASS: ARS-023 — Reopening DB with unrecognized state fails closed');
    } finally {
      cleanupTempDir(dir);
    }
  }

  // ARS-024: State disagreement between active bootstrap and latest history row fails closed
  {
    const { dir, dbPath } = createTempDbPath();
    try {
      const store1 = createSqliteAuditorRecoveryStore({ dbPath });
      store1.beginBootstrap({
        project_id: 'proj-alpha',
        operation_id: 'op-001',
        audit_subject_id: 'sub-01',
        thread_id: 'thr_1',
        workspace_state_observed: 'ws_1'
      });
      store1.close();

      const { DatabaseSync } = require('node:sqlite');
      const rawDb = new DatabaseSync(dbPath);
      rawDb.exec(`UPDATE auditor_bootstrap SET state = '${AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_STARTING}' WHERE project_id = 'proj-alpha'`);
      rawDb.close();

      assert.throws(
        () => createSqliteAuditorRecoveryStore({ dbPath }),
        { code: RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_CORRUPT }
      );
      console.log('PASS: ARS-024 — State disagreement between active bootstrap and history fails closed');
    } finally {
      cleanupTempDir(dir);
    }
  }

  // ARS-025: Unsupported user_version rejected
  {
    const { dir, dbPath } = createTempDbPath();
    try {
      const store1 = createSqliteAuditorRecoveryStore({ dbPath });
      store1.close();

      const { DatabaseSync } = require('node:sqlite');
      const rawDb = new DatabaseSync(dbPath);
      rawDb.exec('PRAGMA user_version = 99;');
      rawDb.close();

      assert.throws(
        () => createSqliteAuditorRecoveryStore({ dbPath }),
        { code: RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_SCHEMA_INVALID }
      );
      console.log('PASS: ARS-025 — Unsupported user_version rejected');
    } finally {
      cleanupTempDir(dir);
    }
  }

  // ARS-026: User version 0 with existing tables rejected
  {
    const { dir, dbPath } = createTempDbPath();
    try {
      const store1 = createSqliteAuditorRecoveryStore({ dbPath });
      store1.close();

      const { DatabaseSync } = require('node:sqlite');
      const rawDb = new DatabaseSync(dbPath);
      rawDb.exec('PRAGMA user_version = 0;');
      rawDb.close();

      assert.throws(
        () => createSqliteAuditorRecoveryStore({ dbPath }),
        { code: RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_SCHEMA_INVALID }
      );
      console.log('PASS: ARS-026 — User version 0 with existing tables rejected');
    } finally {
      cleanupTempDir(dir);
    }
  }

  // ARS-027: Missing required table rejected
  {
    const { dir, dbPath } = createTempDbPath();
    try {
      const store1 = createSqliteAuditorRecoveryStore({ dbPath });
      store1.close();

      const { DatabaseSync } = require('node:sqlite');
      const rawDb = new DatabaseSync(dbPath);
      rawDb.exec('DROP TABLE auditor_bootstrap_history;');
      rawDb.close();

      assert.throws(
        () => createSqliteAuditorRecoveryStore({ dbPath }),
        { code: RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_SCHEMA_INVALID }
      );
      console.log('PASS: ARS-027 — Missing required table rejected');
    } finally {
      cleanupTempDir(dir);
    }
  }

  // ARS-028: Operations on closed store throw AUDITOR_RECOVERY_CLOSED
  {
    const { dir, dbPath } = createTempDbPath();
    try {
      const store = createSqliteAuditorRecoveryStore({ dbPath });
      store.close();

      assert.throws(
        () => store.listActiveBootstraps(),
        { code: RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_CLOSED }
      );
      assert.throws(
        () => store.getActiveBootstrap('p1'),
        { code: RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_CLOSED }
      );
      assert.throws(
        () => store.beginBootstrap({ project_id: 'p1', operation_id: 'o1', audit_subject_id: 's1', thread_id: 't1', workspace_state_observed: 'w1' }),
        { code: RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_CLOSED }
      );
      console.log('PASS: ARS-028 — Operations on closed store throw AUDITOR_RECOVERY_CLOSED');
    } finally {
      cleanupTempDir(dir);
    }
  }

  // ARS-029: Multiple calls to close() are idempotent
  {
    const { dir, dbPath } = createTempDbPath();
    try {
      const store = createSqliteAuditorRecoveryStore({ dbPath });
      store.close();
      store.close(); // No throw
      console.log('PASS: ARS-029 — Idempotent close() calls succeed');
    } finally {
      cleanupTempDir(dir);
    }
  }

  // ARS-030: Transition to AUDIT_UNCERTAIN from PROVISIONAL_THREAD
  {
    const { dir, dbPath } = createTempDbPath();
    try {
      const store = createSqliteAuditorRecoveryStore({ dbPath });
      store.beginBootstrap({
        project_id: 'proj-alpha',
        operation_id: 'op-001',
        audit_subject_id: 'sub-01',
        thread_id: 'thr_1',
        workspace_state_observed: 'ws_1'
      });

      const uncertain = store.transitionState({
        project_id: 'proj-alpha',
        operation_id: 'op-001',
        next_state: AUDITOR_BOOTSTRAP_STATES.AUDIT_UNCERTAIN,
        metadata: { reason: 'Adapter failed' }
      });
      assert.strictEqual(uncertain.state, AUDITOR_BOOTSTRAP_STATES.AUDIT_UNCERTAIN);

      const history = store.getHistory('proj-alpha', 'op-001');
      assert.strictEqual(history[1].next_state, AUDITOR_BOOTSTRAP_STATES.AUDIT_UNCERTAIN);
      assert.strictEqual(history[1].metadata.reason, 'Adapter failed');
      store.close();
      console.log('PASS: ARS-030 — Transition to AUDIT_UNCERTAIN from PROVISIONAL_THREAD');
    } finally {
      cleanupTempDir(dir);
    }
  }

  // ARS-031: Transition to AUDIT_UNCERTAIN from FIRST_TURN_STARTING
  {
    const { dir, dbPath } = createTempDbPath();
    try {
      const store = createSqliteAuditorRecoveryStore({ dbPath });
      store.beginBootstrap({
        project_id: 'proj-alpha',
        operation_id: 'op-001',
        audit_subject_id: 'sub-01',
        thread_id: 'thr_1',
        workspace_state_observed: 'ws_1'
      });
      store.transitionState({
        project_id: 'proj-alpha',
        operation_id: 'op-001',
        next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_STARTING
      });
      const uncertain = store.transitionState({
        project_id: 'proj-alpha',
        operation_id: 'op-001',
        next_state: AUDITOR_BOOTSTRAP_STATES.AUDIT_UNCERTAIN
      });
      assert.strictEqual(uncertain.state, AUDITOR_BOOTSTRAP_STATES.AUDIT_UNCERTAIN);
      store.close();
      console.log('PASS: ARS-031 — Transition to AUDIT_UNCERTAIN from FIRST_TURN_STARTING');
    } finally {
      cleanupTempDir(dir);
    }
  }

  // ARS-032: Transition to AUDIT_UNCERTAIN from FIRST_TURN_IN_FLIGHT
  {
    const { dir, dbPath } = createTempDbPath();
    try {
      const store = createSqliteAuditorRecoveryStore({ dbPath });
      store.beginBootstrap({
        project_id: 'proj-alpha',
        operation_id: 'op-001',
        audit_subject_id: 'sub-01',
        thread_id: 'thr_1',
        workspace_state_observed: 'ws_1'
      });
      store.transitionState({
        project_id: 'proj-alpha',
        operation_id: 'op-001',
        next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_STARTING
      });
      store.transitionState({
        project_id: 'proj-alpha',
        operation_id: 'op-001',
        next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_IN_FLIGHT,
        patch: { turn_id: 'turn_1' }
      });
      const uncertain = store.transitionState({
        project_id: 'proj-alpha',
        operation_id: 'op-001',
        next_state: AUDITOR_BOOTSTRAP_STATES.AUDIT_UNCERTAIN
      });
      assert.strictEqual(uncertain.state, AUDITOR_BOOTSTRAP_STATES.AUDIT_UNCERTAIN);
      store.close();
      console.log('PASS: ARS-032 — Transition to AUDIT_UNCERTAIN from FIRST_TURN_IN_FLIGHT');
    } finally {
      cleanupTempDir(dir);
    }
  }

  // ARS-033: Transition to AUDIT_UNCERTAIN from RESUME_VERIFYING
  {
    const { dir, dbPath } = createTempDbPath();
    try {
      const store = createSqliteAuditorRecoveryStore({ dbPath });
      const ctx = {
        project_id: 'proj-alpha',
        audit_subject_id: 'sub-01',
        auditor_thread_id: 'thr_1',
        workspace_state_observed: 'ws_1'
      };
      store.beginBootstrap({
        project_id: ctx.project_id,
        operation_id: 'op-001',
        audit_subject_id: ctx.audit_subject_id,
        thread_id: ctx.auditor_thread_id,
        workspace_state_observed: ctx.workspace_state_observed
      });
      store.transitionState({ project_id: ctx.project_id, operation_id: 'op-001', next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_STARTING });
      store.transitionState({ project_id: ctx.project_id, operation_id: 'op-001', next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_IN_FLIGHT, patch: { turn_id: 'turn_1' } });
      store.transitionState({ project_id: ctx.project_id, operation_id: 'op-001', next_state: AUDITOR_BOOTSTRAP_STATES.DECISION_VALIDATED, patch: { decision_json: JSON.stringify(makeValidDecision(ctx)) } });
      store.transitionState({ project_id: ctx.project_id, operation_id: 'op-001', next_state: AUDITOR_BOOTSTRAP_STATES.RESUME_VERIFYING });

      const uncertain = store.transitionState({
        project_id: ctx.project_id,
        operation_id: 'op-001',
        next_state: AUDITOR_BOOTSTRAP_STATES.AUDIT_UNCERTAIN
      });
      assert.strictEqual(uncertain.state, AUDITOR_BOOTSTRAP_STATES.AUDIT_UNCERTAIN);
      store.close();
      console.log('PASS: ARS-033 — Transition to AUDIT_UNCERTAIN from RESUME_VERIFYING');
    } finally {
      cleanupTempDir(dir);
    }
  }

  // ARS-034: No transitions allowed out of AUDIT_UNCERTAIN
  {
    const { dir, dbPath } = createTempDbPath();
    try {
      const store = createSqliteAuditorRecoveryStore({ dbPath });
      store.beginBootstrap({
        project_id: 'proj-alpha',
        operation_id: 'op-001',
        audit_subject_id: 'sub-01',
        thread_id: 'thr_1',
        workspace_state_observed: 'ws_1'
      });
      store.transitionState({
        project_id: 'proj-alpha',
        operation_id: 'op-001',
        next_state: AUDITOR_BOOTSTRAP_STATES.AUDIT_UNCERTAIN
      });

      assert.throws(
        () => store.transitionState({
          project_id: 'proj-alpha',
          operation_id: 'op-001',
          next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_STARTING
        }),
        { code: RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_INVALID_TRANSITION }
      );
      store.close();
      console.log('PASS: ARS-034 — No transitions allowed out of AUDIT_UNCERTAIN');
    } finally {
      cleanupTempDir(dir);
    }
  }

  // ARS-035: Oversized decision JSON (> 128 KiB) rejected
  {
    const { dir, dbPath } = createTempDbPath();
    try {
      const store = createSqliteAuditorRecoveryStore({ dbPath });
      const ctx = {
        project_id: 'proj-alpha',
        audit_subject_id: 'sub-01',
        auditor_thread_id: 'thr_1',
        workspace_state_observed: 'ws_1'
      };
      store.beginBootstrap({
        project_id: ctx.project_id,
        operation_id: 'op-001',
        audit_subject_id: ctx.audit_subject_id,
        thread_id: ctx.auditor_thread_id,
        workspace_state_observed: ctx.workspace_state_observed
      });
      store.transitionState({ project_id: ctx.project_id, operation_id: 'op-001', next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_STARTING });
      store.transitionState({ project_id: ctx.project_id, operation_id: 'op-001', next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_IN_FLIGHT, patch: { turn_id: 'turn_1' } });

      const oversizedJson = '{"summary":"' + 'x'.repeat(130 * 1024) + '"}';
      assert.throws(
        () => store.transitionState({
          project_id: ctx.project_id,
          operation_id: 'op-001',
          next_state: AUDITOR_BOOTSTRAP_STATES.DECISION_VALIDATED,
          patch: { decision_json: oversizedJson }
        }),
        { code: RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_INVALID_REQUEST }
      );
      store.close();
      console.log('PASS: ARS-035 — Oversized decision JSON (> 128 KiB) rejected');
    } finally {
      cleanupTempDir(dir);
    }
  }

  // ARS-036: Non-string decision JSON rejected
  {
    const { dir, dbPath } = createTempDbPath();
    try {
      const store = createSqliteAuditorRecoveryStore({ dbPath });
      const ctx = { project_id: 'proj-alpha', audit_subject_id: 'sub-01', auditor_thread_id: 'thr_1', workspace_state_observed: 'ws_1' };
      store.beginBootstrap({ project_id: ctx.project_id, operation_id: 'op-001', audit_subject_id: ctx.audit_subject_id, thread_id: ctx.auditor_thread_id, workspace_state_observed: ctx.workspace_state_observed });
      store.transitionState({ project_id: ctx.project_id, operation_id: 'op-001', next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_STARTING });
      store.transitionState({ project_id: ctx.project_id, operation_id: 'op-001', next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_IN_FLIGHT, patch: { turn_id: 'turn_1' } });

      assert.throws(
        () => store.transitionState({
          project_id: ctx.project_id,
          operation_id: 'op-001',
          next_state: AUDITOR_BOOTSTRAP_STATES.DECISION_VALIDATED,
          patch: { decision_json: 12345 }
        }),
        { code: RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_INVALID_REQUEST }
      );
      store.close();
      console.log('PASS: ARS-036 — Non-string decision JSON rejected');
    } finally {
      cleanupTempDir(dir);
    }
  }

  // ARS-037: Caller mutating returned record cannot mutate store state
  {
    const { dir, dbPath } = createTempDbPath();
    try {
      const store = createSqliteAuditorRecoveryStore({ dbPath });
      const row = store.beginBootstrap({
        project_id: 'proj-alpha',
        operation_id: 'op-001',
        audit_subject_id: 'sub-01',
        thread_id: 'thr_1',
        workspace_state_observed: 'ws_1'
      });
      row.state = 'MUTATED';
      row.thread_id = 'MUTATED_THREAD';

      const readBack = store.getActiveBootstrap('proj-alpha');
      assert.strictEqual(readBack.state, AUDITOR_BOOTSTRAP_STATES.PROVISIONAL_THREAD);
      assert.strictEqual(readBack.thread_id, 'thr_1');
      store.close();
      console.log('PASS: ARS-037 — Returned records are detached and immutable to caller mutation');
    } finally {
      cleanupTempDir(dir);
    }
  }

  // ARS-038: Custom clock integration verified
  {
    const { dir, dbPath } = createTempDbPath();
    try {
      let syntheticTime = 1700000000000;
      const customClock = {
        now: () => syntheticTime,
        iso: () => new Date(syntheticTime).toISOString()
      };
      const store = createSqliteAuditorRecoveryStore({ dbPath, clock: customClock });
      store.beginBootstrap({
        project_id: 'proj-alpha',
        operation_id: 'op-001',
        audit_subject_id: 'sub-01',
        thread_id: 'thr_1',
        workspace_state_observed: 'ws_1'
      });

      const history = store.getHistory('proj-alpha', 'op-001');
      assert.strictEqual(history[0].timestamp, 1700000000000);
      assert.strictEqual(history[0].iso, new Date(1700000000000).toISOString());
      store.close();
      console.log('PASS: ARS-038 — Custom clock integration verified');
    } finally {
      cleanupTempDir(dir);
    }
  }

  // ARS-039: Top-level turn_id rejected (Section 25 / Section 3)
  {
    const { dir, dbPath } = createTempDbPath();
    try {
      const store = createSqliteAuditorRecoveryStore({ dbPath });
      store.beginBootstrap({
        project_id: 'proj-alpha',
        operation_id: 'op-001',
        audit_subject_id: 'sub-01',
        thread_id: 'thr_1',
        workspace_state_observed: 'ws_1'
      });
      store.transitionState({
        project_id: 'proj-alpha',
        operation_id: 'op-001',
        next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_STARTING
      });

      assert.throws(
        () => store.transitionState({
          project_id: 'proj-alpha',
          operation_id: 'op-001',
          next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_IN_FLIGHT,
          turn_id: 'turn_1'
        }),
        { code: RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_INVALID_REQUEST }
      );
      store.close();
      console.log('PASS: ARS-039 — Top-level turn_id rejected with AUDITOR_RECOVERY_INVALID_REQUEST');
    } finally {
      cleanupTempDir(dir);
    }
  }

  // ARS-040: Top-level decision_json or decision_sha256 rejected (Section 25 / Section 3)
  {
    const { dir, dbPath } = createTempDbPath();
    try {
      const store = createSqliteAuditorRecoveryStore({ dbPath });
      const ctx = { project_id: 'proj-alpha', audit_subject_id: 'sub-01', auditor_thread_id: 'thr_1', workspace_state_observed: 'ws_1' };
      store.beginBootstrap({ project_id: ctx.project_id, operation_id: 'op-001', audit_subject_id: ctx.audit_subject_id, thread_id: ctx.auditor_thread_id, workspace_state_observed: ctx.workspace_state_observed });
      store.transitionState({ project_id: ctx.project_id, operation_id: 'op-001', next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_STARTING });
      store.transitionState({ project_id: ctx.project_id, operation_id: 'op-001', next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_IN_FLIGHT, patch: { turn_id: 'turn_1' } });

      assert.throws(
        () => store.transitionState({
          project_id: ctx.project_id,
          operation_id: 'op-001',
          next_state: AUDITOR_BOOTSTRAP_STATES.DECISION_VALIDATED,
          decision_json: JSON.stringify(makeValidDecision(ctx))
        }),
        { code: RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_INVALID_REQUEST }
      );
      assert.throws(
        () => store.transitionState({
          project_id: ctx.project_id,
          operation_id: 'op-001',
          next_state: AUDITOR_BOOTSTRAP_STATES.DECISION_VALIDATED,
          decision_sha256: 'a'.repeat(64)
        }),
        { code: RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_INVALID_REQUEST }
      );
      store.close();
      console.log('PASS: ARS-040 — Top-level decision fields rejected with AUDITOR_RECOVERY_INVALID_REQUEST');
    } finally {
      cleanupTempDir(dir);
    }
  }

  // ARS-041: Unknown patch keys rejected (Section 4)
  {
    const { dir, dbPath } = createTempDbPath();
    try {
      const store = createSqliteAuditorRecoveryStore({ dbPath });
      store.beginBootstrap({ project_id: 'proj-alpha', operation_id: 'op-001', audit_subject_id: 'sub-01', thread_id: 'thr_1', workspace_state_observed: 'ws_1' });
      store.transitionState({ project_id: 'proj-alpha', operation_id: 'op-001', next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_STARTING });

      assert.throws(
        () => store.transitionState({
          project_id: 'proj-alpha',
          operation_id: 'op-001',
          next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_IN_FLIGHT,
          patch: { turn_id: 'turn_1', rogue_field: 123 }
        }),
        { code: RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_INVALID_REQUEST }
      );
      store.close();
      console.log('PASS: ARS-041 — Unknown patch keys rejected with AUDITOR_RECOVERY_INVALID_REQUEST');
    } finally {
      cleanupTempDir(dir);
    }
  }

  // ARS-042: Non-empty patch on PROVISIONAL -> FIRST_TURN_STARTING rejected (Section 5)
  {
    const { dir, dbPath } = createTempDbPath();
    try {
      const store = createSqliteAuditorRecoveryStore({ dbPath });
      store.beginBootstrap({ project_id: 'proj-alpha', operation_id: 'op-001', audit_subject_id: 'sub-01', thread_id: 'thr_1', workspace_state_observed: 'ws_1' });

      assert.throws(
        () => store.transitionState({
          project_id: 'proj-alpha',
          operation_id: 'op-001',
          next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_STARTING,
          patch: { turn_id: 'turn_1' }
        }),
        { code: RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_INVALID_REQUEST }
      );
      store.close();
      console.log('PASS: ARS-042 — Non-empty patch on PROVISIONAL -> FIRST_TURN_STARTING rejected');
    } finally {
      cleanupTempDir(dir);
    }
  }

  // ARS-043: STARTING -> IN_FLIGHT without patch.turn_id rejected (Section 5)
  {
    const { dir, dbPath } = createTempDbPath();
    try {
      const store = createSqliteAuditorRecoveryStore({ dbPath });
      store.beginBootstrap({ project_id: 'proj-alpha', operation_id: 'op-001', audit_subject_id: 'sub-01', thread_id: 'thr_1', workspace_state_observed: 'ws_1' });
      store.transitionState({ project_id: 'proj-alpha', operation_id: 'op-001', next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_STARTING });

      assert.throws(
        () => store.transitionState({
          project_id: 'proj-alpha',
          operation_id: 'op-001',
          next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_IN_FLIGHT
        }),
        { code: RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_INVALID_REQUEST }
      );
      store.close();
      console.log('PASS: ARS-043 — STARTING -> IN_FLIGHT without turn_id rejected');
    } finally {
      cleanupTempDir(dir);
    }
  }

  // ARS-044: STARTING -> IN_FLIGHT with decision fields forbidden (Section 5)
  {
    const { dir, dbPath } = createTempDbPath();
    try {
      const store = createSqliteAuditorRecoveryStore({ dbPath });
      store.beginBootstrap({ project_id: 'proj-alpha', operation_id: 'op-001', audit_subject_id: 'sub-01', thread_id: 'thr_1', workspace_state_observed: 'ws_1' });
      store.transitionState({ project_id: 'proj-alpha', operation_id: 'op-001', next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_STARTING });

      assert.throws(
        () => store.transitionState({
          project_id: 'proj-alpha',
          operation_id: 'op-001',
          next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_IN_FLIGHT,
          patch: { turn_id: 'turn_1', decision_json: '{}' }
        }),
        { code: RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_INVALID_REQUEST }
      );
      store.close();
      console.log('PASS: ARS-044 — STARTING -> IN_FLIGHT with decision fields rejected');
    } finally {
      cleanupTempDir(dir);
    }
  }

  // ARS-045: IN_FLIGHT -> DECISION_VALIDATED without decision_json rejected (Section 5)
  {
    const { dir, dbPath } = createTempDbPath();
    try {
      const store = createSqliteAuditorRecoveryStore({ dbPath });
      store.beginBootstrap({ project_id: 'proj-alpha', operation_id: 'op-001', audit_subject_id: 'sub-01', thread_id: 'thr_1', workspace_state_observed: 'ws_1' });
      store.transitionState({ project_id: 'proj-alpha', operation_id: 'op-001', next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_STARTING });
      store.transitionState({ project_id: 'proj-alpha', operation_id: 'op-001', next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_IN_FLIGHT, patch: { turn_id: 'turn_1' } });

      assert.throws(
        () => store.transitionState({
          project_id: 'proj-alpha',
          operation_id: 'op-001',
          next_state: AUDITOR_BOOTSTRAP_STATES.DECISION_VALIDATED
        }),
        { code: RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_INVALID_REQUEST }
      );
      store.close();
      console.log('PASS: ARS-045 — IN_FLIGHT -> DECISION_VALIDATED without decision_json rejected');
    } finally {
      cleanupTempDir(dir);
    }
  }

  // ARS-046: Corrupt in-flight reopen test: turn_id == null fails reopen (Section 28 / Section 6)
  {
    const { dir, dbPath } = createTempDbPath();
    try {
      const store1 = createSqliteAuditorRecoveryStore({ dbPath });
      store1.beginBootstrap({
        project_id: 'proj-alpha',
        operation_id: 'op-001',
        audit_subject_id: 'sub-01',
        thread_id: 'thr_1',
        workspace_state_observed: 'ws_1'
      });
      store1.transitionState({
        project_id: 'proj-alpha',
        operation_id: 'op-001',
        next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_STARTING
      });
      store1.transitionState({
        project_id: 'proj-alpha',
        operation_id: 'op-001',
        next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_IN_FLIGHT,
        patch: { turn_id: 'turn_1' }
      });
      store1.close();

      const { DatabaseSync } = require('node:sqlite');
      const rawDb = new DatabaseSync(dbPath);
      rawDb.exec("UPDATE auditor_bootstrap SET turn_id = NULL WHERE project_id = 'proj-alpha'");
      rawDb.close();

      assert.throws(
        () => createSqliteAuditorRecoveryStore({ dbPath }),
        { code: RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_CORRUPT }
      );
      console.log('PASS: ARS-046 — Corrupt in-flight reopen with turn_id=null fails closed');
    } finally {
      cleanupTempDir(dir);
    }
  }

  // ARS-047: Corrupt DECISION_VALIDATED reopen test: decision_json = null, decision_sha256 = null (Section 27 / Section 6)
  {
    const { dir, dbPath } = createTempDbPath();
    try {
      const store1 = createSqliteAuditorRecoveryStore({ dbPath });
      const ctx = {
        project_id: 'proj-alpha',
        audit_subject_id: 'sub-01',
        auditor_thread_id: 'thr_1',
        workspace_state_observed: 'ws_1'
      };
      store1.beginBootstrap({
        project_id: ctx.project_id,
        operation_id: 'op-001',
        audit_subject_id: ctx.audit_subject_id,
        thread_id: ctx.auditor_thread_id,
        workspace_state_observed: ctx.workspace_state_observed
      });
      store1.transitionState({
        project_id: ctx.project_id,
        operation_id: 'op-001',
        next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_STARTING
      });
      store1.transitionState({
        project_id: ctx.project_id,
        operation_id: 'op-001',
        next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_IN_FLIGHT,
        patch: { turn_id: 'turn_1' }
      });
      store1.transitionState({
        project_id: ctx.project_id,
        operation_id: 'op-001',
        next_state: AUDITOR_BOOTSTRAP_STATES.DECISION_VALIDATED,
        patch: { decision_json: JSON.stringify(makeValidDecision(ctx)) }
      });
      store1.close();

      const { DatabaseSync } = require('node:sqlite');
      const rawDb = new DatabaseSync(dbPath);
      rawDb.exec("UPDATE auditor_bootstrap SET decision_json = NULL, decision_sha256 = NULL WHERE project_id = 'proj-alpha'");
      rawDb.close();

      assert.throws(
        () => createSqliteAuditorRecoveryStore({ dbPath }),
        { code: RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_CORRUPT }
      );
      console.log('PASS: ARS-047 — DECISION_VALIDATED with null decision fields fails reopen');
    } finally {
      cleanupTempDir(dir);
    }
  }

  // ARS-048: Broken history chain test: row.previous_state != prev.next_state (Section 29 / Section 8)
  {
    const { dir, dbPath } = createTempDbPath();
    try {
      const store1 = createSqliteAuditorRecoveryStore({ dbPath });
      store1.beginBootstrap({
        project_id: 'proj-alpha',
        operation_id: 'op-001',
        audit_subject_id: 'sub-01',
        thread_id: 'thr_1',
        workspace_state_observed: 'ws_1'
      });
      store1.transitionState({
        project_id: 'proj-alpha',
        operation_id: 'op-001',
        next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_STARTING
      });
      store1.close();

      const { DatabaseSync } = require('node:sqlite');
      const rawDb = new DatabaseSync(dbPath);
      rawDb.exec("UPDATE auditor_bootstrap_history SET previous_state = 'CORRUPT_PREV' WHERE history_seq = 2");
      rawDb.close();

      assert.throws(
        () => createSqliteAuditorRecoveryStore({ dbPath }),
        { code: RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_CORRUPT }
      );
      console.log('PASS: ARS-048 — Broken history transition chain fails reopen');
    } finally {
      cleanupTempDir(dir);
    }
  }

  // ARS-049: Persisted ID bounds revalidation on reopen (Section 9)
  {
    const { dir, dbPath } = createTempDbPath();
    try {
      const store1 = createSqliteAuditorRecoveryStore({ dbPath });
      store1.beginBootstrap({
        project_id: 'proj-alpha',
        operation_id: 'op-001',
        audit_subject_id: 'sub-01',
        thread_id: 'thr_1',
        workspace_state_observed: 'ws_1'
      });
      store1.close();

      const { DatabaseSync } = require('node:sqlite');
      const rawDb = new DatabaseSync(dbPath);
      rawDb.prepare("UPDATE auditor_bootstrap SET thread_id = ? WHERE project_id = ?").run('bad\x01thread', 'proj-alpha');
      rawDb.close();

      assert.throws(
        () => createSqliteAuditorRecoveryStore({ dbPath }),
        { code: RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_CORRUPT }
      );
      console.log('PASS: ARS-049 — Control character in persisted thread_id fails reopen');
    } finally {
      cleanupTempDir(dir);
    }
  }

  // ARS-050: Schema drift with unexpected column fails reopen (Section 12)
  {
    const { dir, dbPath } = createTempDbPath();
    try {
      const store1 = createSqliteAuditorRecoveryStore({ dbPath });
      store1.close();

      const { DatabaseSync } = require('node:sqlite');
      const rawDb = new DatabaseSync(dbPath);
      rawDb.exec("ALTER TABLE auditor_bootstrap ADD COLUMN rogue_column TEXT");
      rawDb.close();

      assert.throws(
        () => createSqliteAuditorRecoveryStore({ dbPath }),
        { code: RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_SCHEMA_INVALID }
      );
      console.log('PASS: ARS-050 — Schema drift with rogue column fails reopen');
    } finally {
      cleanupTempDir(dir);
    }
  }

  // ARS-051: Physical integrity check fails on corrupted database file (Section 11)
  {
    const { dir, dbPath } = createTempDbPath();
    try {
      const store1 = createSqliteAuditorRecoveryStore({ dbPath });
      store1.close();

      // Corrupt database bytes directly
      const buf = fs.readFileSync(dbPath);
      buf.fill(0xff, 100, 200);
      fs.writeFileSync(dbPath, buf);

      assert.throws(
        () => createSqliteAuditorRecoveryStore({ dbPath }),
        { code: RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_CORRUPT }
      );
      console.log('PASS: ARS-051 — Physical integrity check failure fails reopen');
    } finally {
      cleanupTempDir(dir);
    }
  }

  // ARS-052: AUDIT_UNCERTAIN -> AUDIT_TERMINAL_NO_DECISION accepted with empty patch
  {
    const { dir, dbPath } = createTempDbPath();
    try {
      const store = createSqliteAuditorRecoveryStore({ dbPath });
      store.beginBootstrap({ project_id: 'proj-alpha', operation_id: 'op-001', audit_subject_id: 'sub-01', thread_id: 'thr_1', workspace_state_observed: 'ws_1' });
      store.transitionState({ project_id: 'proj-alpha', operation_id: 'op-001', next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_STARTING });
      store.transitionState({ project_id: 'proj-alpha', operation_id: 'op-001', next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_IN_FLIGHT, patch: { turn_id: 'turn_1' } });
      store.transitionState({ project_id: 'proj-alpha', operation_id: 'op-001', next_state: AUDITOR_BOOTSTRAP_STATES.AUDIT_UNCERTAIN });

      store.transitionState({
        project_id: 'proj-alpha',
        operation_id: 'op-001',
        next_state: AUDITOR_BOOTSTRAP_STATES.AUDIT_TERMINAL_NO_DECISION,
        patch: {}
      });

      const active = store.getActiveBootstrap('proj-alpha');
      assert.strictEqual(active.state, AUDITOR_BOOTSTRAP_STATES.AUDIT_TERMINAL_NO_DECISION);
      assert.strictEqual(active.turn_id, 'turn_1');
      assert.strictEqual(active.decision_json, null);
      assert.strictEqual(active.decision_sha256, null);

      store.close();
      console.log('PASS: ARS-052 — AUDIT_UNCERTAIN -> AUDIT_TERMINAL_NO_DECISION accepted with empty patch');
    } finally {
      cleanupTempDir(dir);
    }
  }

  // ARS-053: AUDIT_UNCERTAIN -> AUDIT_TERMINAL_NO_DECISION requires existing turn_id in active record
  {
    const { dir, dbPath } = createTempDbPath();
    try {
      const store = createSqliteAuditorRecoveryStore({ dbPath });
      store.beginBootstrap({ project_id: 'proj-alpha', operation_id: 'op-001', audit_subject_id: 'sub-01', thread_id: 'thr_1', workspace_state_observed: 'ws_1' });
      // Transition directly to AUDIT_UNCERTAIN without turn_id
      store.transitionState({ project_id: 'proj-alpha', operation_id: 'op-001', next_state: AUDITOR_BOOTSTRAP_STATES.AUDIT_UNCERTAIN });

      assert.throws(
        () => store.transitionState({
          project_id: 'proj-alpha',
          operation_id: 'op-001',
          next_state: AUDITOR_BOOTSTRAP_STATES.AUDIT_TERMINAL_NO_DECISION
        }),
        { code: RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_INVALID_REQUEST }
      );

      store.close();
      console.log('PASS: ARS-053 — AUDIT_UNCERTAIN -> AUDIT_TERMINAL_NO_DECISION requires existing turn_id in active record');
    } finally {
      cleanupTempDir(dir);
    }
  }

  // ARS-054: Decision fields forbidden for AUDIT_TERMINAL_NO_DECISION
  {
    const { dir, dbPath } = createTempDbPath();
    try {
      const store = createSqliteAuditorRecoveryStore({ dbPath });
      store.beginBootstrap({ project_id: 'proj-alpha', operation_id: 'op-001', audit_subject_id: 'sub-01', thread_id: 'thr_1', workspace_state_observed: 'ws_1' });
      store.transitionState({ project_id: 'proj-alpha', operation_id: 'op-001', next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_STARTING });
      store.transitionState({ project_id: 'proj-alpha', operation_id: 'op-001', next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_IN_FLIGHT, patch: { turn_id: 'turn_1' } });
      store.transitionState({ project_id: 'proj-alpha', operation_id: 'op-001', next_state: AUDITOR_BOOTSTRAP_STATES.AUDIT_UNCERTAIN });

      assert.throws(
        () => store.transitionState({
          project_id: 'proj-alpha',
          operation_id: 'op-001',
          next_state: AUDITOR_BOOTSTRAP_STATES.AUDIT_TERMINAL_NO_DECISION,
          patch: { decision_json: '{}' }
        }),
        { code: RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_INVALID_REQUEST }
      );

      store.close();
      console.log('PASS: ARS-054 — Decision fields forbidden for AUDIT_TERMINAL_NO_DECISION');
    } finally {
      cleanupTempDir(dir);
    }
  }

  // ARS-055: Transition to AUDIT_TERMINAL_NO_DECISION from non-AUDIT_UNCERTAIN state rejected
  {
    const { dir, dbPath } = createTempDbPath();
    try {
      const store = createSqliteAuditorRecoveryStore({ dbPath });
      store.beginBootstrap({ project_id: 'proj-alpha', operation_id: 'op-001', audit_subject_id: 'sub-01', thread_id: 'thr_1', workspace_state_observed: 'ws_1' });
      store.transitionState({ project_id: 'proj-alpha', operation_id: 'op-001', next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_STARTING });
      store.transitionState({ project_id: 'proj-alpha', operation_id: 'op-001', next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_IN_FLIGHT, patch: { turn_id: 'turn_1' } });

      assert.throws(
        () => store.transitionState({
          project_id: 'proj-alpha',
          operation_id: 'op-001',
          next_state: AUDITOR_BOOTSTRAP_STATES.AUDIT_TERMINAL_NO_DECISION
        }),
        { code: RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_INVALID_TRANSITION }
      );

      store.close();
      console.log('PASS: ARS-055 — Transition to AUDIT_TERMINAL_NO_DECISION from non-AUDIT_UNCERTAIN rejected');
    } finally {
      cleanupTempDir(dir);
    }
  }

  // ARS-056: AUDIT_TERMINAL_NO_DECISION persisted semantics accepted on reopen
  {
    const { dir, dbPath } = createTempDbPath();
    try {
      const store1 = createSqliteAuditorRecoveryStore({ dbPath });
      store1.beginBootstrap({ project_id: 'proj-alpha', operation_id: 'op-001', audit_subject_id: 'sub-01', thread_id: 'thr_1', workspace_state_observed: 'ws_1' });
      store1.transitionState({ project_id: 'proj-alpha', operation_id: 'op-001', next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_STARTING });
      store1.transitionState({ project_id: 'proj-alpha', operation_id: 'op-001', next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_IN_FLIGHT, patch: { turn_id: 'turn_1' } });
      store1.transitionState({ project_id: 'proj-alpha', operation_id: 'op-001', next_state: AUDITOR_BOOTSTRAP_STATES.AUDIT_UNCERTAIN });
      store1.transitionState({ project_id: 'proj-alpha', operation_id: 'op-001', next_state: AUDITOR_BOOTSTRAP_STATES.AUDIT_TERMINAL_NO_DECISION });
      store1.close();

      const store2 = createSqliteAuditorRecoveryStore({ dbPath });
      const active = store2.getActiveBootstrap('proj-alpha');
      assert.strictEqual(active.state, AUDITOR_BOOTSTRAP_STATES.AUDIT_TERMINAL_NO_DECISION);
      assert.strictEqual(active.turn_id, 'turn_1');
      assert.strictEqual(active.decision_json, null);
      store2.close();

      console.log('PASS: ARS-056 — AUDIT_TERMINAL_NO_DECISION persisted semantics accepted on reopen');
    } finally {
      cleanupTempDir(dir);
    }
  }

  // ARS-057: History chain with AUDIT_TERMINAL_NO_DECISION accepted on reopen
  {
    const { dir, dbPath } = createTempDbPath();
    try {
      const store1 = createSqliteAuditorRecoveryStore({ dbPath });
      store1.beginBootstrap({ project_id: 'proj-alpha', operation_id: 'op-001', audit_subject_id: 'sub-01', thread_id: 'thr_1', workspace_state_observed: 'ws_1' });
      store1.transitionState({ project_id: 'proj-alpha', operation_id: 'op-001', next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_STARTING });
      store1.transitionState({ project_id: 'proj-alpha', operation_id: 'op-001', next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_IN_FLIGHT, patch: { turn_id: 'turn_1' } });
      store1.transitionState({ project_id: 'proj-alpha', operation_id: 'op-001', next_state: AUDITOR_BOOTSTRAP_STATES.AUDIT_UNCERTAIN });
      store1.transitionState({ project_id: 'proj-alpha', operation_id: 'op-001', next_state: AUDITOR_BOOTSTRAP_STATES.AUDIT_TERMINAL_NO_DECISION });
      store1.close();

      const store2 = createSqliteAuditorRecoveryStore({ dbPath });
      const history = store2.getBootstrapHistory('proj-alpha', 'op-001');
      assert.strictEqual(history.length, 5);
      assert.strictEqual(history[0].next_state, 'PROVISIONAL_THREAD');
      assert.strictEqual(history[1].next_state, 'FIRST_TURN_STARTING');
      assert.strictEqual(history[2].next_state, 'FIRST_TURN_IN_FLIGHT');
      assert.strictEqual(history[3].next_state, 'AUDIT_UNCERTAIN');
      assert.strictEqual(history[4].next_state, 'AUDIT_TERMINAL_NO_DECISION');
      store2.close();

      console.log('PASS: ARS-057 — History chain with AUDIT_TERMINAL_NO_DECISION accepted on reopen');
    } finally {
      cleanupTempDir(dir);
    }
  }

  // ARS-058: Invalid AUDIT_TERMINAL_NO_DECISION row fails reopen
  {
    const { dir, dbPath } = createTempDbPath();
    try {
      const store1 = createSqliteAuditorRecoveryStore({ dbPath });
      store1.beginBootstrap({ project_id: 'proj-alpha', operation_id: 'op-001', audit_subject_id: 'sub-01', thread_id: 'thr_1', workspace_state_observed: 'ws_1' });
      store1.transitionState({ project_id: 'proj-alpha', operation_id: 'op-001', next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_STARTING });
      store1.transitionState({ project_id: 'proj-alpha', operation_id: 'op-001', next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_IN_FLIGHT, patch: { turn_id: 'turn_1' } });
      store1.transitionState({ project_id: 'proj-alpha', operation_id: 'op-001', next_state: AUDITOR_BOOTSTRAP_STATES.AUDIT_UNCERTAIN });
      store1.transitionState({ project_id: 'proj-alpha', operation_id: 'op-001', next_state: AUDITOR_BOOTSTRAP_STATES.AUDIT_TERMINAL_NO_DECISION });
      store1.close();

      // Corrupt row by nulling turn_id
      const { DatabaseSync } = require('node:sqlite');
      const rawDb = new DatabaseSync(dbPath);
      rawDb.exec("UPDATE auditor_bootstrap SET turn_id = NULL WHERE project_id = 'proj-alpha'");
      rawDb.close();

      assert.throws(
        () => createSqliteAuditorRecoveryStore({ dbPath }),
        { code: RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_CORRUPT }
      );

      console.log('PASS: ARS-058 — Invalid AUDIT_TERMINAL_NO_DECISION row fails reopen');
    } finally {
      cleanupTempDir(dir);
    }
  }

  // ARS-059: AUDIT_UNCERTAIN -> DECISION_VALIDATED accepted only with valid stored turn_id and decision patch
  {
    const { dir, dbPath } = createTempDbPath();
    try {
      const store = createSqliteAuditorRecoveryStore({ dbPath });
      const ctx = {
        project_id: 'proj-alpha',
        audit_subject_id: 'sub-01',
        auditor_thread_id: 'thr_1',
        workspace_state_observed: 'ws_1'
      };
      store.beginBootstrap({
        project_id: ctx.project_id,
        operation_id: 'op-001',
        audit_subject_id: ctx.audit_subject_id,
        thread_id: ctx.auditor_thread_id,
        workspace_state_observed: ctx.workspace_state_observed
      });
      store.transitionState({ project_id: ctx.project_id, operation_id: 'op-001', next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_STARTING });
      store.transitionState({ project_id: ctx.project_id, operation_id: 'op-001', next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_IN_FLIGHT, patch: { turn_id: 'turn_1' } });
      store.transitionState({ project_id: ctx.project_id, operation_id: 'op-001', next_state: AUDITOR_BOOTSTRAP_STATES.AUDIT_UNCERTAIN });

      const decObj = makeValidDecision(ctx);
      const decJson = JSON.stringify(decObj);
      const decHash = crypto.createHash('sha256').update(decJson).digest('hex');

      store.transitionState({
        project_id: ctx.project_id,
        operation_id: 'op-001',
        next_state: AUDITOR_BOOTSTRAP_STATES.DECISION_VALIDATED,
        patch: {
          decision_json: decJson,
          decision_sha256: decHash
        }
      });

      const active = store.getActiveBootstrap(ctx.project_id);
      assert.strictEqual(active.state, AUDITOR_BOOTSTRAP_STATES.DECISION_VALIDATED);
      assert.strictEqual(active.turn_id, 'turn_1');
      assert.strictEqual(active.decision_sha256, decHash);

      store.close();
      console.log('PASS: ARS-059 — AUDIT_UNCERTAIN -> DECISION_VALIDATED accepted with valid decision patch');
    } finally {
      cleanupTempDir(dir);
    }
  }

  // ARS-060: Invalid decision or mismatched hash rejected on AUDIT_UNCERTAIN -> DECISION_VALIDATED
  {
    const { dir, dbPath } = createTempDbPath();
    try {
      const store = createSqliteAuditorRecoveryStore({ dbPath });
      const ctx = {
        project_id: 'proj-alpha',
        audit_subject_id: 'sub-01',
        auditor_thread_id: 'thr_1',
        workspace_state_observed: 'ws_1'
      };
      store.beginBootstrap({
        project_id: ctx.project_id,
        operation_id: 'op-001',
        audit_subject_id: ctx.audit_subject_id,
        thread_id: ctx.auditor_thread_id,
        workspace_state_observed: ctx.workspace_state_observed
      });
      store.transitionState({ project_id: ctx.project_id, operation_id: 'op-001', next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_STARTING });
      store.transitionState({ project_id: ctx.project_id, operation_id: 'op-001', next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_IN_FLIGHT, patch: { turn_id: 'turn_1' } });
      store.transitionState({ project_id: ctx.project_id, operation_id: 'op-001', next_state: AUDITOR_BOOTSTRAP_STATES.AUDIT_UNCERTAIN });

      // Mismatched hash
      assert.throws(
        () => store.transitionState({
          project_id: ctx.project_id,
          operation_id: 'op-001',
          next_state: AUDITOR_BOOTSTRAP_STATES.DECISION_VALIDATED,
          patch: {
            decision_json: JSON.stringify(makeValidDecision(ctx)),
            decision_sha256: '0000000000000000000000000000000000000000000000000000000000000000'
          }
        }),
        { code: RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_INVALID_REQUEST }
      );

      // Context mismatch (wrong thread ID in decision)
      const badCtxDecision = makeValidDecision({ ...ctx, auditor_thread_id: 'wrong-thr' });
      const badJson = JSON.stringify(badCtxDecision);
      assert.throws(
        () => store.transitionState({
          project_id: ctx.project_id,
          operation_id: 'op-001',
          next_state: AUDITOR_BOOTSTRAP_STATES.DECISION_VALIDATED,
          patch: {
            decision_json: badJson
          }
        }),
        (err) => err && err.code === 'AUDIT_DECISION_CONTEXT_MISMATCH'
      );

      store.close();
      console.log('PASS: ARS-060 — Invalid decision or mismatched hash rejected on AUDIT_UNCERTAIN -> DECISION_VALIDATED');
    } finally {
      cleanupTempDir(dir);
    }
  }

  // ARS-061: Existing schema-v1 database containing only pre-05AG states opens successfully
  {
    const { dir, dbPath } = createTempDbPath();
    try {
      const store1 = createSqliteAuditorRecoveryStore({ dbPath });
      store1.beginBootstrap({ project_id: 'proj-pre', operation_id: 'op-pre', audit_subject_id: 'sub-pre', thread_id: 'thr_pre', workspace_state_observed: 'ws_pre' });
      store1.transitionState({ project_id: 'proj-pre', operation_id: 'op-pre', next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_STARTING });
      store1.transitionState({ project_id: 'proj-pre', operation_id: 'op-pre', next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_IN_FLIGHT, patch: { turn_id: 'turn_pre' } });
      store1.transitionState({ project_id: 'proj-pre', operation_id: 'op-pre', next_state: AUDITOR_BOOTSTRAP_STATES.AUDIT_UNCERTAIN });
      store1.close();

      // Open again: schema version is 1 and all pre-05AG states open successfully
      const store2 = createSqliteAuditorRecoveryStore({ dbPath });
      const active = store2.getActiveBootstrap('proj-pre');
      assert.strictEqual(active.state, 'AUDIT_UNCERTAIN');
      assert.strictEqual(active.turn_id, 'turn_pre');
      store2.close();

      console.log('PASS: ARS-061 — Existing schema-v1 database containing only pre-05AG states opens successfully');
    } finally {
      cleanupTempDir(dir);
    }
  }

  // =========================================================================
  // CATEGORY 15: SCHEMA V2 IMMUTABLE BOOTSTRAP AUTHORITY & LEGACY RETIREMENT (ARS-062 .. ARS-078)
  // =========================================================================

  // ARS-062: Fresh DB created directly as schema v2 with 4 new columns and user_version = 2
  {
    const { dir, dbPath } = createTempDbPath();
    try {
      const store = createSqliteAuditorRecoveryStoreRaw({ dbPath });
      store.close();

      const { DatabaseSync } = require('node:sqlite');
      const rawDb = new DatabaseSync(dbPath);
      const userVersion = rawDb.prepare('PRAGMA user_version;').get().user_version;
      assert.strictEqual(userVersion, 2);

      const cols = rawDb.prepare("PRAGMA table_info('auditor_bootstrap');").all().map(c => c.name);
      assert.ok(cols.includes('authority_version'));
      assert.ok(cols.includes('expected_project_root'));
      assert.ok(cols.includes('expected_project_root_identity'));
      assert.ok(cols.includes('expected_auditor_model_policy'));
      rawDb.close();

      console.log('PASS: ARS-062 — Fresh DB created directly as schema v2 with 4 new columns and user_version = 2');
    } finally {
      cleanupTempDir(dir);
    }
  }

  // Helper to create a genuine V1 database with pre-migration data
  function createGenuineV1Database(dbPath, { withRow = true, state = 'DECISION_VALIDATED', corrupt = null } = {}) {
    const { DatabaseSync } = require('node:sqlite');
    const rawDb = new DatabaseSync(dbPath);
    rawDb.exec(`
      CREATE TABLE auditor_bootstrap (
        project_id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL UNIQUE,
        audit_subject_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        turn_id TEXT,
        workspace_state_observed TEXT NOT NULL,
        state TEXT NOT NULL,
        decision_json TEXT,
        decision_sha256 TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE auditor_bootstrap_history (
        history_seq INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        previous_state TEXT,
        next_state TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        iso TEXT NOT NULL,
        metadata TEXT
      );
      CREATE UNIQUE INDEX idx_auditor_bootstrap_op
        ON auditor_bootstrap(operation_id);
      CREATE INDEX idx_auditor_history_project
        ON auditor_bootstrap_history(project_id);
      CREATE INDEX idx_auditor_history_op
        ON auditor_bootstrap_history(operation_id);
      PRAGMA user_version = 1;
    `);

    if (corrupt === 'rogue_col') {
      rawDb.exec('ALTER TABLE auditor_bootstrap ADD COLUMN rogue TEXT;');
    }

    if (withRow) {
      const ctx = {
        project_id: 'proj-legacy-01',
        audit_subject_id: 'subj-legacy-01',
        auditor_thread_id: 'thr-legacy-01',
        workspace_state_observed: 'ws-legacy-01'
      };
      const d = makeValidDecision(ctx);
      const dJson = JSON.stringify(d);
      const dHash = crypto.createHash('sha256').update(dJson, 'utf8').digest('hex');
      const nowIso = new Date().toISOString();

      rawDb.prepare(`
        INSERT INTO auditor_bootstrap (
          project_id, operation_id, audit_subject_id, thread_id, turn_id,
          workspace_state_observed, state, decision_json, decision_sha256,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'proj-legacy-01', 'op-legacy-01', 'subj-legacy-01', 'thr-legacy-01', 'turn-legacy-01',
        'ws-legacy-01', state, dJson, dHash,
        nowIso, nowIso
      );

      rawDb.prepare(`
        INSERT INTO auditor_bootstrap_history (
          project_id, operation_id, previous_state, next_state, timestamp, iso, metadata
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('proj-legacy-01', 'op-legacy-01', null, 'PROVISIONAL_THREAD', 1700000000000, nowIso, null);

      if (corrupt === 'broken_history') {
        rawDb.prepare(`
          INSERT INTO auditor_bootstrap_history (
            project_id, operation_id, previous_state, next_state, timestamp, iso, metadata
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run('proj-legacy-01', 'op-legacy-01', 'RESUME_VERIFIED', state, 1700000001000, nowIso, null);
      } else {
        rawDb.prepare(`
          INSERT INTO auditor_bootstrap_history (
            project_id, operation_id, previous_state, next_state, timestamp, iso, metadata
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run('proj-legacy-01', 'op-legacy-01', 'PROVISIONAL_THREAD', 'FIRST_TURN_STARTING', 1700000000100, nowIso, null);

        rawDb.prepare(`
          INSERT INTO auditor_bootstrap_history (
            project_id, operation_id, previous_state, next_state, timestamp, iso, metadata
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run('proj-legacy-01', 'op-legacy-01', 'FIRST_TURN_STARTING', 'FIRST_TURN_IN_FLIGHT', 1700000000200, nowIso, null);

        rawDb.prepare(`
          INSERT INTO auditor_bootstrap_history (
            project_id, operation_id, previous_state, next_state, timestamp, iso, metadata
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run('proj-legacy-01', 'op-legacy-01', 'FIRST_TURN_IN_FLIGHT', state, 1700000001000, nowIso, null);
      }
    }
    rawDb.close();
  }

  // ARS-063: Valid v1 DB migrates transactionally to v2 on store open
  {
    const { dir, dbPath } = createTempDbPath();
    try {
      createGenuineV1Database(dbPath);
      const store = createSqliteAuditorRecoveryStoreRaw({ dbPath });
      assert.ok(store);
      store.close();

      const { DatabaseSync } = require('node:sqlite');
      const rawDb = new DatabaseSync(dbPath);
      assert.strictEqual(rawDb.prepare('PRAGMA user_version;').get().user_version, 2);
      rawDb.close();

      console.log('PASS: ARS-063 — Valid v1 DB migrates transactionally to v2 on store open');
    } finally {
      cleanupTempDir(dir);
    }
  }

  // ARS-064: Migrated v1 active rows have authority_version = 0 and authority fields null
  {
    const { dir, dbPath } = createTempDbPath();
    try {
      createGenuineV1Database(dbPath);
      const store = createSqliteAuditorRecoveryStoreRaw({ dbPath });
      const active = store.getActiveBootstrap('proj-legacy-01');
      assert.strictEqual(active.authority_version, 0);
      assert.strictEqual(active.expected_project_root, null);
      assert.strictEqual(active.expected_project_root_identity, null);
      assert.strictEqual(active.expected_auditor_model_policy, null);
      store.close();

      console.log('PASS: ARS-064 — Migrated v1 active rows have authority_version = 0 and null authority fields');
    } finally {
      cleanupTempDir(dir);
    }
  }

  // ARS-065: Decision JSON, hash, state, and history preserved byte-semantically across migration
  {
    const { dir, dbPath } = createTempDbPath();
    try {
      createGenuineV1Database(dbPath);
      const store = createSqliteAuditorRecoveryStoreRaw({ dbPath });
      const active = store.getActiveBootstrap('proj-legacy-01');
      assert.strictEqual(active.state, 'DECISION_VALIDATED');
      assert.strictEqual(active.turn_id, 'turn-legacy-01');
      assert.ok(active.decision_json.includes('Decision verified cleanly for worker dispatch.'));
      assert.strictEqual(active.decision_sha256, crypto.createHash('sha256').update(active.decision_json, 'utf8').digest('hex'));

      const hist = store.getHistory('proj-legacy-01', 'op-legacy-01');
      assert.strictEqual(hist.length, 4);
      assert.strictEqual(hist[3].next_state, 'DECISION_VALIDATED');
      store.close();

      console.log('PASS: ARS-065 — Decision JSON, hash, state, and history preserved byte-semantically across migration');
    } finally {
      cleanupTempDir(dir);
    }
  }

  // ARS-066: Pre-migration validation: corrupt v1 schema fails closed before migration (user_version remains 1)
  {
    const { dir, dbPath } = createTempDbPath();
    try {
      createGenuineV1Database(dbPath, { corrupt: 'rogue_col' });
      assert.throws(
        () => createSqliteAuditorRecoveryStoreRaw({ dbPath }),
        { code: RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_SCHEMA_INVALID }
      );

      const { DatabaseSync } = require('node:sqlite');
      const rawDb = new DatabaseSync(dbPath);
      assert.strictEqual(rawDb.prepare('PRAGMA user_version;').get().user_version, 1);
      rawDb.close();

      console.log('PASS: ARS-066 — Corrupt v1 schema fails closed before migration; user_version remains 1');
    } finally {
      cleanupTempDir(dir);
    }
  }

  // ARS-067: Pre-migration validation: broken v1 history chain fails closed before migration
  {
    const { dir, dbPath } = createTempDbPath();
    try {
      createGenuineV1Database(dbPath, { corrupt: 'broken_history' });
      assert.throws(
        () => createSqliteAuditorRecoveryStoreRaw({ dbPath }),
        { code: RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_CORRUPT }
      );

      const { DatabaseSync } = require('node:sqlite');
      const rawDb = new DatabaseSync(dbPath);
      assert.strictEqual(rawDb.prepare('PRAGMA user_version;').get().user_version, 1);
      rawDb.close();

      console.log('PASS: ARS-067 — Broken v1 history chain fails closed before migration');
    } finally {
      cleanupTempDir(dir);
    }
  }

  // ARS-068: New beginBootstrap requires authority_version = 1 and non-empty authority fields
  {
    const { dir, dbPath } = createTempDbPath();
    try {
      const store = createSqliteAuditorRecoveryStoreRaw({ dbPath });
      const row = store.beginBootstrap({
        project_id: 'p-v2',
        operation_id: 'op-v2',
        audit_subject_id: 'sub-v2',
        thread_id: 'thr-v2',
        workspace_state_observed: 'ws-v2',
        authority_version: 1,
        expected_project_root: 'd:/TU_CODE/Orchestrator',
        expected_project_root_identity: 'd:/tu_code/orchestrator',
        expected_auditor_model_policy: 'strict-read-only'
      });
      assert.strictEqual(row.authority_version, 1);
      assert.strictEqual(row.expected_project_root, 'd:/TU_CODE/Orchestrator');
      assert.strictEqual(row.expected_project_root_identity, 'd:/tu_code/orchestrator');
      assert.strictEqual(row.expected_auditor_model_policy, 'strict-read-only');
      store.close();

      console.log('PASS: ARS-068 — New beginBootstrap requires authority_version = 1 and persists authority fields');
    } finally {
      cleanupTempDir(dir);
    }
  }

  // ARS-069: Reopen validates authority_version = 1 and non-empty authority fields
  {
    const { dir, dbPath } = createTempDbPath();
    try {
      const store1 = createSqliteAuditorRecoveryStoreRaw({ dbPath });
      store1.beginBootstrap({
        project_id: 'p-v2',
        operation_id: 'op-v2',
        audit_subject_id: 'sub-v2',
        thread_id: 'thr-v2',
        workspace_state_observed: 'ws-v2',
        authority_version: 1,
        expected_project_root: 'd:/TU_CODE/Orchestrator',
        expected_project_root_identity: 'd:/tu_code/orchestrator',
        expected_auditor_model_policy: 'strict-read-only'
      });
      store1.close();

      const store2 = createSqliteAuditorRecoveryStoreRaw({ dbPath });
      const active = store2.getActiveBootstrap('p-v2');
      assert.strictEqual(active.authority_version, 1);
      assert.strictEqual(active.expected_project_root, 'd:/TU_CODE/Orchestrator');
      store2.close();

      console.log('PASS: ARS-069 — Reopen validates authority_version = 1 and non-empty authority fields');
    } finally {
      cleanupTempDir(dir);
    }
  }

  // ARS-070: Reject authority_version = 1 with null/empty root / identity / policy
  {
    const { dir, dbPath } = createTempDbPath();
    try {
      const store = createSqliteAuditorRecoveryStoreRaw({ dbPath });
      // Missing expected_project_root
      assert.throws(
        () => store.beginBootstrap({
          project_id: 'p-v2',
          operation_id: 'op-v2',
          audit_subject_id: 'sub-v2',
          thread_id: 'thr-v2',
          workspace_state_observed: 'ws-v2',
          authority_version: 1,
          expected_project_root: '',
          expected_project_root_identity: 'd:/tu_code/orchestrator',
          expected_auditor_model_policy: 'strict-read-only'
        }),
        { code: RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_INVALID_REQUEST }
      );
      // Missing expected_project_root_identity
      assert.throws(
        () => store.beginBootstrap({
          project_id: 'p-v2',
          operation_id: 'op-v2',
          audit_subject_id: 'sub-v2',
          thread_id: 'thr-v2',
          workspace_state_observed: 'ws-v2',
          authority_version: 1,
          expected_project_root: 'd:/TU_CODE/Orchestrator',
          expected_project_root_identity: null,
          expected_auditor_model_policy: 'strict-read-only'
        }),
        { code: RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_INVALID_REQUEST }
      );
      store.close();
      console.log('PASS: ARS-070 — Reject authority_version = 1 with null/empty authority fields');
    } finally {
      cleanupTempDir(dir);
    }
  }

  // ARS-071: Reject authority_version = 0 for new beginBootstrap
  {
    const { dir, dbPath } = createTempDbPath();
    try {
      const store = createSqliteAuditorRecoveryStoreRaw({ dbPath });
      assert.throws(
        () => store.beginBootstrap({
          project_id: 'p-v2',
          operation_id: 'op-v2',
          audit_subject_id: 'sub-v2',
          thread_id: 'thr-v2',
          workspace_state_observed: 'ws-v2',
          authority_version: 0,
          expected_project_root: null,
          expected_project_root_identity: null,
          expected_auditor_model_policy: null
        }),
        { code: RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_INVALID_REQUEST }
      );
      store.close();
      console.log('PASS: ARS-071 — Reject authority_version = 0 for new beginBootstrap');
    } finally {
      cleanupTempDir(dir);
    }
  }

  // ARS-072: Reject invalid authority_version (< 0 or > 1)
  {
    const { dir, dbPath } = createTempDbPath();
    try {
      const store = createSqliteAuditorRecoveryStoreRaw({ dbPath });
      for (const badVer of [-1, 2, 99, '1', null, undefined]) {
        assert.throws(
          () => store.beginBootstrap({
            project_id: 'p-v2',
            operation_id: 'op-v2',
            audit_subject_id: 'sub-v2',
            thread_id: 'thr-v2',
            workspace_state_observed: 'ws-v2',
            authority_version: badVer,
            expected_project_root: 'd:/TU_CODE/Orchestrator',
            expected_project_root_identity: 'd:/tu_code/orchestrator',
            expected_auditor_model_policy: 'strict-read-only'
          }),
          { code: RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_INVALID_REQUEST }
        );
      }
      store.close();
      console.log('PASS: ARS-072 — Reject invalid authority_version (< 0 or > 1 or non-integer)');
    } finally {
      cleanupTempDir(dir);
    }
  }

  // ARS-073: Immutable authority fields cannot be patched by transitionState
  {
    const { dir, dbPath } = createTempDbPath();
    try {
      const store = createSqliteAuditorRecoveryStoreRaw({ dbPath });
      store.beginBootstrap({
        project_id: 'p-v2',
        operation_id: 'op-v2',
        audit_subject_id: 'sub-v2',
        thread_id: 'thr-v2',
        workspace_state_observed: 'ws-v2',
        authority_version: 1,
        expected_project_root: 'd:/TU_CODE/Orchestrator',
        expected_project_root_identity: 'd:/tu_code/orchestrator',
        expected_auditor_model_policy: 'strict-read-only'
      });

      assert.throws(
        () => store.transitionState({
          project_id: 'p-v2',
          operation_id: 'op-v2',
          next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_STARTING,
          patch: { expected_project_root: '/new/root' }
        }),
        { code: RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_INVALID_REQUEST }
      );
      assert.throws(
        () => store.transitionState({
          project_id: 'p-v2',
          operation_id: 'op-v2',
          next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_STARTING,
          patch: { authority_version: 2 }
        }),
        { code: RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_INVALID_REQUEST }
      );
      store.close();
      console.log('PASS: ARS-073 — Immutable authority fields cannot be patched by transitionState');
    } finally {
      cleanupTempDir(dir);
    }
  }

  // ARS-074: retireLegacyBootstrap succeeds for authority_version = 0 and performs atomic history insert + active row deletion
  {
    const { dir, dbPath } = createTempDbPath();
    try {
      createGenuineV1Database(dbPath);
      const store = createSqliteAuditorRecoveryStoreRaw({ dbPath });
      const res = store.retireLegacyBootstrap('proj-legacy-01', 'op-legacy-01', { reason: 'test_retire' });
      assert.strictEqual(res.ok, true);
      assert.strictEqual(res.status, 'RETIRED_LEGACY_AUTHORITY_UNAVAILABLE');

      assert.strictEqual(store.getActiveBootstrap('proj-legacy-01'), null);

      const hist = store.getHistory('proj-legacy-01', 'op-legacy-01');
      const lastHist = hist[hist.length - 1];
      assert.strictEqual(lastHist.previous_state, 'DECISION_VALIDATED');
      assert.strictEqual(lastHist.next_state, 'LEGACY_AUTHORITY_RETIRED');
      store.close();

      console.log('PASS: ARS-074 — retireLegacyBootstrap succeeds for authority_version = 0');
    } finally {
      cleanupTempDir(dir);
    }
  }

  // ARS-075: retireLegacyBootstrap rejects authority_version = 1
  {
    const { dir, dbPath } = createTempDbPath();
    try {
      const store = createSqliteAuditorRecoveryStoreRaw({ dbPath });
      store.beginBootstrap({
        project_id: 'p-v2',
        operation_id: 'op-v2',
        audit_subject_id: 'sub-v2',
        thread_id: 'thr-v2',
        workspace_state_observed: 'ws-v2',
        authority_version: 1,
        expected_project_root: 'd:/TU_CODE/Orchestrator',
        expected_project_root_identity: 'd:/tu_code/orchestrator',
        expected_auditor_model_policy: 'strict-read-only'
      });

      assert.throws(
        () => store.retireLegacyBootstrap('p-v2', 'op-v2'),
        { code: RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_INVALID_REQUEST }
      );
      assert.ok(store.getActiveBootstrap('p-v2') !== null);
      store.close();
      console.log('PASS: ARS-075 — retireLegacyBootstrap rejects authority_version = 1');
    } finally {
      cleanupTempDir(dir);
    }
  }

  // ARS-076: Generic transitionState cannot transition to LEGACY_AUTHORITY_RETIRED
  {
    const { dir, dbPath } = createTempDbPath();
    try {
      const store = createSqliteAuditorRecoveryStoreRaw({ dbPath });
      store.beginBootstrap({
        project_id: 'p-v2',
        operation_id: 'op-v2',
        audit_subject_id: 'sub-v2',
        thread_id: 'thr-v2',
        workspace_state_observed: 'ws-v2',
        authority_version: 1,
        expected_project_root: 'd:/TU_CODE/Orchestrator',
        expected_project_root_identity: 'd:/tu_code/orchestrator',
        expected_auditor_model_policy: 'strict-read-only'
      });

      assert.throws(
        () => store.transitionState({
          project_id: 'p-v2',
          operation_id: 'op-v2',
          next_state: 'LEGACY_AUTHORITY_RETIRED'
        }),
        { code: RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_INVALID_TRANSITION }
      );
      store.close();
      console.log('PASS: ARS-076 — Generic transitionState cannot transition to LEGACY_AUTHORITY_RETIRED');
    } finally {
      cleanupTempDir(dir);
    }
  }

  // ARS-077: LEGACY_AUTHORITY_RETIRED cannot be followed by any subsequent transition
  {
    const { dir, dbPath } = createTempDbPath();
    try {
      createGenuineV1Database(dbPath);
      const store = createSqliteAuditorRecoveryStoreRaw({ dbPath });
      store.retireLegacyBootstrap('proj-legacy-01', 'op-legacy-01');
      store.close();

      // Corrupt history with an illegal transition after LEGACY_AUTHORITY_RETIRED
      const { DatabaseSync } = require('node:sqlite');
      const rawDb = new DatabaseSync(dbPath);
      rawDb.prepare(`
        INSERT INTO auditor_bootstrap_history (
          project_id, operation_id, previous_state, next_state, timestamp, iso, metadata
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('proj-legacy-01', 'op-legacy-01', 'LEGACY_AUTHORITY_RETIRED', 'PROVISIONAL_THREAD', 1700000002000, new Date().toISOString(), null);
      rawDb.close();

      assert.throws(
        () => createSqliteAuditorRecoveryStoreRaw({ dbPath }),
        { code: RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_CORRUPT }
      );
      console.log('PASS: ARS-077 — LEGACY_AUTHORITY_RETIRED cannot be followed by subsequent transitions');
    } finally {
      cleanupTempDir(dir);
    }
  }

  // ARS-078: retireLegacyBootstrap with operation_id mismatch fails closed and rolls back
  {
    const { dir, dbPath } = createTempDbPath();
    try {
      createGenuineV1Database(dbPath);
      const store = createSqliteAuditorRecoveryStoreRaw({ dbPath });
      assert.throws(
        () => store.retireLegacyBootstrap('proj-legacy-01', 'wrong-op'),
        { code: RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_BOOTSTRAP_CONFLICT }
      );
      // Active row must still be present
      assert.ok(store.getActiveBootstrap('proj-legacy-01') !== null);
      store.close();
      console.log('PASS: ARS-078 — retireLegacyBootstrap with operation_id mismatch fails closed');
    } finally {
      cleanupTempDir(dir);
    }
  }

  // ARS-079: Successful migration still passes and satisfies all V2 contracts
  {
    const { dir, dbPath } = createTempDbPath();
    try {
      createGenuineV1Database(dbPath);

      // Snapshot pre-migration state via raw SQLite read
      const { DatabaseSync } = require('node:sqlite');
      const rawBefore = new DatabaseSync(dbPath);
      const beforeRow = rawBefore.prepare('SELECT * FROM auditor_bootstrap WHERE project_id = ?').get('proj-legacy-01');
      const beforeHistory = rawBefore.prepare('SELECT * FROM auditor_bootstrap_history WHERE project_id = ? ORDER BY history_seq ASC').all('proj-legacy-01');
      rawBefore.close();

      const store = createSqliteAuditorRecoveryStoreRaw({ dbPath });
      assert.ok(store);

      const active = store.getActiveBootstrap('proj-legacy-01');
      assert.ok(active);
      assert.strictEqual(active.authority_version, 0);
      assert.strictEqual(active.expected_project_root, null);
      assert.strictEqual(active.expected_project_root_identity, null);
      assert.strictEqual(active.expected_auditor_model_policy, null);
      assert.strictEqual(active.state, beforeRow.state);
      assert.strictEqual(active.turn_id, beforeRow.turn_id);
      assert.strictEqual(active.decision_json, beforeRow.decision_json);
      assert.strictEqual(active.decision_sha256, beforeRow.decision_sha256);

      const hist = store.getHistory('proj-legacy-01', 'op-legacy-01');
      assert.strictEqual(hist.length, beforeHistory.length);
      for (let i = 0; i < hist.length; i++) {
        assert.strictEqual(hist[i].previous_state, beforeHistory[i].previous_state);
        assert.strictEqual(hist[i].next_state, beforeHistory[i].next_state);
      }
      store.close();

      const rawAfter = new DatabaseSync(dbPath);
      assert.strictEqual(rawAfter.prepare('PRAGMA user_version;').get().user_version, 2);
      rawAfter.close();

      console.log('PASS: ARS-079 — Successful migration still passes and satisfies all V2 contracts');
    } finally {
      cleanupTempDir(dir);
    }
  }

  // ARS-080: Post-migration validation failure rolls back to V1 and fails closed
  {
    const { dir, dbPath } = createTempDbPath();
    try {
      createGenuineV1Database(dbPath);

      const { DatabaseSync } = require('node:sqlite');
      const rawBefore = new DatabaseSync(dbPath);
      const beforeRow = rawBefore.prepare('SELECT * FROM auditor_bootstrap WHERE project_id = ?').get('proj-legacy-01');
      const beforeHistory = rawBefore.prepare('SELECT * FROM auditor_bootstrap_history WHERE project_id = ? ORDER BY history_seq ASC').all('proj-legacy-01');
      const beforeCols = rawBefore.prepare("PRAGMA table_info('auditor_bootstrap')").all();
      assert.strictEqual(beforeCols.length, 11);
      rawBefore.close();

      const origPrepare = DatabaseSync.prototype.prepare;
      let integrityCheckCount = 0;
      let injectedFailureOccurred = false;

      try {
        DatabaseSync.prototype.prepare = function(sql, ...args) {
          if (typeof sql === 'string' && sql.includes('PRAGMA integrity_check')) {
            integrityCheckCount++;
            if (integrityCheckCount === 2) {
              injectedFailureOccurred = true;
              throw new Error('Deterministic fault injection: in-transaction V2 validation failure');
            }
          }
          return origPrepare.call(this, sql, ...args);
        };

        assert.throws(
          () => createSqliteAuditorRecoveryStoreRaw({ dbPath }),
          (err) => {
            return err !== null && err !== undefined;
          }
        );
      } finally {
        DatabaseSync.prototype.prepare = origPrepare;
      }

      assert.strictEqual(injectedFailureOccurred, true, 'Fault injection must have been triggered');

      // Raw inspection of the database after failure and prototype restoration
      const rawAfter = new DatabaseSync(dbPath, { readOnly: true });
      const userVersionRow = rawAfter.prepare('PRAGMA user_version;').get();
      assert.strictEqual(userVersionRow.user_version, 1, 'user_version must remain 1 after rollback');

      const afterCols = rawAfter.prepare("PRAGMA table_info('auditor_bootstrap')").all();
      assert.strictEqual(afterCols.length, 11, 'auditor_bootstrap column count must be 11');

      const colNames = new Set(afterCols.map(c => c.name));
      assert.strictEqual(colNames.has('authority_version'), false, 'authority_version must be absent');
      assert.strictEqual(colNames.has('expected_project_root'), false, 'expected_project_root must be absent');
      assert.strictEqual(colNames.has('expected_project_root_identity'), false, 'expected_project_root_identity must be absent');
      assert.strictEqual(colNames.has('expected_auditor_model_policy'), false, 'expected_auditor_model_policy must be absent');

      const afterRow = rawAfter.prepare('SELECT * FROM auditor_bootstrap WHERE project_id = ?').get('proj-legacy-01');
      assert.ok(afterRow, 'Original active row must be present');
      assert.strictEqual(afterRow.state, beforeRow.state, 'State must be unchanged');
      assert.strictEqual(afterRow.decision_json, beforeRow.decision_json, 'Decision JSON must be byte-exact unchanged');
      assert.strictEqual(afterRow.decision_sha256, beforeRow.decision_sha256, 'Decision sha256 must be unchanged');
      assert.strictEqual(afterRow.turn_id, beforeRow.turn_id, 'turn_id must be unchanged');

      const afterHistory = rawAfter.prepare('SELECT * FROM auditor_bootstrap_history WHERE project_id = ? ORDER BY history_seq ASC').all('proj-legacy-01');
      assert.strictEqual(afterHistory.length, beforeHistory.length, 'History length must be unchanged');
      for (let i = 0; i < afterHistory.length; i++) {
        assert.strictEqual(afterHistory[i].previous_state, beforeHistory[i].previous_state);
        assert.strictEqual(afterHistory[i].next_state, beforeHistory[i].next_state);
        assert.strictEqual(afterHistory[i].timestamp, beforeHistory[i].timestamp);
      }
      rawAfter.close();

      console.log('PASS: ARS-080 — Post-migration validation failure rolls back to V1 and fails closed');
    } finally {
      cleanupTempDir(dir);
    }
  }

  // ARS-081: Pre-migration failure fails closed before any migration mutation occurs
  {
    const { dir, dbPath } = createTempDbPath();
    try {
      // Case A: Corrupt V1 schema
      createGenuineV1Database(dbPath, { corrupt: 'rogue_col' });
      assert.throws(
        () => createSqliteAuditorRecoveryStoreRaw({ dbPath }),
        { code: RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_SCHEMA_INVALID }
      );

      const { DatabaseSync } = require('node:sqlite');
      let rawDb = new DatabaseSync(dbPath, { readOnly: true });
      assert.strictEqual(rawDb.prepare('PRAGMA user_version;').get().user_version, 1);
      let cols = rawDb.prepare("PRAGMA table_info('auditor_bootstrap')").all();
      let colNames = new Set(cols.map(c => c.name));
      assert.strictEqual(colNames.has('authority_version'), false);
      assert.strictEqual(colNames.has('expected_project_root'), false);
      assert.strictEqual(colNames.has('expected_project_root_identity'), false);
      assert.strictEqual(colNames.has('expected_auditor_model_policy'), false);
      rawDb.close();

      // Case B: Broken V1 history chain
      const { dir: dir2, dbPath: dbPath2 } = createTempDbPath();
      try {
        createGenuineV1Database(dbPath2, { corrupt: 'broken_history' });
        assert.throws(
          () => createSqliteAuditorRecoveryStoreRaw({ dbPath: dbPath2 }),
          { code: RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_CORRUPT }
        );

        rawDb = new DatabaseSync(dbPath2, { readOnly: true });
        assert.strictEqual(rawDb.prepare('PRAGMA user_version;').get().user_version, 1);
        cols = rawDb.prepare("PRAGMA table_info('auditor_bootstrap')").all();
        assert.strictEqual(cols.length, 11);
        colNames = new Set(cols.map(c => c.name));
        assert.strictEqual(colNames.has('authority_version'), false);
        assert.strictEqual(colNames.has('expected_project_root'), false);
        assert.strictEqual(colNames.has('expected_project_root_identity'), false);
        assert.strictEqual(colNames.has('expected_auditor_model_policy'), false);
        rawDb.close();
      } finally {
        cleanupTempDir(dir2);
      }

      console.log('PASS: ARS-081 — Pre-migration validation failure leaves database at V1 without V2 columns');
    } finally {
      cleanupTempDir(dir);
    }
  }

  // ARS-082: Reopen after successful migration passes V2 validation and preserves legacy state
  {
    const { dir, dbPath } = createTempDbPath();
    try {
      createGenuineV1Database(dbPath);

      const { DatabaseSync } = require('node:sqlite');
      const rawBefore = new DatabaseSync(dbPath);
      const beforeRow = rawBefore.prepare('SELECT * FROM auditor_bootstrap WHERE project_id = ?').get('proj-legacy-01');
      const beforeHistory = rawBefore.prepare('SELECT * FROM auditor_bootstrap_history WHERE project_id = ? ORDER BY history_seq ASC').all('proj-legacy-01');
      rawBefore.close();

      // First open: performs migration from V1 to V2
      const store1 = createSqliteAuditorRecoveryStoreRaw({ dbPath });
      assert.ok(store1);
      store1.close();

      // Verify PRAGMA user_version is 2
      const rawMid = new DatabaseSync(dbPath);
      assert.strictEqual(rawMid.prepare('PRAGMA user_version;').get().user_version, 2);
      rawMid.close();

      // Reopen fresh store on the migrated database
      const store2 = createSqliteAuditorRecoveryStoreRaw({ dbPath });
      assert.ok(store2);

      const active = store2.getActiveBootstrap('proj-legacy-01');
      assert.ok(active);
      assert.strictEqual(active.authority_version, 0);
      assert.strictEqual(active.expected_project_root, null);
      assert.strictEqual(active.expected_project_root_identity, null);
      assert.strictEqual(active.expected_auditor_model_policy, null);
      assert.strictEqual(active.state, beforeRow.state);
      assert.strictEqual(active.turn_id, beforeRow.turn_id);
      assert.strictEqual(active.decision_json, beforeRow.decision_json);
      assert.strictEqual(active.decision_sha256, beforeRow.decision_sha256);

      const hist = store2.getHistory('proj-legacy-01', 'op-legacy-01');
      assert.strictEqual(hist.length, beforeHistory.length);
      for (let i = 0; i < hist.length; i++) {
        assert.strictEqual(hist[i].previous_state, beforeHistory[i].previous_state);
        assert.strictEqual(hist[i].next_state, beforeHistory[i].next_state);
      }
      store2.close();

      console.log('PASS: ARS-082 — Reopen after successful migration passes V2 validation and preserves legacy state');
    } finally {
      cleanupTempDir(dir);
    }
  }

  console.log('\n======================================================================');
  console.log('ALL AUDITOR RECOVERY STORE TESTS PASSED (ARS-001 .. ARS-082: 82/82 PASS)');
  console.log('======================================================================\n');
}

runTests().catch((err) => {
  console.error('Fatal error in auditor-recovery-store test suite:', err);
  process.exit(1);
});
