'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const { LIMITS } = require('./lib/broker/contracts');
const { createBrokerRuntime } = require('./lib/broker/runtime');
const { sameFileIdentity } = require('./lib/broker/workspace-state');

const DEFAULT_REQUESTS_DIR = path.join(os.homedir(), '.orchestrator', 'requests');
const MAX_REQUEST_FILE_BYTES = LIMITS.MAX_DIRECTIVE_BYTES + 256 * 1024; // 2 MiB + 256 KiB

// Forbidden routing / execution override flags and keys (Sections 6, 7, 8, 24)
const FORBIDDEN_FLAGS = new Set([
  '--session',
  '--session-id',
  '--worker-session',
  '--worker-session-id',
  '--project-root',
  '--cwd',
  '--workspace',
  '--command',
  '--shell',
  '--exec',
  '--powershell',
  '--bash',
  '--cmd',
  '--argv'
]);

const FORBIDDEN_REQUEST_KEYS = new Set([
  'worker_session',
  'worker_session_id',
  'session',
  'session_id',
  'project_root',
  'cwd',
  'command',
  'shell',
  'exec',
  'powershell',
  'bash',
  'cmd',
  'argv'
]);

const ALLOWED_DISPATCH_REQUEST_KEYS = new Set([
  'schema_version',
  'operation',
  'project_id',
  'work_order_id',
  'expected_workspace_state_id',
  'directive',
  'audit_metadata'
]);

/**
 * Maps semantic error codes to CLI process exit codes (Sections 11, 12).
 */
function mapErrorCodeToExitCode(code, result = {}) {
  if (result.state === 'DISPATCH_UNCERTAIN' || code === 'DISPATCH_UNCERTAIN') {
    return 6;
  }
  switch (code) {
    case 'INVALID_REQUEST':
    case 'PAYLOAD_TOO_LARGE':
      return 2;

    case 'PROJECT_NOT_FOUND':
    case 'DISPATCH_NOT_FOUND':
    case 'DISPATCH_PROJECT_MISMATCH':
      return 3;

    case 'WORKER_BUSY':
    case 'DUPLICATE_WORK_ORDER_CONFLICT':
      return 4;

    case 'STALE_AUDIT_STATE':
      return 5;

    case 'DISPATCH_FAILED':
    case 'DISPATCH_UNCERTAIN':
    case 'WORKER_WAIT_UNAVAILABLE':
    case 'INVALID_WORKER_RESPONSE':
      return 6;

    case 'PROVENANCE_AMBIGUOUS':
      return 7;

    case 'LIFECYCLE_STORE_FAILURE':
    case 'REGISTRY_UNAVAILABLE':
    case 'WORKSPACE_STATE_UNAVAILABLE':
    case 'ILLEGAL_STATE_TRANSITION':
    case 'BROKER_RUNTIME_FAILURE':
    default:
      return 8;
  }
}

/**
 * Strict CLI argument parser (Section 14).
 * Rejects unknown commands, unknown flags, duplicate singleton flags,
 * missing flag values, and unexpected positional arguments.
 */
function parseCliArgs(argv) {
  if (!Array.isArray(argv) || argv.length === 0) {
    return {
      ok: false,
      error: 'Missing command. Available commands: snapshot, worker-status, worker-dispatch, worker-wait'
    };
  }

  const command = argv[0];

  if (command === '--help' || command === 'help' || command === '-h') {
    return {
      ok: true,
      command: 'help',
      flags: {}
    };
  }

  const allowedCommands = new Set(['snapshot', 'worker-status', 'worker-dispatch', 'worker-wait']);
  if (!allowedCommands.has(command)) {
    return {
      ok: false,
      error: `Unknown command '${command}'. Allowed commands: snapshot, worker-status, worker-dispatch, worker-wait`
    };
  }

  const flags = {};
  const allowedFlagsByCommand = {
    'snapshot': new Set(['--project-id']),
    'worker-status': new Set(['--project-id']),
    'worker-dispatch': new Set(['--request-file']),
    'worker-wait': new Set(['--project-id', '--dispatch-id', '--timeout-secs'])
  };

  const allowedForCommand = allowedFlagsByCommand[command];

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];

    if (FORBIDDEN_FLAGS.has(arg)) {
      return {
        ok: false,
        error: `Forbidden routing or execution flag '${arg}' is not permitted`
      };
    }

    if (!arg.startsWith('--')) {
      return {
        ok: false,
        error: `Unexpected positional argument '${arg}'`
      };
    }

    let flagName;
    let flagValue;

    if (arg.includes('=')) {
      const eqIdx = arg.indexOf('=');
      flagName = arg.substring(0, eqIdx);
      flagValue = arg.substring(eqIdx + 1);
    } else {
      flagName = arg;
      if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) {
        return {
          ok: false,
          error: `Missing value for flag '${flagName}'`
        };
      }
      i++;
      flagValue = argv[i];
    }

    if (FORBIDDEN_FLAGS.has(flagName)) {
      return {
        ok: false,
        error: `Forbidden routing or execution flag '${flagName}' is not permitted`
      };
    }

    if (!allowedForCommand.has(flagName)) {
      return {
        ok: false,
        error: `Unknown flag '${flagName}' for command '${command}'`
      };
    }

    if (Object.hasOwn(flags, flagName)) {
      return {
        ok: false,
        error: `Duplicate flag '${flagName}' is not permitted`
      };
    }

    flags[flagName] = flagValue;
  }

  // Validate required flags
  if (command === 'snapshot' || command === 'worker-status') {
    if (!flags['--project-id']) {
      return {
        ok: false,
        error: `Missing required flag '--project-id' for command '${command}'`
      };
    }
  } else if (command === 'worker-dispatch') {
    if (!flags['--request-file']) {
      return {
        ok: false,
        error: `Missing required flag '--request-file' for command '${command}'`
      };
    }
  } else if (command === 'worker-wait') {
    if (!flags['--project-id']) {
      return {
        ok: false,
        error: `Missing required flag '--project-id' for command '${command}'`
      };
    }
    if (!flags['--dispatch-id']) {
      return {
        ok: false,
        error: `Missing required flag '--dispatch-id' for command '${command}'`
      };
    }
  }

  return {
    ok: true,
    command,
    flags
  };
}

/**
 * Handles secure opening, validation, and parsing of dispatch request files (Sections 25-34).
 */
function readAndValidateRequestFile(requestFilePath, options = {}) {
  const fsModule = options.fs || fs;
  const requestsDir = options.requestsDir || DEFAULT_REQUESTS_DIR;

  // 1. Path must be absolute (Section 26)
  if (!path.isAbsolute(requestFilePath)) {
    return {
      ok: false,
      code: 'INVALID_REQUEST',
      error: 'Request file path must be absolute',
      deleteFile: false
    };
  }

  // Ensure requests directory exists and obtain canonical root
  try {
    fsModule.mkdirSync(requestsDir, { recursive: true, mode: 0o700 });
  } catch {}

  let canonicalRequestRoot;
  try {
    canonicalRequestRoot = fsModule.realpathSync(requestsDir);
  } catch (err) {
    return {
      ok: false,
      code: 'INVALID_REQUEST',
      error: `Cannot resolve request directory: ${err.message}`,
      deleteFile: false
    };
  }

  // 2. Pre-lstat: Must exist, be a regular file, and not a symlink (Section 27)
  let statPre;
  try {
    statPre = fsModule.lstatSync(requestFilePath);
  } catch (err) {
    return {
      ok: false,
      code: 'INVALID_REQUEST',
      error: `Cannot stat request file: ${err.message}`,
      deleteFile: false
    };
  }

  if (statPre.isSymbolicLink()) {
    return {
      ok: false,
      code: 'INVALID_REQUEST',
      error: 'Request file cannot be a symbolic link',
      deleteFile: false
    };
  }

  if (!statPre.isFile()) {
    return {
      ok: false,
      code: 'INVALID_REQUEST',
      error: 'Request file must be a regular file',
      deleteFile: false
    };
  }

  // 3. Canonical path must be strictly beneath canonical request root (Section 26, 34)
  let canonicalFilePath;
  try {
    canonicalFilePath = fsModule.realpathSync(requestFilePath);
  } catch (err) {
    return {
      ok: false,
      code: 'INVALID_REQUEST',
      error: `Cannot resolve canonical request file: ${err.message}`,
      deleteFile: false
    };
  }

  const relative = path.relative(canonicalRequestRoot, canonicalFilePath);
  if (relative.startsWith('..') || path.isAbsolute(relative) || relative === '') {
    return {
      ok: false,
      code: 'INVALID_REQUEST',
      error: 'Request file must be strictly inside the orchestrator request directory',
      deleteFile: false
    };
  }

  // 4. File Permissions: POSIX 0600 or stricter (Section 29, 62)
  const isPosix = process.platform !== 'win32';
  const enforcePosix = isPosix || Boolean(options.enforcePosixPermissions);
  if (enforcePosix) {
    const mode = statPre.mode;
    if ((mode & 0o077) !== 0) {
      return {
        ok: false,
        code: 'INVALID_REQUEST',
        error: `Insecure request file permissions (mode 0o${(mode & 0o777).toString(8)}): group and other access must be 0`,
        deleteFile: false
      };
    }
  }

  // 5. Safe open and identity verification (Section 28, 61 / CLIAUTH-04, CLIAUTH-05, CLIAUTH-06)
  const constants = (fsModule && fsModule.constants) || fs.constants || {};
  const openFlags = constants.O_RDONLY | (constants.O_NOFOLLOW || 0);
  let fd;
  try {
    fd = fsModule.openSync(canonicalFilePath, openFlags);
  } catch (err) {
    return {
      ok: false,
      code: 'INVALID_REQUEST',
      error: `Failed to open request file: ${err.message}`,
      deleteFile: false
    };
  }

  let fileBytes;
  try {
    let fdStat;
    try {
      fdStat = fsModule.fstatSync(fd);
    } catch (err) {
      return {
        ok: false,
        code: 'INVALID_REQUEST',
        error: `Cannot fstat opened request file: ${err.message}`,
        deleteFile: false
      };
    }

    let postStat;
    try {
      postStat = fsModule.lstatSync(canonicalFilePath);
    } catch (err) {
      // CLIAUTH-04: If post-open lstat fails, FAIL CLOSED before reading
      return {
        ok: false,
        code: 'INVALID_REQUEST',
        error: `Cannot post-stat request file pathname: ${err.message}`,
        deleteFile: false
      };
    }

    // Section 18: Require preStat.isFile(), fdStat.isFile(), postStat.isFile() all true
    if (
      !statPre || typeof statPre.isFile !== 'function' || !statPre.isFile() ||
      !fdStat || typeof fdStat.isFile !== 'function' || !fdStat.isFile() ||
      !postStat || typeof postStat.isFile !== 'function' || !postStat.isFile()
    ) {
      return {
        ok: false,
        code: 'INVALID_REQUEST',
        error: 'Request file must be a regular file across pre, fd, and post stat checks',
        deleteFile: false
      };
    }

    // CLIAUTH-05: Exact identity proof cannot be optional or skipped
    if (!sameFileIdentity(statPre, fdStat) || !sameFileIdentity(fdStat, postStat)) {
      return {
        ok: false,
        code: 'INVALID_REQUEST',
        error: 'Request file descriptor identity does not match pathname identity (pre/fd/post identity mismatch)',
        deleteFile: false
      };
    }

    // Section 24: File size bound before allocation
    if (typeof fdStat.size !== 'number' || !Number.isSafeInteger(fdStat.size) || fdStat.size < 0) {
      return {
        ok: false,
        code: 'INVALID_REQUEST',
        error: 'Invalid request file size',
        deleteFile: false
      };
    }

    if (fdStat.size > MAX_REQUEST_FILE_BYTES) {
      return {
        ok: false,
        code: 'PAYLOAD_TOO_LARGE',
        error: `Request file size (${fdStat.size} bytes) exceeds maximum limit (${MAX_REQUEST_FILE_BYTES} bytes)`,
        deleteFile: false
      };
    }

    // CLIAUTH-06: Complete fd read loop
    fileBytes = Buffer.alloc(fdStat.size);
    let totalBytesRead = 0;
    while (totalBytesRead < fdStat.size) {
      const bytesToRead = fdStat.size - totalBytesRead;
      const bytesRead = fsModule.readSync(
        fd,
        fileBytes,
        totalBytesRead,
        bytesToRead,
        null
      );
      if (typeof bytesRead !== 'number' || bytesRead <= 0) {
        return {
          ok: false,
          code: 'INVALID_REQUEST',
          error: `Premature EOF: expected ${fdStat.size} bytes but only read ${totalBytesRead} bytes`,
          deleteFile: false
        };
      }
      totalBytesRead += bytesRead;
    }
  } finally {
    try {
      fsModule.closeSync(fd);
    } catch {}
  }

  // At this point, the file is confirmed broker-owned and opened -> arm deleteFile
  // 7. Fatal UTF-8 decoding (Section 31, 57)
  let textContent;
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    textContent = decoder.decode(fileBytes);
  } catch (err) {
    return {
      ok: false,
      code: 'INVALID_REQUEST',
      error: `Request file contains invalid UTF-8: ${err.message}`,
      deleteFile: true,
      filePathToDelete: canonicalFilePath
    };
  }

  // 8. JSON parsing (Section 32, 56)
  let parsed;
  try {
    parsed = JSON.parse(textContent);
  } catch (err) {
    return {
      ok: false,
      code: 'INVALID_REQUEST',
      error: `Request file is not valid JSON: ${err.message}`,
      deleteFile: true,
      filePathToDelete: canonicalFilePath
    };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      code: 'INVALID_REQUEST',
      error: 'Request file must contain a single JSON object',
      deleteFile: true,
      filePathToDelete: canonicalFilePath
    };
  }

  // 9. Schema and routing override validation (Section 23, 24, 35, 63, 64, 65)
  for (const key of Object.keys(parsed)) {
    if (FORBIDDEN_REQUEST_KEYS.has(key)) {
      return {
        ok: false,
        code: 'INVALID_REQUEST',
        error: `Forbidden routing or execution key '${key}' in dispatch request`,
        deleteFile: true,
        filePathToDelete: canonicalFilePath
      };
    }
    if (!ALLOWED_DISPATCH_REQUEST_KEYS.has(key)) {
      return {
        ok: false,
        code: 'INVALID_REQUEST',
        error: `Unknown field '${key}' in dispatch request`,
        deleteFile: true,
        filePathToDelete: canonicalFilePath
      };
    }
  }

  if (parsed.operation !== 'worker_dispatch') {
    return {
      ok: false,
      code: 'INVALID_REQUEST',
      error: `Invalid operation '${parsed.operation}': must be 'worker_dispatch'`,
      deleteFile: true,
      filePathToDelete: canonicalFilePath
    };
  }

  if (parsed.schema_version !== 1) {
    return {
      ok: false,
      code: 'INVALID_REQUEST',
      error: `Invalid schema_version '${parsed.schema_version}': must be 1`,
      deleteFile: true,
      filePathToDelete: canonicalFilePath
    };
  }

  if (typeof parsed.project_id !== 'string' || !parsed.project_id.trim()) {
    return {
      ok: false,
      code: 'INVALID_REQUEST',
      error: "Missing or invalid 'project_id' in dispatch request",
      deleteFile: true,
      filePathToDelete: canonicalFilePath
    };
  }

  if (typeof parsed.work_order_id !== 'string' || !parsed.work_order_id.trim()) {
    return {
      ok: false,
      code: 'INVALID_REQUEST',
      error: "Missing or invalid 'work_order_id' in dispatch request",
      deleteFile: true,
      filePathToDelete: canonicalFilePath
    };
  }

  if (typeof parsed.expected_workspace_state_id !== 'string' || !parsed.expected_workspace_state_id.trim()) {
    return {
      ok: false,
      code: 'INVALID_REQUEST',
      error: "Missing or invalid 'expected_workspace_state_id' in dispatch request",
      deleteFile: true,
      filePathToDelete: canonicalFilePath
    };
  }

  if (typeof parsed.directive !== 'string' || !parsed.directive.trim()) {
    return {
      ok: false,
      code: 'INVALID_REQUEST',
      error: "Missing or invalid 'directive' in dispatch request",
      deleteFile: true,
      filePathToDelete: canonicalFilePath
    };
  }

  return {
    ok: true,
    request: parsed,
    deleteFile: true,
    filePathToDelete: canonicalFilePath
  };
}

/**
 * Main testable CLI runner function (Section 13).
 */
async function runCli(argv, options = {}) {
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;

  function writeOutput(obj) {
    const jsonStr = JSON.stringify(obj) + '\n';
    if (typeof stdout.write === 'function') {
      stdout.write(jsonStr);
    }
  }

  function writeStderr(msg) {
    if (typeof stderr.write === 'function') {
      stderr.write(msg);
    }
  }

  // 1. Parse arguments
  const parsedArgs = parseCliArgs(argv);
  if (!parsedArgs.ok) {
    const response = {
      ok: false,
      code: 'INVALID_REQUEST',
      error: parsedArgs.error
    };
    writeOutput(response);
    return { exitCode: 2, response };
  }

  const { command, flags } = parsedArgs;

  if (command === 'help') {
    const response = {
      ok: true,
      operation: 'help',
      commands: [
        'snapshot',
        'worker-status',
        'worker-dispatch',
        'worker-wait'
      ]
    };
    writeOutput(response);
    return { exitCode: 0, response };
  }

  // 2. Initialize Runtime (Section 43: Failure emits one JSON error and exits 8)
  let runtime = null;
  try {
    if (options.runtime) {
      runtime = options.runtime;
    } else if (typeof options.runtimeFactory === 'function') {
      runtime = options.runtimeFactory(options);
    } else {
      runtime = createBrokerRuntime(options);
    }
  } catch (err) {
    const response = {
      ok: false,
      code: err.code || 'LIFECYCLE_STORE_FAILURE',
      error: `Failed to initialize broker runtime: ${err.message}`
    };
    writeOutput(response);
    return { exitCode: 8, response };
  }

  try {
    const broker = runtime.broker;

    // ------------------------------------------------------------------
    // Command: snapshot (Sections 16, 17, 18)
    // ------------------------------------------------------------------
    if (command === 'snapshot') {
      const projectId = flags['--project-id'];
      const result = await broker.getWorkspaceState(projectId);

      if (!result.ok) {
        const exitCode = mapErrorCodeToExitCode(result.code, result);
        const response = {
          operation: 'snapshot',
          ...result
        };
        writeOutput(response);
        return { exitCode, response };
      }

      const response = {
        operation: 'snapshot',
        ...result
      };
      writeOutput(response);
      return { exitCode: 0, response };
    }

    // ------------------------------------------------------------------
    // Command: worker-status (Sections 19, 20, 21)
    // ------------------------------------------------------------------
    if (command === 'worker-status') {
      const projectId = flags['--project-id'];

      // Section 20: establish exact registry membership without project root availability
      let projects;
      try {
        projects = await runtime.registryPort.listProjects();
      } catch (err) {
        const response = {
          ok: false,
          operation: 'worker-status',
          code: 'REGISTRY_UNAVAILABLE',
          error: `Registry lookup failed: ${err.message}`
        };
        writeOutput(response);
        return { exitCode: 8, response };
      }

      const isRegistered = Array.isArray(projects) && projects.some(p => p && p.project_id === projectId);
      if (!isRegistered) {
        const response = {
          ok: false,
          operation: 'worker-status',
          code: 'PROJECT_NOT_FOUND',
          error: `Project '${projectId}' not found in registry`
        };
        writeOutput(response);
        return { exitCode: 3, response };
      }

      const result = await broker.getWorkerStatus(projectId);
      if (!result.ok) {
        const exitCode = mapErrorCodeToExitCode(result.code, result);
        const response = {
          operation: 'worker-status',
          ...result
        };
        writeOutput(response);
        return { exitCode, response };
      }

      const response = {
        operation: 'worker-status',
        ...result
      };
      writeOutput(response);
      return { exitCode: 0, response };
    }

    // ------------------------------------------------------------------
    // Command: worker-dispatch (Sections 22-38)
    // ------------------------------------------------------------------
    if (command === 'worker-dispatch') {
      const requestFilePath = flags['--request-file'];
      const fileValidation = readAndValidateRequestFile(requestFilePath, options);

      // Section 33: Ephemeral consumed request file deletion
      let cleanupError = null;
      if (fileValidation.deleteFile && fileValidation.filePathToDelete) {
        const fsModule = options.fs || fs;
        try {
          fsModule.unlinkSync(fileValidation.filePathToDelete);
        } catch (err) {
          cleanupError = err;
        }
      }

      if (!fileValidation.ok) {
        if (cleanupError) {
          writeStderr(`Diagnostic: failed to delete request file: ${cleanupError.message}\n`);
        }
        const exitCode = mapErrorCodeToExitCode(fileValidation.code);
        const response = {
          ok: false,
          operation: 'worker-dispatch',
          code: fileValidation.code,
          error: fileValidation.error
        };
        writeOutput(response);
        return { exitCode, response };
      }

      // Strip operation before calling broker (Section 36)
      const { operation: _op, ...dispatchPayload } = fileValidation.request;
      const result = await broker.dispatchWorker(dispatchPayload);

      if (cleanupError) {
        writeStderr(`Diagnostic: failed to delete request file: ${cleanupError.message}\n`);
      }

      if (!result.ok) {
        const exitCode = mapErrorCodeToExitCode(result.code, result);
        const response = {
          operation: 'worker-dispatch',
          ...result
        };
        writeOutput(response);
        return { exitCode, response };
      }

      const response = {
        operation: 'worker-dispatch',
        ...result
      };
      writeOutput(response);
      return { exitCode: 0, response };
    }

    // ------------------------------------------------------------------
    // Command: worker-wait (Sections 39, 40)
    // ------------------------------------------------------------------
    if (command === 'worker-wait') {
      const projectId = flags['--project-id'];
      const dispatchId = flags['--dispatch-id'];

      const waitReq = {
        project_id: projectId,
        dispatch_id: dispatchId
      };

      if (flags['--timeout-secs'] !== undefined) {
        const timeoutNum = Number(flags['--timeout-secs']);
        if (!Number.isFinite(timeoutNum) || timeoutNum < 0 || isNaN(timeoutNum)) {
          const response = {
            ok: false,
            operation: 'worker-wait',
            code: 'INVALID_REQUEST',
            error: `Invalid timeout '${flags['--timeout-secs']}': must be a finite non-negative number`
          };
          writeOutput(response);
          return { exitCode: 2, response };
        }
        waitReq.timeout_secs = timeoutNum;
      }

      const result = await broker.waitWorker(waitReq);
      if (!result.ok) {
        const exitCode = mapErrorCodeToExitCode(result.code, result);
        const response = {
          operation: 'worker-wait',
          ...result
        };
        writeOutput(response);
        return { exitCode, response };
      }

      const response = {
        operation: 'worker-wait',
        ...result
      };
      writeOutput(response);
      return { exitCode: 0, response };
    }

    // Fallthrough (unreachable with strict parser)
    const unkResp = {
      ok: false,
      code: 'INVALID_REQUEST',
      error: `Unhandled command '${command}'`
    };
    writeOutput(unkResp);
    return { exitCode: 2, response: unkResp };

  } finally {
    // Section 42: Guaranteed runtime closure
    if (runtime && typeof runtime.close === 'function') {
      try {
        runtime.close();
      } catch {}
    }
  }
}

// Process entrypoint
if (require.main === module) {
  runCli(process.argv.slice(2)).then(({ exitCode }) => {
    process.exitCode = exitCode;
  }).catch((err) => {
    const errorResponse = {
      ok: false,
      code: 'BROKER_RUNTIME_FAILURE',
      error: err.message
    };
    process.stdout.write(JSON.stringify(errorResponse) + '\n');
    process.exitCode = 8;
  });
}

module.exports = {
  runCli,
  parseCliArgs,
  readAndValidateRequestFile,
  mapErrorCodeToExitCode,
  DEFAULT_REQUESTS_DIR,
  MAX_REQUEST_FILE_BYTES
};
