'use strict';

const { spawnSync: defaultSpawnSync } = require('child_process');
const { DISPATCH_STATES, ERROR_CODES, LIMITS } = require('./contracts');
const { createAntigravityCompletionSource, COMPLETION_SOURCE_ERROR_CODES } = require('./antigravity-completion-source');

/**
 * Deterministic Dispatch Envelope Formatter (WO-V3-005 Section 24, A-09)
 */
function formatDispatchEnvelope({ project_id, work_order_id, dispatch_id, expected_workspace_state_id, directive }) {
  const metaObj = {
    type: 'worker_dispatch',
    schema_version: 1,
    project_id,
    work_order_id,
    dispatch_id,
    expected_workspace_state_id: expected_workspace_state_id || ''
  };

  return `[ORCHESTRATOR_DISPATCH_V1]\n` +
    `${JSON.stringify(metaObj)}\n\n` +
    `[DIRECTIVE_BEGIN]\n` +
    `${directive}\n` +
    `[DIRECTIVE_END]\n\n` +
    `[REQUIRED_COMPLETION]\n` +
    `When implementation work is finished, output exactly one standalone machine line:\n\n` +
    `[ORCHESTRATOR_COMPLETION_V1] {"type":"worker_completion","schema_version":1,"project_id":"${project_id}","work_order_id":"${work_order_id}","dispatch_id":"${dispatch_id}","state":"READY_FOR_REVIEW"}\n\n` +
    `READY_FOR_REVIEW means implementation is ready for independent Sol audit.\n` +
    `It does NOT mean the project/work package is approved.`;
}

/**
 * Create Antigravity Worker Port (WP-V3-05)
 *
 * Implements concrete broker workerPort:
 * - dispatch(args): Delivers directives to Antigravity via AO CLI, binds identity envelope.
 * - wait(args): Bounded monotonic polling for exact machine completion envelope.
 */
function createAntigravityWorkerPort(options = {}) {
  const aoBinary = options.aoBinary || 'ao.exe';
  const spawnSync = options.spawnSync || defaultSpawnSync;
  const completionSource = options.completionSource || createAntigravityCompletionSource(options);
  const clock = options.clock || {
    monotonic: () => performance.now()
  };
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const maxDiagnosticBytes = options.maxDiagnosticBytes || 8 * 1024; // 8 KiB
  const pollIntervalMs = options.pollIntervalMs || 250;

  /**
   * dispatchWorker Port Entry
   */
  async function dispatch(args) {
    if (!args || typeof args !== 'object') {
      return { ok: false, definitive: true, error: 'Invalid dispatch arguments' };
    }

    const { project, project_id, work_order_id, dispatch_id, expected_workspace_state_id, directive } = args;

    // 1. Validate project & worker configuration
    if (!project || typeof project !== 'object') {
      return { ok: false, definitive: true, error: 'Missing or invalid project descriptor' };
    }
    if (project.project_id !== project_id) {
      return { ok: false, definitive: true, error: 'Project ID mismatch between request and project descriptor' };
    }
    if (!project.worker || typeof project.worker !== 'object') {
      return { ok: false, definitive: true, error: 'WORKER_SESSION_UNAVAILABLE' };
    }
    if (project.worker.engine !== 'antigravity') {
      return { ok: false, definitive: true, error: 'WORKER_SESSION_UNAVAILABLE' };
    }
    if (project.worker.enabled !== true) {
      return { ok: false, definitive: true, error: 'WORKER_SESSION_UNAVAILABLE' };
    }
    if (typeof project.worker.session_id !== 'string' || !project.worker.session_id.trim()) {
      return { ok: false, definitive: true, error: 'WORKER_SESSION_UNAVAILABLE' };
    }

    const sessionId = project.worker.session_id.trim();

    // 2. Verify exact session mapping prior to send (A-02, A-06)
    try {
      if (completionSource && typeof completionSource.resolveSessionTranscript === 'function') {
        completionSource.resolveSessionTranscript(sessionId, project);
      }
    } catch (err) {
      // Definitive before-send failure: missing session row, conflict, etc.
      return {
        ok: false,
        definitive: true,
        code: err.code || 'WORKER_SESSION_UNAVAILABLE',
        error: err.message
      };
    }

    // 3. Render deterministic dispatch envelope
    const renderedEnvelope = formatDispatchEnvelope({
      project_id,
      work_order_id,
      dispatch_id,
      expected_workspace_state_id,
      directive
    });

    // 4. Execute AO send via spawnSync (Section 19)
    let childRes;
    try {
      childRes = spawnSync(
        aoBinary,
        ['send', '--session', sessionId, '--message', renderedEnvelope],
        {
          shell: false,
          encoding: 'utf8',
          maxBuffer: maxDiagnosticBytes,
          timeout: 30000
        }
      );
    } catch (err) {
      // Subprocess invocation failure after send attempt -> non-definitive (A-06)
      return {
        ok: false,
        definitive: false,
        error: `AO send invocation failed: ${err.message}`
      };
    }

    if (childRes.error) {
      // Ambiguous transport failure (timeout, crash) -> non-definitive
      return {
        ok: false,
        definitive: false,
        error: `AO send failed: ${childRes.error.message}`
      };
    }

    if (childRes.status === 0) {
      // Definitive acceptance (Section 21)
      return {
        ok: true,
        state: DISPATCH_STATES.DISPATCH_ACCEPTED
      };
    }

    // Non-zero exit code:
    // Per A-06: Once ao send has actually been attempted, nonzero result is ambiguous.
    // Default safe behavior: NON-DEFINITIVE => broker DISPATCH_UNCERTAIN.
    const stderrMsg = childRes.stderr ? childRes.stderr.slice(0, maxDiagnosticBytes).trim() : '';
    const stdoutMsg = childRes.stdout ? childRes.stdout.slice(0, maxDiagnosticBytes).trim() : '';
    return {
      ok: false,
      definitive: false,
      error: stderrMsg || stdoutMsg || `AO send exited with status ${childRes.status}`
    };
  }

  /**
   * waitWorker Port Entry
   */
  async function wait(args) {
    if (!args || typeof args !== 'object') {
      return {
        ok: false,
        code: ERROR_CODES.WORKER_WAIT_UNAVAILABLE,
        error: 'Invalid wait arguments'
      };
    }

    const { project, project_id, dispatch_id, work_order_id } = args;

    if (!project || !project.worker || typeof project.worker.session_id !== 'string' || !project.worker.session_id.trim()) {
      return {
        ok: false,
        code: ERROR_CODES.WORKER_WAIT_UNAVAILABLE,
        error: 'WORKER_SESSION_UNAVAILABLE'
      };
    }

    const sessionId = project.worker.session_id.trim();

    // Clamp timeout defensively between 1 and 30 seconds (Section 41, A-17)
    let timeoutSecs = args.timeout_secs;
    if (typeof timeoutSecs !== 'number' || isNaN(timeoutSecs)) timeoutSecs = LIMITS.DEFAULT_TIMEOUT_SECS;
    if (timeoutSecs > LIMITS.MAX_TIMEOUT_SECS) timeoutSecs = LIMITS.MAX_TIMEOUT_SECS;
    if (timeoutSecs < LIMITS.MIN_TIMEOUT_SECS) timeoutSecs = LIMITS.MIN_TIMEOUT_SECS;

    // Use monotonic clock for polling deadline (A-17)
    const startTime = clock.monotonic();
    const deadline = startTime + (timeoutSecs * 1000);

    let activeTranscriptPath = null;
    let latestNonterminalState = DISPATCH_STATES.DISPATCH_ACCEPTED;

    while (true) {
      let boundaryIndex = -1;
      const candidateCompletions = [];
      let ambiguityError = null;
      let mappingChangeDetected = false;

      try {
        await completionSource.scanSession(sessionId, project, async (record, index, resolution) => {
          // A-18: Check transcript mapping stability during active wait
          if (resolution && resolution.transcriptPath) {
            if (activeTranscriptPath === null) {
              activeTranscriptPath = resolution.transcriptPath;
            } else if (activeTranscriptPath !== resolution.transcriptPath) {
              mappingChangeDetected = true;
              return { stop: true };
            }
          }

          // 1. Boundary Detection (A-09)
          if (boundaryIndex === -1) {
            if ((record.source === 'USER_EXPLICIT' || record.type === 'USER_INPUT') && typeof record.content === 'string') {
              const contentLines = record.content.trimStart().split('\n').map(l => l.trim());
              if (contentLines[0] === '[ORCHESTRATOR_DISPATCH_V1]' && contentLines[1]) {
                try {
                  const dObj = JSON.parse(contentLines[1]);
                  if (
                    dObj &&
                    dObj.type === 'worker_dispatch' &&
                    dObj.schema_version === 1 &&
                    dObj.project_id === project_id &&
                    dObj.work_order_id === work_order_id &&
                    dObj.dispatch_id === dispatch_id
                  ) {
                    boundaryIndex = index;
                  }
                } catch (_) {
                  // Not valid JSON header, cannot be boundary
                }
              }
            }
            return;
          }

          // 2. Completion Detection (A-10, A-11, A-21, A-22, A-23)
          if (index > boundaryIndex) {
            // Must be worker/model final planner response record (A-11, WA-020)
            const isModelOutput = record.type === 'PLANNER_RESPONSE' && record.source === 'MODEL';

            if (!isModelOutput) {
              return;
            }

            // Must be concluded/final record (A-11 / WA-038)
            // If status is present and not 'DONE', it is an intermediate/streaming record
            if (record.status !== undefined && record.status !== 'DONE') {
              return;
            }

            const text = typeof record.content === 'string' ? record.content : '';
            if (!text.includes('[ORCHESTRATOR_COMPLETION_V1]')) {
              return;
            }

            // A-10: Completion must be an exact standalone line
            const lines = text.split('\n');
            for (const rawLine of lines) {
              const trimmed = rawLine.trim();
              if (!trimmed.includes('[ORCHESTRATOR_COMPLETION_V1]')) {
                continue;
              }

              // Reject prefix prose, quoted lines, markdown fences
              if (!rawLine.startsWith('[ORCHESTRATOR_COMPLETION_V1] ') && rawLine !== '[ORCHESTRATOR_COMPLETION_V1]') {
                continue;
              }

              const remainder = rawLine.slice('[ORCHESTRATOR_COMPLETION_V1]'.length).trim();
              if (!remainder) {
                continue;
              }

              let cObj;
              try {
                cObj = JSON.parse(remainder);
              } catch (parseErr) {
                // A-22: Malformed marker JSON in eligible final worker record -> fail closed
                ambiguityError = `Completion envelope JSON is malformed: ${parseErr.message}`;
                return { stop: true };
              }

              if (!cObj || typeof cObj !== 'object' || Array.isArray(cObj)) {
                ambiguityError = 'Completion envelope must be a JSON object';
                return { stop: true };
              }

              if (cObj.type !== 'worker_completion' || cObj.schema_version !== 1) {
                ambiguityError = 'Completion envelope schema invalid';
                return { stop: true };
              }

              // Check dispatch_id
              if (!cObj.dispatch_id || typeof cObj.dispatch_id !== 'string') {
                ambiguityError = 'Completion envelope missing dispatch_id';
                return { stop: true };
              }

              if (cObj.dispatch_id !== dispatch_id) {
                // Stale/foreign dispatch ID (A-21) -> ignore and continue waiting
                continue;
              }

              // Current dispatch ID matches: check required identity fields (A-21)
              if (cObj.work_order_id !== work_order_id) {
                ambiguityError = `Completion envelope work_order_id mismatch: expected '${work_order_id}', got '${cObj.work_order_id}'`;
                return { stop: true };
              }
              if (cObj.project_id !== project_id) {
                ambiguityError = `Completion envelope project_id mismatch: expected '${project_id}', got '${cObj.project_id}'`;
                return { stop: true };
              }
              if (cObj.state !== DISPATCH_STATES.READY_FOR_REVIEW) {
                ambiguityError = `Completion envelope state invalid: expected '${DISPATCH_STATES.READY_FOR_REVIEW}', got '${cObj.state}'`;
                return { stop: true };
              }

              candidateCompletions.push({ index, envelope: cObj });
            }
          }
        });
      } catch (err) {
        if (err.code === COMPLETION_SOURCE_ERROR_CODES.COMPLETION_SOURCE_INTEGRITY_FAILURE) {
          return {
            ok: false,
            code: ERROR_CODES.WORKER_WAIT_UNAVAILABLE,
            dispatch_id,
            error: `Completion source integrity failure: ${err.message}`
          };
        }
        return {
          ok: false,
          code: ERROR_CODES.WORKER_WAIT_UNAVAILABLE,
          dispatch_id,
          error: `Completion source unavailable: ${err.message}`
        };
      }

      if (mappingChangeDetected) {
        return {
          ok: false,
          code: ERROR_CODES.PROVENANCE_AMBIGUOUS,
          dispatch_id,
          error: 'Transcript mapping changed during active wait'
        };
      }

      if (ambiguityError) {
        return {
          ok: false,
          code: ERROR_CODES.PROVENANCE_AMBIGUOUS,
          dispatch_id,
          error: ambiguityError
        };
      }

      if (candidateCompletions.length > 1) {
        // A-23: Duplicate current completions fail closed
        return {
          ok: false,
          code: ERROR_CODES.PROVENANCE_AMBIGUOUS,
          dispatch_id,
          error: `Duplicate current completion envelopes observed (${candidateCompletions.length})`
        };
      }

      if (candidateCompletions.length === 1) {
        return {
          ok: true,
          state: DISPATCH_STATES.READY_FOR_REVIEW,
          dispatch_id,
          work_order_id,
          completion_identity: {
            method: 'completion_envelope'
          }
        };
      }

      // No terminal completion yet
      if (boundaryIndex !== -1) {
        latestNonterminalState = DISPATCH_STATES.RUNNING;
      } else {
        latestNonterminalState = DISPATCH_STATES.DISPATCH_ACCEPTED;
      }

      const now = clock.monotonic();
      if (now >= deadline) {
        // Deadline reached (A-16): return latest observed nonterminal state
        return {
          ok: true,
          state: latestNonterminalState,
          dispatch_id,
          work_order_id
        };
      }

      const remainingMs = deadline - now;
      const sleepTime = Math.min(pollIntervalMs, Math.max(1, remainingMs));
      await sleep(sleepTime);
    }
  }

  async function status() {
    return { ok: true, state: 'IDLE' };
  }

  return {
    dispatch,
    wait,
    status,
    formatDispatchEnvelope
  };
}

module.exports = {
  createAntigravityWorkerPort,
  formatDispatchEnvelope
};
