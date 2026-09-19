'use strict';

const { spawnSync: defaultSpawnSync } = require('child_process');
const { DISPATCH_STATES, ERROR_CODES, LIMITS } = require('./contracts');
const { createAntigravityCompletionSource, COMPLETION_SOURCE_ERROR_CODES } = require('./antigravity-completion-source');

/**
 * Deterministic Dispatch Envelope Formatter (WO-V3-005 Section 24, A-09, WAAUTH-10)
 */
function formatDispatchEnvelope({ project_id, work_order_id, dispatch_id, expected_workspace_state_id, directive }) {
  if (typeof project_id !== 'string' || !project_id.trim()) {
    throw new Error('project_id must be a non-empty string');
  }
  if (typeof work_order_id !== 'string' || !work_order_id.trim()) {
    throw new Error('work_order_id must be a non-empty string');
  }
  if (typeof dispatch_id !== 'string' || !dispatch_id.trim()) {
    throw new Error('dispatch_id must be a non-empty string');
  }
  if (typeof expected_workspace_state_id !== 'string' || !expected_workspace_state_id.trim()) {
    throw new Error('expected_workspace_state_id must be a non-empty string');
  }
  if (typeof directive !== 'string' || !directive.trim()) {
    throw new Error('directive must be a non-empty string');
  }

  const metaObj = {
    type: 'worker_dispatch',
    schema_version: 1,
    project_id,
    work_order_id,
    dispatch_id,
    expected_workspace_state_id
  };

  // WAAUTH-10: JSON-safe control envelope serialization without string interpolation
  const completionObj = {
    type: 'worker_completion',
    schema_version: 1,
    project_id,
    work_order_id,
    dispatch_id,
    state: 'READY_FOR_REVIEW'
  };

  return `[ORCHESTRATOR_DISPATCH_V1]\n` +
    `${JSON.stringify(metaObj)}\n\n` +
    `[DIRECTIVE_BEGIN]\n` +
    `${directive}\n` +
    `[DIRECTIVE_END]\n\n` +
    `[REQUIRED_COMPLETION]\n` +
    `When implementation work is finished, output exactly one standalone machine line:\n\n` +
    `[ORCHESTRATOR_COMPLETION_V1] ${JSON.stringify(completionObj)}\n\n` +
    `READY_FOR_REVIEW means implementation is ready for independent Sol audit.\n` +
    `It does NOT mean the project/work package is approved.`;
}

/**
 * Create Antigravity Worker Port (WP-V3-05 / WO-V3-005F)
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
    let renderedEnvelope;
    try {
      renderedEnvelope = formatDispatchEnvelope({
        project_id,
        work_order_id,
        dispatch_id,
        expected_workspace_state_id,
        directive
      });
    } catch (envErr) {
      return {
        ok: false,
        definitive: true,
        error: `Envelope formatting error: ${envErr.message}`
      };
    }

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

    const { project, project_id, dispatch_id, work_order_id, expected_workspace_state_id } = args;

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

    let initialTranscriptPath = null;
    let latestNonterminalState = DISPATCH_STATES.DISPATCH_ACCEPTED;

    while (true) {
      // WAAUTH-07: Resolve exact session mapping at the start of EVERY polling iteration
      let resolution;
      try {
        resolution = completionSource.resolveSessionTranscript(sessionId, project);
      } catch (resErr) {
        return {
          ok: false,
          code: ERROR_CODES.WORKER_WAIT_UNAVAILABLE,
          dispatch_id,
          error: `Session resolution failed: ${resErr.message}`
        };
      }

      // Check mapping stability across polls even if transcript has zero complete records
      if (initialTranscriptPath === null) {
        initialTranscriptPath = resolution.transcriptPath;
      } else if (initialTranscriptPath !== resolution.transcriptPath) {
        return {
          ok: false,
          code: ERROR_CODES.PROVENANCE_AMBIGUOUS,
          dispatch_id,
          error: 'Transcript mapping changed during active wait'
        };
      }

      let boundaryIndex = -1;
      const candidateCompletions = [];
      let ambiguityError = null;

      try {
        const visitor = async (record, index) => {
          // 1. Boundary Detection (A-09, WAAUTH-03, WAAUTH-04, Section 10, 13, 26)
          if (typeof record.content === 'string') {
            // WAAUTH-03: Authoritative boundary requires BOTH source=USER_EXPLICIT and type=USER_INPUT
            const isUserInput = record.source === 'USER_EXPLICIT' && record.type === 'USER_INPUT';

            if (isUserInput) {
              // Section 10: Require physical line 0 to be exactly [ORCHESTRATOR_DISPATCH_V1] (no trimStart)
              const rawLines = record.content.split(/\r?\n/);
              if (rawLines[0] === '[ORCHESTRATOR_DISPATCH_V1]' && rawLines[1]) {
                try {
                  const dObj = JSON.parse(rawLines[1]);
                  if (
                    dObj &&
                    dObj.type === 'worker_dispatch' &&
                    dObj.schema_version === 1 &&
                    dObj.project_id === project_id &&
                    dObj.work_order_id === work_order_id &&
                    dObj.dispatch_id === dispatch_id
                  ) {
                    // WAAUTH-04 / Section 13: Validate expected_workspace_state_id
                    if (expected_workspace_state_id !== undefined && dObj.expected_workspace_state_id !== expected_workspace_state_id) {
                      ambiguityError = `Contradictory expected_workspace_state_id on matching dispatch identity: expected '${expected_workspace_state_id}', got '${dObj.expected_workspace_state_id}'`;
                      return { stop: true };
                    }

                    // Section 26: Duplicate exact dispatch boundary detection
                    if (boundaryIndex !== -1) {
                      ambiguityError = 'Duplicate current dispatch boundary records observed';
                      return { stop: true };
                    }

                    boundaryIndex = index;
                    return;
                  }
                } catch (_) {
                  // Not valid JSON header, cannot be boundary
                }
              }
            }
          }

          // 2. Completion Detection (A-10, A-11, A-21, A-22, A-23, WAAUTH-05, WAAUTH-06)
          if (boundaryIndex !== -1 && index > boundaryIndex) {
            // WAAUTH-05: Require ALL THREE: source=MODEL, type=PLANNER_RESPONSE, status=DONE
            const isFinalModelOutput = record.source === 'MODEL' &&
              record.type === 'PLANNER_RESPONSE' &&
              record.status === 'DONE';

            if (!isFinalModelOutput) {
              return;
            }

            const text = typeof record.content === 'string' ? record.content : '';
            if (!text.includes('[ORCHESTRATOR_COMPLETION_V1]')) {
              return;
            }

            // WAAUTH-06: Parse lines tracking markdown code fence state
            const lines = text.split(/\r?\n/);
            let inFence = false;
            let fenceChar = '';
            let fenceLength = 0;

            for (const line of lines) {
              const trimmed = line.trim();

              // Track fenced-code state (``` or ~~~ with at least 3 chars)
              const fenceMatch = line.match(/^(\s*)(`{3,}|~{3,})/);
              if (fenceMatch) {
                const char = fenceMatch[2][0];
                const len = fenceMatch[2].length;
                if (!inFence) {
                  inFence = true;
                  fenceChar = char;
                  fenceLength = len;
                  continue;
                } else if (char === fenceChar && len >= fenceLength) {
                  inFence = false;
                  continue;
                }
              }

              if (inFence) {
                // Fenced code is example/documentation, not machine signal
                continue;
              }

              // Reject markdown blockquote lines
              if (trimmed.startsWith('>')) {
                continue;
              }

              if (!trimmed.includes('[ORCHESTRATOR_COMPLETION_V1]')) {
                continue;
              }

              // Must be an exact standalone line: begins with marker, no prose prefix
              if (!line.startsWith('[ORCHESTRATOR_COMPLETION_V1] ') && line !== '[ORCHESTRATOR_COMPLETION_V1]') {
                continue;
              }

              const remainder = line.slice('[ORCHESTRATOR_COMPLETION_V1]'.length).trim();
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
        };

        if (typeof completionSource.scanResolvedSession === 'function') {
          await completionSource.scanResolvedSession(resolution, visitor, { deadline, clock });
        } else {
          await completionSource.scanSession(sessionId, project, visitor, { deadline, clock });
        }
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
