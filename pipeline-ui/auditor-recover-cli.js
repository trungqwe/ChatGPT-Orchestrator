'use strict';

const path = require('path');
const os = require('os');

const { createProjectRegistry } = require('./lib/broker/registry');
const { createSqliteAuditorRecoveryStore } = require('./lib/relay/sqlite-auditor-recovery-store');
const { CodexAuditorAdapter } = require('./lib/auditor/codex-auditor-adapter');
const {
  inspectAuditorBootstrap,
  recoverAuditorBootstrap,
  resolveAuditorBootstrapUncertainty,
  retireLegacyAuditorBootstrapWithoutAuthority
} = require('./lib/relay/auditor-thread-lifecycle');

// Forbidden routing / execution override flags (Section 6)
const FORBIDDEN_FLAGS = new Set([
  '--thread-id',
  '--turn-id',
  '--decision',
  '--turn-status',
  '--project-root',
  '--cwd',
  '--cwd-override',
  '--model',
  '--effort',
  '--operation-id',
  '--session',
  '--session-id',
  '--worker-session',
  '--shell',
  '--exec',
  '--powershell',
  '--bash',
  '--cmd',
  '--argv'
]);

const ALLOWED_COMMANDS = new Set([
  'inspect',
  'recover',
  'resolve-uncertainty',
  'retire-legacy'
]);

const HELP_COMMANDS = new Set([
  'help',
  '--help',
  '-h'
]);

const PROJECT_ID_REGEX = /^[a-z0-9][a-z0-9._-]{0,127}$/;

/**
 * Truncate string to at most maxBytes in UTF-8 without breaking multi-byte sequences.
 */
function truncateUtf8(str, maxBytes = 1024) {
  if (typeof str !== 'string') return '';
  const buf = Buffer.from(str, 'utf8');
  if (buf.length <= maxBytes) return str;
  let truncatedBuf = buf.subarray(0, maxBytes);
  let res = truncatedBuf.toString('utf8');
  if (res.endsWith('\uFFFD')) {
    res = res.slice(0, -1);
  }
  return res;
}

/**
 * Strict Argument Parser (Section 6)
 */
function parseCliArgs(argv) {
  if (!Array.isArray(argv) || argv.length === 0) {
    return {
      error: 'No command specified',
      exitCode: 2
    };
  }

  const first = argv[0];
  if (HELP_COMMANDS.has(first)) {
    if (argv.length > 1) {
      return {
        error: `Unexpected argument '${argv[1]}' after help`,
        exitCode: 2
      };
    }
    return {
      isHelp: true,
      command: 'help'
    };
  }

  if (!ALLOWED_COMMANDS.has(first)) {
    return {
      error: `Unknown command '${first}'. Allowed commands: ${Array.from(ALLOWED_COMMANDS).join(', ')}`,
      exitCode: 2
    };
  }

  const command = first;
  const flags = Object.create(null);
  const seenFlags = new Set();

  for (let i = 1; i < argv.length; i++) {
    const token = argv[i];

    if (!token.startsWith('--')) {
      return {
        error: `Unexpected positional argument '${token}'`,
        exitCode: 2
      };
    }

    let flagName = token;
    let flagValue = null;
    let hasInlineValue = false;

    const eqIdx = token.indexOf('=');
    if (eqIdx !== -1) {
      flagName = token.slice(0, eqIdx);
      flagValue = token.slice(eqIdx + 1);
      hasInlineValue = true;
    }

    if (FORBIDDEN_FLAGS.has(flagName)) {
      return {
        error: `Forbidden flag '${flagName}' is not allowed`,
        exitCode: 2
      };
    }

    if (seenFlags.has(flagName)) {
      return {
        error: `Duplicate flag '${flagName}'`,
        exitCode: 2
      };
    }
    seenFlags.add(flagName);

    if (flagName === '--confirm') {
      if (command !== 'retire-legacy') {
        return {
          error: `Flag '--confirm' is only allowed on 'retire-legacy'`,
          exitCode: 2
        };
      }
      if (hasInlineValue) {
        return {
          error: `Flag '--confirm' does not accept a value`,
          exitCode: 2
        };
      }
      flags.confirm = true;
      continue;
    }

    if (flagName === '--project-id') {
      if (!hasInlineValue) {
        if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) {
          return {
            error: `Flag '--project-id' requires a value`,
            exitCode: 2
          };
        }
        flagValue = argv[++i];
      }
      if (!flagValue || typeof flagValue !== 'string') {
        return {
          error: `Flag '--project-id' requires a non-empty value`,
          exitCode: 2
        };
      }
      flags.projectId = flagValue;
      continue;
    }

    // Any other flag starting with --
    return {
      error: `Unknown flag '${flagName}' for command '${command}'`,
      exitCode: 2
    };
  }

  // Mandatory --project-id check
  if (!flags.projectId) {
    return {
      error: `Command '${command}' requires '--project-id <project-id>'`,
      exitCode: 2
    };
  }

  // Validate --project-id bounds and character set
  if (Buffer.byteLength(flags.projectId, 'utf8') > 128 || !PROJECT_ID_REGEX.test(flags.projectId)) {
    return {
      error: `Invalid '--project-id' format: must match ^[a-z0-9][a-z0-9._-]{0,127}$ and be <= 128 bytes`,
      exitCode: 2
    };
  }

  // Mandatory --confirm for retire-legacy
  if (command === 'retire-legacy' && !flags.confirm) {
    return {
      error: `Command 'retire-legacy' requires '--confirm'`,
      exitCode: 2
    };
  }

  return {
    command,
    flags
  };
}

/**
 * Production Adapter Factory (Section 8)
 * Authority: Lifecycle canonical cwd takes strict precedence.
 */
function createAuditorAdapterFactory(options = {}) {
  const adapterOptions = {
    ...(options.adapterOptions || {})
  };

  // Guard against preconstructed client injection bypassing canonical transport cwd
  if (adapterOptions.client) {
    const err = new Error('adapterOptions.client is forbidden in auditor adapter factory');
    err.code = 'AUDITOR_CLI_RUNTIME_INVALID_OPTION';
    throw err;
  }

  return async ({ phase, cwd } = {}) => {
    if (typeof cwd !== 'string' || !cwd.trim()) {
      const err = new Error('Lifecycle canonical cwd is required');
      err.code = 'AUDITOR_CLI_RUNTIME_INVALID_CWD';
      throw err;
    }

    return new CodexAuditorAdapter({
      ...adapterOptions,
      cwd
    });
  };
}

/**
 * Production Runtime Composition (Section 7)
 */
function createAuditorRecoveryCliRuntime(options = {}) {
  let recoveryStore = null;

  try {
    const registryPort = options.registryPort || createProjectRegistry(options.registryOptions);
    const recoveryOptions = {
      ...(options.recoveryOptions || {})
    };
    if (options.command === 'inspect') {
      recoveryOptions.readOnly = true;
    }
    recoveryStore = options.recoveryStore || createSqliteAuditorRecoveryStore(recoveryOptions);
    const adapterFactory = options.adapterFactory || createAuditorAdapterFactory(options);

    return {
      registryPort,
      recoveryStore,
      adapterFactory,
      close: async () => {
        if (recoveryStore && typeof recoveryStore.close === 'function') {
          try {
            recoveryStore.close();
          } catch {}
        }
      }
    };
  } catch (err) {
    if (recoveryStore && typeof recoveryStore.close === 'function') {
      try {
        recoveryStore.close();
      } catch {}
    }
    throw err;
  }
}

/**
 * Map operational errors (after runtime init succeeds) to CLI exit codes (Section 12).
 */
function mapOperationalErrorToExitCode(err) {
  const code = err && err.code;
  switch (code) {
    case 'AUDITOR_LIFECYCLE_PRECONDITION_FAILED':
      return 6;
    case 'AUDITOR_RECOVERY_CORRUPT':
      return 8;
    case 'AUDITOR_LIFECYCLE_RESUME_VERIFY_FAILED':
      return 9;
    case 'AUDITOR_LIFECYCLE_REGISTRY_BIND_FAILED':
      return 10;
    default:
      return 12;
  }
}

/**
 * Core testable CLI runner (Sections 10, 14).
 * Returns { exitCode, response } without writing stdout.
 */
async function runCli(argv, options = {}) {
  // 1. Argument Parsing (before runtime initialization or IO)
  const parsed = parseCliArgs(argv);
  if (parsed.error) {
    return {
      exitCode: parsed.exitCode || 2,
      response: {
        ok: false,
        code: 'INVALID_CLI_REQUEST',
        error: truncateUtf8(parsed.error, 1024)
      }
    };
  }

  if (parsed.isHelp) {
    return {
      exitCode: 0,
      response: {
        ok: true,
        operation: 'help',
        commands: Array.from(ALLOWED_COMMANDS)
      }
    };
  }

  const { command, flags } = parsed;
  const projectId = flags.projectId;

  // 2. Runtime Initialization Phase Boundary (Section 13)
  let runtime = null;
  const runtimeFactory = options.runtimeFactory || createAuditorRecoveryCliRuntime;

  try {
    if (options.runtime) {
      runtime = options.runtime;
    } else {
      runtime = await runtimeFactory({
        ...options,
        command
      });
    }
  } catch (err) {
    return {
      exitCode: 11,
      response: {
        ok: false,
        operation: command,
        project_id: projectId,
        code: err.code || 'CLI_RUNTIME_INITIALIZATION_FAILURE',
        error: truncateUtf8(err.message || 'Runtime initialization failed', 1024)
      }
    };
  }

  // 3. Command Execution & Output Projection (Sections 9, 10, 16)
  const lifecycle = options.lifecycle || {
    inspectAuditorBootstrap,
    recoverAuditorBootstrap,
    resolveAuditorBootstrapUncertainty,
    retireLegacyAuditorBootstrapWithoutAuthority
  };

  try {
    if (command === 'inspect') {
      const result = await lifecycle.inspectAuditorBootstrap({
        projectId,
        registryPort: runtime.registryPort,
        recoveryStore: runtime.recoveryStore
      });

      const response = {
        ok: true,
        operation: 'inspect',
        project_id: result.project_id,
        active_bootstrap: result.active_bootstrap ? {
          project_id: result.active_bootstrap.project_id,
          operation_id: result.active_bootstrap.operation_id,
          audit_subject_id: result.active_bootstrap.audit_subject_id,
          thread_id: result.active_bootstrap.thread_id,
          turn_id: result.active_bootstrap.turn_id,
          workspace_state_observed: result.active_bootstrap.workspace_state_observed,
          state: result.active_bootstrap.state,
          has_decision: result.active_bootstrap.decision_json !== null,
          decision_sha256: result.active_bootstrap.decision_sha256,
          authority_version: result.active_bootstrap.authority_version,
          expected_project_root: result.active_bootstrap.expected_project_root,
          expected_auditor_model_policy: result.active_bootstrap.expected_auditor_model_policy,
          created_at: result.active_bootstrap.created_at,
          updated_at: result.active_bootstrap.updated_at
        } : null,
        history: Array.isArray(result.history) ? result.history.map(h => ({
          history_seq: h.history_seq,
          operation_id: h.operation_id,
          previous_state: h.previous_state,
          next_state: h.next_state,
          iso: h.iso
        })) : [],
        registry_binding_state: result.registry_binding_state
      };

      return { exitCode: 0, response };
    }

    if (command === 'recover') {
      const result = await lifecycle.recoverAuditorBootstrap({
        projectId,
        registryPort: runtime.registryPort,
        recoveryStore: runtime.recoveryStore,
        adapterFactory: runtime.adapterFactory
      });

      if (result.status === 'NO_ACTIVE_BOOTSTRAP') {
        return {
          exitCode: 0,
          response: {
            ok: true,
            operation: 'recover',
            project_id: result.project_id,
            status: 'NO_ACTIVE_BOOTSTRAP'
          }
        };
      }

      if (result.status === 'RECOVERED_CLEARED') {
        return {
          exitCode: 0,
          response: {
            ok: true,
            operation: 'recover',
            project_id: result.project_id,
            status: 'RECOVERED_CLEARED',
            previous_state: result.previous_state,
            thread_id: result.thread_id
          }
        };
      }

      if (result.status === 'RECOVERED_TERMINAL_NO_DECISION_CLEARED') {
        return {
          exitCode: 0,
          response: {
            ok: true,
            operation: 'recover',
            project_id: result.project_id,
            status: 'RECOVERED_TERMINAL_NO_DECISION_CLEARED',
            previous_state: result.previous_state,
            thread_id: result.thread_id
          }
        };
      }

      if (result.status === 'DURABLE_BOUND') {
        return {
          exitCode: 0,
          response: {
            ok: true,
            operation: 'recover',
            project_id: result.project_id,
            status: 'DURABLE_BOUND',
            thread_id: result.thread_id,
            reconciled: Boolean(result.reconciled)
          }
        };
      }

      if (result.status === 'AUDIT_UNCERTAIN') {
        return {
          exitCode: 5,
          response: {
            ok: false,
            operation: 'recover',
            project_id: result.project_id,
            status: 'AUDIT_UNCERTAIN',
            thread_id: result.thread_id,
            code: 'AUDIT_UNCERTAIN',
            message: truncateUtf8(result.message || 'Audit execution status uncertain; intervention required', 1024)
          }
        };
      }

      // Unexpected unhandled status fallback
      return {
        exitCode: 12,
        response: {
          ok: false,
          operation: 'recover',
          project_id: result.project_id,
          code: 'CLI_RUNTIME_FAILURE',
          error: truncateUtf8(`Unhandled recover status: ${result.status}`, 1024)
        }
      };
    }

    if (command === 'resolve-uncertainty') {
      const result = await lifecycle.resolveAuditorBootstrapUncertainty({
        projectId,
        registryPort: runtime.registryPort,
        recoveryStore: runtime.recoveryStore,
        adapterFactory: runtime.adapterFactory
      });

      if (result.status === 'DECISION_VALIDATED') {
        return {
          exitCode: 0,
          response: {
            ok: true,
            operation: 'resolve-uncertainty',
            project_id: result.project_id,
            status: 'DECISION_VALIDATED',
            thread_id: result.thread_id,
            turn_id: result.turn_id,
            decision_sha256: result.decision_sha256
          }
        };
      }

      if (result.status === 'AUDIT_TERMINAL_NO_DECISION') {
        return {
          exitCode: 0,
          response: {
            ok: true,
            operation: 'resolve-uncertainty',
            project_id: result.project_id,
            status: 'AUDIT_TERMINAL_NO_DECISION',
            thread_id: result.thread_id,
            turn_id: result.turn_id,
            turn_status: result.turn_status
          }
        };
      }

      if (result.status === 'AUDIT_UNCERTAIN') {
        return {
          exitCode: 5,
          response: {
            ok: false,
            operation: 'resolve-uncertainty',
            project_id: result.project_id,
            status: 'AUDIT_UNCERTAIN',
            thread_id: result.thread_id,
            turn_id: result.turn_id || null,
            code: 'AUDIT_UNCERTAIN',
            reason: truncateUtf8(result.reason || '', 1024)
          }
        };
      }

      return {
        exitCode: 12,
        response: {
          ok: false,
          operation: 'resolve-uncertainty',
          project_id: result.project_id,
          code: 'CLI_RUNTIME_FAILURE',
          error: truncateUtf8(`Unhandled resolve-uncertainty status: ${result.status}`, 1024)
        }
      };
    }

    if (command === 'retire-legacy') {
      const result = await lifecycle.retireLegacyAuditorBootstrapWithoutAuthority({
        projectId,
        registryPort: runtime.registryPort,
        recoveryStore: runtime.recoveryStore
      });

      return {
        exitCode: 0,
        response: {
          ok: true,
          operation: 'retire-legacy',
          project_id: result.project_id,
          operation_id: result.operation_id,
          status: result.status
        }
      };
    }

    // Defensive fallback
    return {
      exitCode: 2,
      response: {
        ok: false,
        code: 'INVALID_CLI_REQUEST',
        error: truncateUtf8(`Unhandled command '${command}'`, 1024)
      }
    };

  } catch (err) {
    const exitCode = mapOperationalErrorToExitCode(err);
    const response = {
      ok: false,
      operation: command,
      project_id: projectId,
      code: err.code || 'CLI_RUNTIME_FAILURE',
      error: truncateUtf8(err.message || 'Operational error occurred', 1024)
    };
    return { exitCode, response };

  } finally {
    // Guaranteed runtime cleanup in finally (Section 16)
    if (runtime && typeof runtime.close === 'function') {
      try {
        await runtime.close();
      } catch {}
    }
  }
}

// Process Entrypoint with Top-Level Error Boundary (Sections 14, 15)
async function main(argv, options = {}, stdout = process.stdout) {
  try {
    const { exitCode, response } = await runCli(argv, options);
    stdout.write(JSON.stringify(response) + '\n');
    return exitCode;
  } catch {
    const topLevelError = {
      ok: false,
      operation: 'cli',
      code: 'TOP_LEVEL_UNEXPECTED_FAILURE',
      error: truncateUtf8('An unexpected process failure occurred', 1024)
    };
    stdout.write(JSON.stringify(topLevelError) + '\n');
    return 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}

module.exports = {
  main,
  runCli,
  parseCliArgs,
  truncateUtf8,
  createAuditorAdapterFactory,
  createAuditorRecoveryCliRuntime,
  mapOperationalErrorToExitCode,
  FORBIDDEN_FLAGS,
  ALLOWED_COMMANDS,
  PROJECT_ID_REGEX
};
