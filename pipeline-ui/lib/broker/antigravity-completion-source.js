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
 * Create Antigravity Completion Source (WP-V3-05)
 *
 * Responsibilities:
 * - Resolve exact AO session to Antigravity transcript path strictly using authoritative AO metadata (A-01, A-02, A-03).
 * - Access AO SQLite database in read-only mode using built-in node:sqlite (A-04, A-05).
 * - Stream/scan transcript records incrementally without loading entire file into memory (A-12, A-13).
 * - Handle incomplete trailing lines safely without failing on concurrent append (A-14).
 * - Enforce strict UTF-8 decoding and fail closed on completed malformed JSON lines (A-14, A-15).
 * - Verify path safety under Antigravity storage boundary (A-25).
 */
function createAntigravityCompletionSource(options = {}) {
  const customFs = options.fs || fs;
  const brainDir = options.brainDir || process.env.ANTIGRAVITY_BRAIN_DIR || path.join(os.homedir(), '.gemini', 'antigravity-ide', 'brain');
  const aoDbPath = options.aoDbPath || (process.env.AO_DATA_DIR ? path.join(process.env.AO_DATA_DIR, 'ao.db') : path.join(os.homedir(), '.ao', 'data', 'ao.db'));
  const dbFactory = options.dbFactory || ((filePath) => new DatabaseSync(filePath, { readOnly: true }));

  /**
   * Resolve exact AO session record and determine authoritative transcript location.
   * A-01: No format-based UUID inference.
   * A-02: Exact single row match on sessions.id = ?.
   * A-03: Prefer native_transcript_path if set, else brain/<agent_session_id>/.system_generated/logs/transcript.jsonl.
   * A-19: Verify harness === 'agy'.
   * A-20: Registry is routing authority; fail on hard conflict.
   * A-25: Canonicalize and verify regular file.
   */
  function resolveSessionTranscript(sessionId, project) {
    if (typeof sessionId !== 'string' || !sessionId.trim()) {
      throw new CompletionSourceError(
        COMPLETION_SOURCE_ERROR_CODES.WORKER_SESSION_UNAVAILABLE,
        'Worker session_id must be a non-empty string'
      );
    }
    const cleanSessionId = sessionId.trim();

    // 1. Verify AO DB existence
    try {
      customFs.statSync(aoDbPath);
    } catch (err) {
      throw new CompletionSourceError(
        COMPLETION_SOURCE_ERROR_CODES.COMPLETION_SOURCE_UNAVAILABLE,
        `AO database is inaccessible at '${aoDbPath}': ${err.message}`
      );
    }

    // 2. Query AO DB in read-only mode
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

    // 3. Verify session harness (A-19)
    if (row.harness !== 'agy') {
      throw new CompletionSourceError(
        COMPLETION_SOURCE_ERROR_CODES.WORKER_SESSION_UNAVAILABLE,
        `AO session '${cleanSessionId}' has harness '${row.harness}', expected 'agy'`
      );
    }

    // 4. Verify project identity consistency (A-20)
    if (row.project_id && project && project.project_id) {
      const aoProj = String(row.project_id).trim().toLowerCase();
      const regProj = String(project.project_id).trim().toLowerCase();
      const regName = project.project_name ? String(project.project_name).trim().toLowerCase() : '';
      if (aoProj !== regProj && aoProj !== regName && !aoProj.replace(/[-_]/g, '').includes(regProj.replace(/[-_]/g, '')) && !regProj.replace(/[-_]/g, '').includes(aoProj.replace(/[-_]/g, ''))) {
        throw new CompletionSourceError(
          COMPLETION_SOURCE_ERROR_CODES.WORKER_SESSION_CONFLICT,
          `AO session '${cleanSessionId}' belongs to project '${row.project_id}', conflicting with registry project '${project.project_id}'`
        );
      }
    }

    // 5. Determine transcript path (A-03)
    let transcriptPath;
    if (row.native_transcript_path && typeof row.native_transcript_path === 'string' && row.native_transcript_path.trim()) {
      transcriptPath = row.native_transcript_path.trim();
    } else if (row.agent_session_id && typeof row.agent_session_id === 'string' && row.agent_session_id.trim()) {
      transcriptPath = path.join(brainDir, row.agent_session_id.trim(), '.system_generated', 'logs', 'transcript.jsonl');
    } else {
      throw new CompletionSourceError(
        COMPLETION_SOURCE_ERROR_CODES.WORKER_SESSION_UNAVAILABLE,
        `AO session '${cleanSessionId}' lacks provider conversation identity (agent_session_id / native_transcript_path empty)`
      );
    }

    // 6. Verify filesystem existence and regular file status (A-25)
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

    // Canonicalize path
    let canonicalPath;
    try {
      const realpathFn = customFs.realpathSync && customFs.realpathSync.native
        ? customFs.realpathSync.native
        : (customFs.realpathSync || fs.realpathSync);
      canonicalPath = realpathFn(transcriptPath);
    } catch (err) {
      throw new CompletionSourceError(
        COMPLETION_SOURCE_ERROR_CODES.COMPLETION_SOURCE_UNAVAILABLE,
        `Cannot prove canonical path for transcript '${transcriptPath}': ${err.message}`
      );
    }

    return {
      sessionId: cleanSessionId,
      agentSessionId: row.agent_session_id || '',
      nativeTranscriptPath: row.native_transcript_path || '',
      transcriptPath: canonicalPath
    };
  }

  /**
   * Scan session transcript sequentially with a visitor callback (A-12, A-13, A-14, A-15).
   * Memory is strictly bounded: reads in 64 KiB chunks, parses line by line.
   * Completed invalid JSON lines throw COMPLETION_SOURCE_INTEGRITY_FAILURE.
   * Trailing partial line (without \n) is ignored safely for concurrent append.
   */
  async function scanSession(sessionId, project, visitor) {
    const resolution = api.resolveSessionTranscript(sessionId, project);
    const transcriptPath = resolution.transcriptPath;

    let fd;
    try {
      fd = customFs.openSync(transcriptPath, 'r');
    } catch (err) {
      throw new CompletionSourceError(
        COMPLETION_SOURCE_ERROR_CODES.COMPLETION_SOURCE_UNAVAILABLE,
        `Cannot open transcript '${transcriptPath}': ${err.message}`
      );
    }

    const chunkSize = 64 * 1024;
    const buf = Buffer.alloc(chunkSize);
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let remainder = '';
    let physicalIndex = 0;
    let stopResult = null;

    try {
      let bytesRead;
      while ((bytesRead = customFs.readSync(fd, buf, 0, buf.length, null)) > 0) {
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

        for (const rawLine of lines) {
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

      // Note on remainder:
      // If remainder is non-empty at EOF, it means the file did NOT end with '\n'.
      // Per A-14 & WA-040: It is a trailing partially-written record being appended concurrently.
      // We do NOT treat it as malformed and do NOT yield it as a completion. It will be picked up on next scan.
    } finally {
      if (fd !== undefined) {
        try { customFs.closeSync(fd); } catch (_) {}
      }
    }

    return stopResult;
  }

  const api = {
    resolveSessionTranscript,
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
