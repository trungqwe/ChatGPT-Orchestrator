'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { DatabaseSync } = require('node:sqlite');

/**
 * Completion Source Error Codes
 */
const COMPLETION_SOURCE_ERROR_CODES = Object.freeze({
  WORKER_SESSION_UNAVAILABLE: 'WORKER_SESSION_UNAVAILABLE',
  WORKER_SESSION_CONFLICT: 'WORKER_SESSION_CONFLICT',
  COMPLETION_SOURCE_UNAVAILABLE: 'COMPLETION_SOURCE_UNAVAILABLE',
  COMPLETION_SOURCE_INTEGRITY_FAILURE: 'COMPLETION_SOURCE_INTEGRITY_FAILURE',
  MAPPING_CHANGED: 'MAPPING_CHANGED'
});

class CompletionSourceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CompletionSourceError';
    this.code = code;
  }
}

/**
 * Create Antigravity Completion Source (WP-V3-05 / WO-V3-005F)
 *
 * Responsibilities:
 * - Resolve exact AO session to Antigravity transcript path strictly using authoritative AO metadata (A-01, A-02, A-03).
 * - Enforce canonical platform-correct transcript root containment inside brainDir (WAAUTH-01).
 * - Prohibit substring/fuzzy matching of AO project names against registry (WAAUTH-02).
 * - Access AO SQLite database in read-only mode using built-in node:sqlite (A-04, A-05).
 * - Snapshot readable file size at scan start to prevent chasing dynamic concurrent appends (WAAUTH-08).
 * - Enforce maximum transcript record size to bound memory strictly (WAAUTH-09).
 * - Handle incomplete trailing lines safely without failing on concurrent append (A-14, WAAUTH-08).
 * - Enforce strict UTF-8 decoding and fail closed on completed malformed JSON lines (A-14, A-15).
 */
function createAntigravityCompletionSource(options = {}) {
  const customFs = options.fs || fs;
  const brainDir = options.brainDir || process.env.ANTIGRAVITY_BRAIN_DIR || path.join(os.homedir(), '.gemini', 'antigravity-ide', 'brain');
  const aoDbPath = options.aoDbPath || (process.env.AO_DATA_DIR ? path.join(process.env.AO_DATA_DIR, 'ao.db') : path.join(os.homedir(), '.ao', 'data', 'ao.db'));
  const dbFactory = options.dbFactory || ((filePath) => new DatabaseSync(filePath, { readOnly: true }));
  const maxRecordSizeBytes = options.maxRecordSizeBytes || 8 * 1024 * 1024; // 8 MiB default bound (WAAUTH-09)

  const realpathFn = customFs.realpathSync && customFs.realpathSync.native
    ? customFs.realpathSync.native
    : (customFs.realpathSync || fs.realpathSync);

  /**
   * Resolve exact AO session record and determine authoritative transcript location.
   * A-01: No format-based UUID inference.
   * A-02: Exact single row match on sessions.id = ?.
   * A-03: Prefer native_transcript_path if set, else brain/<agent_session_id>/.system_generated/logs/transcript.jsonl.
   * A-19: Verify harness === 'agy'.
   * A-20 / WAAUTH-02: Registry is routing authority; no fuzzy acceptance.
   * WAAUTH-01: Canonical containment inside canonical brainDir.
   */
  function resolveSessionTranscript(sessionId, project) {
    if (typeof sessionId !== 'string' || !sessionId.trim()) {
      throw new CompletionSourceError(
        COMPLETION_SOURCE_ERROR_CODES.WORKER_SESSION_UNAVAILABLE,
        'Worker session_id must be a non-empty string'
      );
    }
    const cleanSessionId = sessionId.trim();

    // 1. Verify and canonicalize brainDir (WAAUTH-01)
    let canonicalBrainDir;
    try {
      const bStat = customFs.statSync(brainDir);
      if (!bStat.isDirectory()) {
        throw new Error(`brainDir '${brainDir}' is not a directory`);
      }
      canonicalBrainDir = realpathFn(brainDir);
    } catch (err) {
      throw new CompletionSourceError(
        COMPLETION_SOURCE_ERROR_CODES.COMPLETION_SOURCE_UNAVAILABLE,
        `Antigravity brain directory is invalid or inaccessible at '${brainDir}': ${err.message}`
      );
    }

    // 2. Verify AO DB existence
    try {
      customFs.statSync(aoDbPath);
    } catch (err) {
      throw new CompletionSourceError(
        COMPLETION_SOURCE_ERROR_CODES.COMPLETION_SOURCE_UNAVAILABLE,
        `AO database is inaccessible at '${aoDbPath}': ${err.message}`
      );
    }

    // 3. Query AO DB in read-only mode
    let db;
    let row;
    try {
      db = dbFactory(aoDbPath);
      const stmt = db.prepare('SELECT id, project_id, harness, agent_session_id, native_transcript_path FROM sessions WHERE id = ?');
      row = stmt.get(cleanSessionId);
    } catch (err) {
      throw new CompletionSourceError(
        COMPLETION_SOURCE_ERROR_CODES.COMPLETION_SOURCE_UNAVAILABLE,
        `Failed to query AO session '${cleanSessionId}': ${err.message}`
      );
    } finally {
      if (db && typeof db.close === 'function') {
        try { db.close(); } catch (_) {}
      }
    }

    if (!row) {
      throw new CompletionSourceError(
        COMPLETION_SOURCE_ERROR_CODES.WORKER_SESSION_UNAVAILABLE,
        `No authoritative AO session row found for id '${cleanSessionId}'`
      );
    }

    // 4. Verify session harness (A-19)
    if (row.harness !== 'agy') {
      throw new CompletionSourceError(
        COMPLETION_SOURCE_ERROR_CODES.WORKER_SESSION_UNAVAILABLE,
        `AO session '${cleanSessionId}' has harness '${row.harness}', expected 'agy'`
      );
    }

    // 5. Verify project identity consistency (WAAUTH-02: exact normalized equality only, NO fuzzy/substring)
    if (row.project_id && project) {
      const aoProj = String(row.project_id).trim().toLowerCase();
      const regProj = project.project_id ? String(project.project_id).trim().toLowerCase() : '';
      const regName = project.project_name ? String(project.project_name).trim().toLowerCase() : '';
      if (aoProj !== regProj && aoProj !== regName) {
        throw new CompletionSourceError(
          COMPLETION_SOURCE_ERROR_CODES.WORKER_SESSION_CONFLICT,
          `AO session '${cleanSessionId}' belongs to project '${row.project_id}', conflicting with registry project '${project.project_id}'`
        );
      }
    }

    // 6. Determine candidate transcript path (A-03, WAAUTH-01)
    let transcriptPath;
    if (row.native_transcript_path && typeof row.native_transcript_path === 'string' && row.native_transcript_path.trim()) {
      const cleanNative = row.native_transcript_path.trim();
      if (!path.isAbsolute(cleanNative)) {
        throw new CompletionSourceError(
          COMPLETION_SOURCE_ERROR_CODES.COMPLETION_SOURCE_UNAVAILABLE,
          `native_transcript_path must be an absolute path: '${cleanNative}'`
        );
      }
      transcriptPath = cleanNative;
    } else if (row.agent_session_id && typeof row.agent_session_id === 'string' && row.agent_session_id.trim()) {
      const cleanAgentId = row.agent_session_id.trim();
      // Reject path traversal characters in agent_session_id
      if (cleanAgentId.includes('..') || cleanAgentId.includes('/') || cleanAgentId.includes('\\')) {
        throw new CompletionSourceError(
          COMPLETION_SOURCE_ERROR_CODES.COMPLETION_SOURCE_UNAVAILABLE,
          `agent_session_id contains invalid path traversal characters: '${cleanAgentId}'`
        );
      }
      transcriptPath = path.join(brainDir, cleanAgentId, '.system_generated', 'logs', 'transcript.jsonl');
    } else {
      throw new CompletionSourceError(
        COMPLETION_SOURCE_ERROR_CODES.WORKER_SESSION_UNAVAILABLE,
        `AO session '${cleanSessionId}' lacks provider conversation identity (agent_session_id / native_transcript_path empty)`
      );
    }

    // 7. Verify filesystem existence and regular file status (A-25)
    let stat;
    try {
      stat = customFs.statSync(transcriptPath);
    } catch (err) {
      throw new CompletionSourceError(
        COMPLETION_SOURCE_ERROR_CODES.COMPLETION_SOURCE_UNAVAILABLE,
        `Antigravity transcript not accessible at '${transcriptPath}': ${err.message}`
      );
    }

    if (!stat.isFile()) {
      throw new CompletionSourceError(
        COMPLETION_SOURCE_ERROR_CODES.COMPLETION_SOURCE_UNAVAILABLE,
        `Antigravity transcript at '${transcriptPath}' is not a regular file`
      );
    }

    // 8. Canonicalize transcript path and prove canonical containment (WAAUTH-01 / Section 6, 7)
    let canonicalTranscript;
    try {
      canonicalTranscript = realpathFn(transcriptPath);
    } catch (err) {
      throw new CompletionSourceError(
        COMPLETION_SOURCE_ERROR_CODES.COMPLETION_SOURCE_UNAVAILABLE,
        `Cannot prove canonical path for transcript '${transcriptPath}': ${err.message}`
      );
    }

    const rel = path.relative(canonicalBrainDir, canonicalTranscript);
    if (rel.startsWith('..') || path.isAbsolute(rel) || rel === '') {
      throw new CompletionSourceError(
        COMPLETION_SOURCE_ERROR_CODES.COMPLETION_SOURCE_UNAVAILABLE,
        `Transcript '${transcriptPath}' resolves outside canonical brainDir '${canonicalBrainDir}'`
      );
    }

    return {
      sessionId: cleanSessionId,
      agentSessionId: row.agent_session_id || '',
      nativeTranscriptPath: row.native_transcript_path || '',
      transcriptPath: canonicalTranscript
    };
  }

  /**
   * Scan resolved session transcript sequentially with snapshot size boundary (WAAUTH-08, WAAUTH-09).
   * Memory is strictly bounded: reads in 64 KiB chunks, maximum line size enforced.
   * Trailing partial line is ignored safely for concurrent append.
   */
  async function scanResolvedSession(resolution, visitor, scanOptions = {}) {
    if (!resolution || !resolution.transcriptPath) {
      throw new CompletionSourceError(
        COMPLETION_SOURCE_ERROR_CODES.COMPLETION_SOURCE_UNAVAILABLE,
        'Invalid resolution object provided to scanResolvedSession'
      );
    }
    const transcriptPath = resolution.transcriptPath;
    const recordLimit = scanOptions.maxRecordSizeBytes || maxRecordSizeBytes;
    const deadline = scanOptions.deadline;
    const clock = scanOptions.clock || options.clock;

    let fd;
    try {
      fd = customFs.openSync(transcriptPath, 'r');
    } catch (err) {
      throw new CompletionSourceError(
        COMPLETION_SOURCE_ERROR_CODES.COMPLETION_SOURCE_UNAVAILABLE,
        `Cannot open transcript '${transcriptPath}': ${err.message}`
      );
    }

    // WAAUTH-08: Snapshot readable file size S at scan start
    let snapshotSize;
    try {
      const fStat = customFs.fstatSync(fd);
      snapshotSize = fStat.size;
    } catch (err) {
      if (fd !== undefined) {
        try { customFs.closeSync(fd); } catch (_) {}
      }
      throw new CompletionSourceError(
        COMPLETION_SOURCE_ERROR_CODES.COMPLETION_SOURCE_UNAVAILABLE,
        `Failed to stat transcript '${transcriptPath}': ${err.message}`
      );
    }

    if (snapshotSize === 0) {
      if (fd !== undefined) {
        try { customFs.closeSync(fd); } catch (_) {}
      }
      return null;
    }

    const chunkSize = 64 * 1024;
    const buf = Buffer.alloc(chunkSize);
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let remainder = '';
    let physicalIndex = 0;
    let stopResult = null;
    let totalBytesRead = 0;

    try {
      while (totalBytesRead < snapshotSize) {
        // Check monotonic deadline between chunks if provided (Section 23)
        if (deadline !== undefined && clock && typeof clock.monotonic === 'function') {
          if (clock.monotonic() >= deadline) {
            break;
          }
        }

        const toRead = Math.min(chunkSize, snapshotSize - totalBytesRead);
        const bytesRead = customFs.readSync(fd, buf, 0, toRead, null);

        if (bytesRead === 0) {
          // File became shorter during scan (WAAUTH-08 / Section 21)
          throw new CompletionSourceError(
            COMPLETION_SOURCE_ERROR_CODES.COMPLETION_SOURCE_UNAVAILABLE,
            `Transcript file was truncated during scan (expected ${snapshotSize} bytes, read ${totalBytesRead})`
          );
        }
        totalBytesRead += bytesRead;

        let text;
        try {
          text = decoder.decode(buf.subarray(0, bytesRead), { stream: true });
        } catch (decErr) {
          throw new CompletionSourceError(
            COMPLETION_SOURCE_ERROR_CODES.COMPLETION_SOURCE_INTEGRITY_FAILURE,
            `Transcript contains invalid UTF-8 bytes: ${decErr.message}`
          );
        }

        const combined = remainder + text;
        const lines = combined.split('\n');
        remainder = lines.pop(); // The last piece is either trailing incomplete line or trailing empty after \n

        // WAAUTH-09: Check remainder size bound
        if (Buffer.byteLength(remainder, 'utf8') > recordLimit) {
          throw new CompletionSourceError(
            COMPLETION_SOURCE_ERROR_CODES.COMPLETION_SOURCE_INTEGRITY_FAILURE,
            `Transcript record exceeds maximum allowable size (${recordLimit} bytes)`
          );
        }

        for (const rawLine of lines) {
          if (Buffer.byteLength(rawLine, 'utf8') > recordLimit) {
            throw new CompletionSourceError(
              COMPLETION_SOURCE_ERROR_CODES.COMPLETION_SOURCE_INTEGRITY_FAILURE,
              `Transcript record exceeds maximum allowable size (${recordLimit} bytes)`
            );
          }

          const line = rawLine.replace(/\r$/, '');
          if (!line.trim()) {
            continue;
          }

          let record;
          try {
            record = JSON.parse(line);
          } catch (parseErr) {
            throw new CompletionSourceError(
              COMPLETION_SOURCE_ERROR_CODES.COMPLETION_SOURCE_INTEGRITY_FAILURE,
              `Transcript record at index ${physicalIndex} is malformed JSON: ${parseErr.message}`
            );
          }

          if (visitor) {
            const vRes = await visitor(record, physicalIndex, resolution);
            if (vRes && (vRes.stop || vRes.done)) {
              stopResult = vRes;
              return stopResult;
            }
          }
          physicalIndex++;
        }
      }

      // Flush final stream bytes
      try {
        decoder.decode();
      } catch (flushErr) {
        throw new CompletionSourceError(
          COMPLETION_SOURCE_ERROR_CODES.COMPLETION_SOURCE_INTEGRITY_FAILURE,
          `Transcript trailing bytes are invalid UTF-8: ${flushErr.message}`
        );
      }

      // Trailing remainder at snapshot boundary:
      // If non-empty, file did not end with \n within snapshotted bytes.
      // Withheld safely without treating as malformed (A-14, WAAUTH-08).
    } finally {
      if (fd !== undefined) {
        try { customFs.closeSync(fd); } catch (_) {}
      }
    }

    return stopResult;
  }

  /**
   * Scan session transcript sequentially with a visitor callback.
   */
  async function scanSession(sessionId, project, visitor, scanOptions = {}) {
    const resolution = api.resolveSessionTranscript(sessionId, project);
    return scanResolvedSession(resolution, visitor, scanOptions);
  }

  const api = {
    resolveSessionTranscript,
    scanResolvedSession,
    scanSession,
    brainDir,
    aoDbPath
  };

  return api;
}

module.exports = {
  createAntigravityCompletionSource,
  COMPLETION_SOURCE_ERROR_CODES,
  CompletionSourceError
};
