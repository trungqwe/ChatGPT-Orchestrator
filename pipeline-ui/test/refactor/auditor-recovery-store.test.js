'use strict';

/**
 * Auditor Recovery Store Test Suite (ARS-001 .. ARS-038)
 * Verifies SQLite recovery store authority, single active bootstrap,
 * transition matrix, append-only history, decision hash & schema verification,
 * reopen semantics, and fail-closed corruption detection.
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const {
  AUDITOR_BOOTSTRAP_STATES,
  RECOVERY_ERROR_CODES,
  createSqliteAuditorRecoveryStore
} = require('../../lib/relay/sqlite-auditor-recovery-store');

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
  console.log('Starting Auditor Recovery Store test suite (ARS-001 .. ARS-038)...');

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

  console.log('\n======================================================================');
  console.log('ALL AUDITOR RECOVERY STORE TESTS PASSED (ARS-001 .. ARS-038: 38/38 PASS)');
  console.log('======================================================================\n');
}

runTests().catch((err) => {
  console.error('Fatal error in auditor-recovery-store test suite:', err);
  process.exit(1);
});
