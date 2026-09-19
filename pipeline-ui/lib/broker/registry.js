'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

/**
 * Stable Machine-Readable Registry Error Codes (A-06)
 */
const REGISTRY_ERROR_CODES = Object.freeze({
  REGISTRY_CORRUPT: 'REGISTRY_CORRUPT',
  REGISTRY_SCHEMA_INVALID: 'REGISTRY_SCHEMA_INVALID',
  PROJECT_NOT_FOUND: 'PROJECT_NOT_FOUND',
  DUPLICATE_PROJECT_ROOT: 'DUPLICATE_PROJECT_ROOT',
  INVALID_PROJECT_ROOT: 'INVALID_PROJECT_ROOT',
  PROJECT_ROOT_UNAVAILABLE: 'PROJECT_ROOT_UNAVAILABLE',
  REGISTRY_PERSIST_FAILED: 'REGISTRY_PERSIST_FAILED',
  REGISTRY_MIGRATION_REQUIRED: 'REGISTRY_MIGRATION_REQUIRED',
  REGISTRY_MIGRATION_SOURCE_CHANGED: 'REGISTRY_MIGRATION_SOURCE_CHANGED',
  REGISTRY_BACKUP_FAILED: 'REGISTRY_BACKUP_FAILED',
  REGISTRY_MIGRATION_PERSIST_FAILED: 'REGISTRY_MIGRATION_PERSIST_FAILED',
  REGISTRY_MIGRATION_VERIFY_FAILED: 'REGISTRY_MIGRATION_VERIFY_FAILED',
  REGISTRY_MIGRATION_ROLLBACK_FAILED: 'REGISTRY_MIGRATION_ROLLBACK_FAILED',
  AUDITOR_CWD_MISMATCH: 'AUDITOR_CWD_MISMATCH',
  INVALID_REQUEST: 'INVALID_REQUEST'
});

/**
 * Structured Registry Error
 */
class RegistryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RegistryError';
    this.code = code;
  }
}

/**
 * Project ID regex format: ^[a-z0-9][a-z0-9._-]{0,127}$
 * Rejects empty strings, whitespace, path separators, drive prefixes, and relative segments.
 */
const PROJECT_ID_REGEX = /^[a-z0-9][a-z0-9._-]{0,127}$/;

/**
 * Exact schema allowlists (A-04: Strict complete schema)
 */
const ALLOWED_TOP_LEVEL_KEYS = new Set(['schema_version', 'projects']);
const ALLOWED_PROJECT_KEYS = new Set([
  'project_id',
  'project_name',
  'project_root',
  'worker',
  'auditor',
  'policy'
]);
const ALLOWED_WORKER_KEYS = new Set(['engine', 'session_id', 'enabled', 'model_policy']);
const ALLOWED_AUDITOR_KEYS = new Set([
  'engine',
  'thread_id',
  'cwd',
  'enabled',
  'model_policy'
]);
const ALLOWED_POLICY_KEYS = new Set([
  'max_active_dispatches',
  'require_workspace_state'
]);

function hasOnlyAllowedKeys(obj, allowedSet) {
  for (const key of Object.keys(obj)) {
    if (!allowedSet.has(key)) {
      return false;
    }
  }
  return true;
}

function getAuditorBindingState(auditor) {
  if (auditor.thread_id === null) return 'AUDITOR_REGISTRATION_REQUIRED';
  return auditor.enabled ? 'AUDITOR_BOUND_READY' : 'AUDITOR_BOUND_DISABLED';
}

const V1_WORKER_KEYS = new Set(['engine', 'session_id', 'enabled']);
const V1_AUDITOR_KEYS = new Set(['engine', 'task_id', 'task_id_verified', 'expected_model_label', 'mode', 'managed_by_orchestrator']);

function validateV1Document(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc) || !hasOnlyAllowedKeys(doc, ALLOWED_TOP_LEVEL_KEYS) || doc.schema_version !== 1 || !doc.projects || typeof doc.projects !== 'object' || Array.isArray(doc.projects)) {
    throw new RegistryError(REGISTRY_ERROR_CODES.REGISTRY_SCHEMA_INVALID, 'Invalid Registry v1 document');
  }
  const roots = new Set();
  for (const [id, p] of Object.entries(doc.projects)) {
    if (!p || typeof p !== 'object' || Array.isArray(p) || !hasOnlyAllowedKeys(p, ALLOWED_PROJECT_KEYS) || id !== p.project_id || !PROJECT_ID_REGEX.test(id) || typeof p.project_name !== 'string' || !p.project_name.trim()) {
      throw new RegistryError(REGISTRY_ERROR_CODES.REGISTRY_SCHEMA_INVALID, `Invalid v1 project: ${id}`);
    }
    validateProjectRootShape(p.project_root);
    if (!p.worker || typeof p.worker !== 'object' || Array.isArray(p.worker) || !hasOnlyAllowedKeys(p.worker, V1_WORKER_KEYS) || p.worker.engine !== 'antigravity' || typeof p.worker.session_id !== 'string' || !p.worker.session_id.trim() || p.worker.enabled !== true) {
      throw new RegistryError(REGISTRY_ERROR_CODES.REGISTRY_SCHEMA_INVALID, `Invalid v1 worker: ${id}`);
    }
    const a = p.auditor;
    if (!a || typeof a !== 'object' || Array.isArray(a) || !hasOnlyAllowedKeys(a, V1_AUDITOR_KEYS) || a.engine !== 'codex' || typeof a.task_id !== 'string' || !a.task_id.trim() || typeof a.task_id_verified !== 'boolean' || typeof a.expected_model_label !== 'string' || !a.expected_model_label.trim() || a.mode !== 'full-harness' || a.managed_by_orchestrator !== false) {
      throw new RegistryError(REGISTRY_ERROR_CODES.REGISTRY_SCHEMA_INVALID, `Invalid v1 auditor: ${id}`);
    }
    if (!p.policy || typeof p.policy !== 'object' || Array.isArray(p.policy) || !hasOnlyAllowedKeys(p.policy, ALLOWED_POLICY_KEYS) || p.policy.max_active_dispatches !== 1 || p.policy.require_workspace_state !== true) {
      throw new RegistryError(REGISTRY_ERROR_CODES.REGISTRY_SCHEMA_INVALID, `Invalid v1 policy: ${id}`);
    }
    const key = computeRootIdentityKey(p.project_root);
    if (roots.has(key)) throw new RegistryError(REGISTRY_ERROR_CODES.DUPLICATE_PROJECT_ROOT, 'Duplicate v1 project root');
    roots.add(key);
  }
  return doc;
}

/**
 * Compute deterministic identity key for root path comparisons on Windows / POSIX.
 * Handles drive letter casing, slash direction, trailing separators, and relative segments.
 */
function computeRootIdentityKey(rootPath) {
  if (typeof rootPath !== 'string' || !rootPath.trim()) {
    return '';
  }

  // Normalize slashes to backslashes on Windows, or forward slashes on POSIX
  let normalized = path.normalize(rootPath.trim());

  // Remove trailing slashes unless it's the root directory (e.g. C:\ or /)
  if (normalized.length > 3 && (normalized.endsWith('\\') || normalized.endsWith('/'))) {
    normalized = normalized.slice(0, -1);
  } else if (normalized.length > 1 && normalized.endsWith('/') && !normalized.includes(':')) {
    normalized = normalized.slice(0, -1);
  }

  // Windows case-insensitive identity
  if (process.platform === 'win32' || /^[a-zA-Z]:/.test(normalized)) {
    // Unify drive letter and path casing for identity comparison
    normalized = normalized.replace(/\//g, '\\').toLowerCase();
  }

  return normalized;
}

/**
 * Validate project root path shape (REG-01).
 * Pure structural check: does NOT touch filesystem state.
 * Requires an absolute, fully-qualified drive/UNC path on Windows, or absolute path on POSIX.
 * Rejects relative paths (., .., ./foo, foo/bar), root-relative paths (\, \Code\App),
 * and drive-relative paths (C:foo).
 */
function validateProjectRootShape(rootPath, platform = process.platform) {
  if (typeof rootPath !== 'string' || !rootPath.trim()) {
    throw new RegistryError(
      REGISTRY_ERROR_CODES.REGISTRY_SCHEMA_INVALID,
      'Project root must be a non-empty string'
    );
  }

  const trimmed = rootPath.trim();

  if (platform === 'win32') {
    // Reject relative prefixes explicitly
    if (
      trimmed === '.' ||
      trimmed === '..' ||
      trimmed.startsWith('./') ||
      trimmed.startsWith('.\\') ||
      trimmed.startsWith('../') ||
      trimmed.startsWith('..\\')
    ) {
      throw new RegistryError(
        REGISTRY_ERROR_CODES.REGISTRY_SCHEMA_INVALID,
        `Project root must be a fully-qualified absolute path, got relative: '${trimmed}'`
      );
    }

    // Fully qualified Windows path must be:
    // 1. Drive letter followed by colon and separator (e.g. C:\ or C:/)
    // 2. UNC path (e.g. \\server\share\...)
    const isDriveAbsolute = /^[a-zA-Z]:[/\\]/.test(trimmed);
    const isUnc = /^\\\\[^/\\]+[/\\][^/\\]+/.test(trimmed);

    if (!isDriveAbsolute && !isUnc) {
      throw new RegistryError(
        REGISTRY_ERROR_CODES.REGISTRY_SCHEMA_INVALID,
        `Project root must be a fully-qualified Windows drive or UNC path: '${trimmed}'`
      );
    }
  } else {
    // POSIX
    if (
      !trimmed.startsWith('/') ||
      trimmed === '.' ||
      trimmed === '..' ||
      trimmed.startsWith('./') ||
      trimmed.startsWith('../')
    ) {
      throw new RegistryError(
        REGISTRY_ERROR_CODES.REGISTRY_SCHEMA_INVALID,
        `Project root must be an absolute path starting with '/': '${trimmed}'`
      );
    }
  }

  return trimmed;
}

/**
 * Validate and canonicalize project root.
 * Applies strict structural shape rules (REG-01), verifies that the path exists on disk,
 * is a directory, and that realpath proves canonical identity (REG-02: fails closed).
 */
function canonicalizeProjectRoot(rootPath, customFs = fs, platform = process.platform) {
  // First apply the structural shape contract (Section 9 / REG-01)
  try {
    validateProjectRootShape(rootPath, platform);
  } catch (err) {
    throw new RegistryError(
      REGISTRY_ERROR_CODES.INVALID_PROJECT_ROOT,
      `Project root shape invalid: ${err.message}`
    );
  }

  const trimmed = rootPath.trim();

  // Check filesystem existence and directory status
  let stat;
  try {
    stat = customFs.statSync(trimmed);
  } catch (err) {
    throw new RegistryError(
      REGISTRY_ERROR_CODES.INVALID_PROJECT_ROOT,
      `Project root does not exist or is inaccessible: '${trimmed}' (${err.message})`
    );
  }

  if (!stat.isDirectory()) {
    throw new RegistryError(
      REGISTRY_ERROR_CODES.INVALID_PROJECT_ROOT,
      `Project root must be a directory, not a regular file: '${trimmed}'`
    );
  }

  // Resolve canonical filesystem path via realpath (REG-02: fails closed without fallback)
  let canonicalRoot;
  try {
    const realpathFn = customFs.realpathSync && customFs.realpathSync.native
      ? customFs.realpathSync.native
      : (customFs.realpathSync || fs.realpathSync);
    canonicalRoot = realpathFn(trimmed);
  } catch (err) {
    throw new RegistryError(
      REGISTRY_ERROR_CODES.INVALID_PROJECT_ROOT,
      `Cannot prove canonical filesystem identity for project root '${trimmed}': ${err.message}`
    );
  }

  const identityKey = computeRootIdentityKey(canonicalRoot);

  return {
    canonicalRoot,
    identityKey
  };
}

/**
 * Validate a project record against the strict schema.
 * Rejects any unknown or missing fields, invalid engines, or bad policy values.
 */
function validateProjectRecord(project) {
  if (!project || typeof project !== 'object' || Array.isArray(project)) {
    throw new RegistryError(
      REGISTRY_ERROR_CODES.REGISTRY_SCHEMA_INVALID,
      'Project record must be a non-null object'
    );
  }

  if (!hasOnlyAllowedKeys(project, ALLOWED_PROJECT_KEYS)) {
    const unknownKeys = Object.keys(project).filter((k) => !ALLOWED_PROJECT_KEYS.has(k));
    throw new RegistryError(
      REGISTRY_ERROR_CODES.REGISTRY_SCHEMA_INVALID,
      `Project record contains unknown fields: ${unknownKeys.join(', ')}`
    );
  }

  // 1. project_id
  if (typeof project.project_id !== 'string' || !PROJECT_ID_REGEX.test(project.project_id)) {
    throw new RegistryError(
      REGISTRY_ERROR_CODES.REGISTRY_SCHEMA_INVALID,
      `Invalid project_id: '${project.project_id}'. Must match pattern ${PROJECT_ID_REGEX}`
    );
  }

  // 2. project_name
  if (typeof project.project_name !== 'string' || !project.project_name.trim()) {
    throw new RegistryError(
      REGISTRY_ERROR_CODES.REGISTRY_SCHEMA_INVALID,
      'project_name must be a non-empty string'
    );
  }

  // 3. project_root
  if (typeof project.project_root !== 'string' || !project.project_root.trim()) {
    throw new RegistryError(
      REGISTRY_ERROR_CODES.REGISTRY_SCHEMA_INVALID,
      'project_root must be a non-empty string'
    );
  }

  // 4. worker
  if (!project.worker || typeof project.worker !== 'object' || Array.isArray(project.worker)) {
    throw new RegistryError(
      REGISTRY_ERROR_CODES.REGISTRY_SCHEMA_INVALID,
      'worker descriptor must be a non-null object'
    );
  }
  if (!hasOnlyAllowedKeys(project.worker, ALLOWED_WORKER_KEYS)) {
    const unknownKeys = Object.keys(project.worker).filter((k) => !ALLOWED_WORKER_KEYS.has(k));
    throw new RegistryError(
      REGISTRY_ERROR_CODES.REGISTRY_SCHEMA_INVALID,
      `worker descriptor contains unknown fields: ${unknownKeys.join(', ')}`
    );
  }
  if (project.worker.engine !== 'antigravity') {
    throw new RegistryError(
      REGISTRY_ERROR_CODES.REGISTRY_SCHEMA_INVALID,
      `worker.engine must be 'antigravity', got '${project.worker.engine}'`
    );
  }
  if (typeof project.worker.session_id !== 'string' || !project.worker.session_id.trim()) {
    throw new RegistryError(
      REGISTRY_ERROR_CODES.REGISTRY_SCHEMA_INVALID,
      'worker.session_id must be a non-empty string'
    );
  }
  if (project.worker.enabled !== true) {
    throw new RegistryError(
      REGISTRY_ERROR_CODES.REGISTRY_SCHEMA_INVALID,
      `worker.enabled must be strictly true in v3 MVP, got ${project.worker.enabled}`
    );
  }
  if (!['worker_economy', 'worker_standard'].includes(project.worker.model_policy)) {
    throw new RegistryError(REGISTRY_ERROR_CODES.REGISTRY_SCHEMA_INVALID, 'Invalid worker.model_policy');
  }

  // 5. auditor
  if (!project.auditor || typeof project.auditor !== 'object' || Array.isArray(project.auditor)) {
    throw new RegistryError(
      REGISTRY_ERROR_CODES.REGISTRY_SCHEMA_INVALID,
      'auditor descriptor must be a non-null object'
    );
  }
  if (!hasOnlyAllowedKeys(project.auditor, ALLOWED_AUDITOR_KEYS)) {
    const unknownKeys = Object.keys(project.auditor).filter((k) => !ALLOWED_AUDITOR_KEYS.has(k));
    throw new RegistryError(
      REGISTRY_ERROR_CODES.REGISTRY_SCHEMA_INVALID,
      `auditor descriptor contains unknown fields: ${unknownKeys.join(', ')}`
    );
  }
  if (project.auditor.engine !== 'codex_app_server') {
    throw new RegistryError(REGISTRY_ERROR_CODES.REGISTRY_SCHEMA_INVALID, 'auditor.engine must be codex_app_server');
  }
  const threadId = project.auditor.thread_id;
  if (threadId !== null && (typeof threadId !== 'string' || !threadId.trim() || Buffer.byteLength(threadId, 'utf8') > 512 || /[\x00-\x1f\x7f]/.test(threadId))) {
    throw new RegistryError(REGISTRY_ERROR_CODES.REGISTRY_SCHEMA_INVALID, 'auditor.thread_id must be null or a bounded opaque ID without controls');
  }
  if (typeof project.auditor.enabled !== 'boolean' || (project.auditor.enabled && threadId === null)) {
    throw new RegistryError(REGISTRY_ERROR_CODES.REGISTRY_SCHEMA_INVALID, 'auditor.enabled requires a bound thread_id');
  }
  if (!['auditor_fast', 'auditor_standard', 'auditor_deep'].includes(project.auditor.model_policy)) {
    throw new RegistryError(REGISTRY_ERROR_CODES.REGISTRY_SCHEMA_INVALID, 'Invalid auditor.model_policy');
  }
  if (typeof project.auditor.cwd !== 'string' || !project.auditor.cwd.trim()) {
    throw new RegistryError(REGISTRY_ERROR_CODES.REGISTRY_SCHEMA_INVALID, 'auditor.cwd must be an absolute project path');
  }

  // 6. policy
  if (!project.policy || typeof project.policy !== 'object' || Array.isArray(project.policy)) {
    throw new RegistryError(
      REGISTRY_ERROR_CODES.REGISTRY_SCHEMA_INVALID,
      'policy descriptor must be a non-null object'
    );
  }
  if (!hasOnlyAllowedKeys(project.policy, ALLOWED_POLICY_KEYS)) {
    const unknownKeys = Object.keys(project.policy).filter((k) => !ALLOWED_POLICY_KEYS.has(k));
    throw new RegistryError(
      REGISTRY_ERROR_CODES.REGISTRY_SCHEMA_INVALID,
      `policy descriptor contains unknown fields: ${unknownKeys.join(', ')}`
    );
  }
  if (project.policy.max_active_dispatches !== 1) {
    throw new RegistryError(
      REGISTRY_ERROR_CODES.REGISTRY_SCHEMA_INVALID,
      `policy.max_active_dispatches must be exactly 1, got ${project.policy.max_active_dispatches}`
    );
  }
  if (project.policy.require_workspace_state !== true) {
    throw new RegistryError(
      REGISTRY_ERROR_CODES.REGISTRY_SCHEMA_INVALID,
      `policy.require_workspace_state must be exactly true, got ${project.policy.require_workspace_state}`
    );
  }

  return structuredClone(project);
}

/**
 * Validate full registry document structure (A-02: Structural validity check).
 * Validates JSON structure, keys, schema version, root shape (REG-01),
 * and checks that no duplicate root identity keys exist among persisted records.
 */
function validateRegistryDocument(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new RegistryError(
      REGISTRY_ERROR_CODES.REGISTRY_SCHEMA_INVALID,
      'Registry root must be a non-null object'
    );
  }

  if (!hasOnlyAllowedKeys(doc, ALLOWED_TOP_LEVEL_KEYS)) {
    const unknownKeys = Object.keys(doc).filter((k) => !ALLOWED_TOP_LEVEL_KEYS.has(k));
    throw new RegistryError(
      REGISTRY_ERROR_CODES.REGISTRY_SCHEMA_INVALID,
      `Registry contains unknown top-level fields: ${unknownKeys.join(', ')}`
    );
  }

  if (doc.schema_version !== 2) {
    throw new RegistryError(
      REGISTRY_ERROR_CODES.REGISTRY_SCHEMA_INVALID,
      `Unsupported schema_version: ${doc.schema_version}. Expected 2`
    );
  }

  if (!doc.projects || typeof doc.projects !== 'object' || Array.isArray(doc.projects)) {
    throw new RegistryError(
      REGISTRY_ERROR_CODES.REGISTRY_SCHEMA_INVALID,
      "Registry 'projects' field must be a plain object"
    );
  }

  const seenRootIdentities = new Map();

  for (const [mapKey, project] of Object.entries(doc.projects)) {
    validateProjectRecord(project);

    if (project.project_id !== mapKey) {
      throw new RegistryError(
        REGISTRY_ERROR_CODES.REGISTRY_SCHEMA_INVALID,
        `Map key '${mapKey}' does not match project_id '${project.project_id}'`
      );
    }

    // REG-01 / Section 8: Structural root shape enforcement on persisted projects
    validateProjectRootShape(project.project_root);
    validateProjectRootShape(project.auditor.cwd);
    if (project.auditor.cwd !== project.project_root) {
      throw new RegistryError(REGISTRY_ERROR_CODES.AUDITOR_CWD_MISMATCH, 'Persisted auditor.cwd must equal project_root');
    }

    const identityKey = computeRootIdentityKey(project.project_root);
    if (seenRootIdentities.has(identityKey)) {
      const priorId = seenRootIdentities.get(identityKey);
      throw new RegistryError(
        REGISTRY_ERROR_CODES.DUPLICATE_PROJECT_ROOT,
        `Duplicate canonical project root identity for projects '${priorId}' and '${project.project_id}'`
      );
    }
    seenRootIdentities.set(identityKey, project.project_id);
  }

  return doc;
}

function sameMigrationFileIdentity(a, b) {
  return !!(
    a && b &&
    typeof a.isFile === 'function' && a.isFile() &&
    typeof b.isFile === 'function' && b.isFile() &&
    a.dev != null && a.ino != null &&
    b.dev != null && b.ino != null &&
    a.dev === b.dev && a.ino === b.ino
  );
}

function readMigrationSource(registryFilePath, customFs) {
  if (!path.isAbsolute(registryFilePath)) {
    throw new RegistryError(REGISTRY_ERROR_CODES.INVALID_REQUEST, 'registryFilePath must be absolute');
  }
  let descriptor;
  try {
    const before = customFs.lstatSync(registryFilePath);
    if (!before.isFile() || before.isSymbolicLink()) throw new Error('Source must be a regular non-symlink file');
    descriptor = customFs.openSync(registryFilePath, 'r');
    const opened = customFs.fstatSync(descriptor);
    if (!sameMigrationFileIdentity(before, opened)) throw new Error('Source identity unavailable or changed before read');
    const raw = customFs.readFileSync(descriptor);
    const after = customFs.lstatSync(registryFilePath);
    if (after.isSymbolicLink() || !sameMigrationFileIdentity(opened, after)) throw new Error('Source identity unavailable or changed after read');
    return { raw, sha256: crypto.createHash('sha256').update(raw).digest('hex') };
  } catch (error) {
    throw new RegistryError(REGISTRY_ERROR_CODES.REGISTRY_CORRUPT, `Cannot safely read registry migration source: ${error.message}`);
  } finally {
    if (descriptor !== undefined) customFs.closeSync(descriptor);
  }
}

function parseMigrationSource(raw) {
  try { return JSON.parse(raw.toString('utf8')); }
  catch { throw new RegistryError(REGISTRY_ERROR_CODES.REGISTRY_CORRUPT, 'Malformed Registry JSON'); }
}

function buildV2Candidate(source, customFs) {
  validateV1Document(source);
  const projects = {};
  const roots = new Set();
  for (const [id, p] of Object.entries(source.projects)) {
    const { canonicalRoot, identityKey } = canonicalizeProjectRoot(p.project_root, customFs);
    if (roots.has(identityKey)) throw new RegistryError(REGISTRY_ERROR_CODES.DUPLICATE_PROJECT_ROOT, 'Duplicate canonical project root');
    roots.add(identityKey);
    projects[id] = {
      project_id: p.project_id,
      project_name: p.project_name,
      project_root: canonicalRoot,
      worker: { engine: p.worker.engine, session_id: p.worker.session_id, enabled: p.worker.enabled, model_policy: 'worker_standard' },
      auditor: { engine: 'codex_app_server', thread_id: null, cwd: canonicalRoot, enabled: false, model_policy: 'auditor_standard' },
      policy: { ...p.policy }
    };
  }
  const candidate = { schema_version: 2, projects };
  validateRegistryDocument(candidate);
  return candidate;
}

function previewV1ToV2Migration(options = {}) {
  const customFs = options.fs || fs;
  if (!options.registryFilePath) throw new RegistryError(REGISTRY_ERROR_CODES.INVALID_REQUEST, 'Explicit registryFilePath required');
  const source = readMigrationSource(options.registryFilePath, customFs);
  const parsed = parseMigrationSource(source.raw);
  if (parsed.schema_version === 2) {
    validateRegistryDocument(parsed);
    return { ok: true, migration_required: false, state: 'ALREADY_V2', source_schema_version: 2, target_schema_version: 2, source_sha256: source.sha256, project_count: Object.keys(parsed.projects).length, requires_auditor_registration: [], would_write: false };
  }
  const candidate = buildV2Candidate(parsed, customFs);
  return {
    ok: true,
    migration_required: true,
    source_schema_version: 1,
    target_schema_version: 2,
    source_sha256: source.sha256,
    project_count: Object.keys(candidate.projects).length,
    requires_auditor_registration: Object.keys(candidate.projects),
    legacy_auditor_metadata_discarded: true,
    would_write: false,
    candidate: structuredClone(candidate)
  };
}

function applyV1ToV2Migration(options = {}) {
  const customFs = options.fs || fs;
  const registryFilePath = options.registryFilePath;
  if (!registryFilePath || !path.isAbsolute(registryFilePath) || !/^[a-fA-F0-9]{64}$/.test(options.expected_source_sha256 || '')) {
    throw new RegistryError(REGISTRY_ERROR_CODES.INVALID_REQUEST, 'Explicit absolute registryFilePath and expected_source_sha256 required');
  }
  const source = readMigrationSource(registryFilePath, customFs);
  if (source.sha256.toLowerCase() !== options.expected_source_sha256.toLowerCase()) {
    throw new RegistryError(REGISTRY_ERROR_CODES.REGISTRY_MIGRATION_SOURCE_CHANGED, 'Registry changed after preview');
  }
  const parsed = parseMigrationSource(source.raw);
  if (parsed.schema_version === 2) {
    validateRegistryDocument(parsed);
    return { ok: true, changed: false, state: 'ALREADY_V2', source_schema_version: 2, target_schema_version: 2, source_sha256: source.sha256, project_count: Object.keys(parsed.projects).length, requires_auditor_registration: [] };
  }
  const candidate = buildV2Candidate(parsed, customFs);
  const dir = path.dirname(registryFilePath);
  const backupPath = `${registryFilePath}.v1.${Date.now()}.${source.sha256.slice(0, 12)}.${crypto.randomBytes(4).toString('hex')}.bak`;
  const mode = process.platform === 'win32' ? 0o666 : 0o600;
  let backupFd;
  let backupCreated = false;
  try {
    backupFd = customFs.openSync(backupPath, 'wx', mode);
    backupCreated = true;
    customFs.writeFileSync(backupFd, source.raw);
    customFs.fsyncSync(backupFd);
    customFs.closeSync(backupFd); backupFd = undefined;
  } catch (error) {
    if (backupFd !== undefined) try { customFs.closeSync(backupFd); } catch {}
    if (backupCreated) try { customFs.unlinkSync(backupPath); } catch {}
    throw new RegistryError(REGISTRY_ERROR_CODES.REGISTRY_BACKUP_FAILED, `Cannot create migration backup: ${error.message}`);
  }
  const tempPath = path.join(dir, `.registry-v2.${crypto.randomBytes(12).toString('hex')}.tmp`);
  const expectedV2 = Buffer.from(JSON.stringify(candidate, null, 2) + '\n', 'utf8');
  let tempFd;
  try {
    tempFd = customFs.openSync(tempPath, 'wx', mode);
    customFs.writeFileSync(tempFd, expectedV2);
    customFs.fsyncSync(tempFd);
    customFs.closeSync(tempFd); tempFd = undefined;
    const current = readMigrationSource(registryFilePath, customFs);
    if (current.sha256 !== source.sha256) throw new RegistryError(REGISTRY_ERROR_CODES.REGISTRY_MIGRATION_SOURCE_CHANGED, 'Registry changed during migration');
    customFs.renameSync(tempPath, registryFilePath);
  } catch (error) {
    if (tempFd !== undefined) try { customFs.closeSync(tempFd); } catch {}
    try { customFs.unlinkSync(tempPath); } catch {}
    if (error instanceof RegistryError && [REGISTRY_ERROR_CODES.REGISTRY_MIGRATION_SOURCE_CHANGED, REGISTRY_ERROR_CODES.REGISTRY_CORRUPT].includes(error.code)) throw error;
    throw new RegistryError(REGISTRY_ERROR_CODES.REGISTRY_MIGRATION_PERSIST_FAILED, `Cannot atomically persist v2 Registry: ${error.message}`);
  }
  try {
    const writtenRaw = readMigrationSource(registryFilePath, customFs).raw;
    if (!writtenRaw.equals(expectedV2)) throw new Error('Written Registry bytes differ from validated candidate');
    const written = parseMigrationSource(writtenRaw);
    validateRegistryDocument(written);
  } catch (error) {
    try {
      const restoreTemp = path.join(dir, `.registry-restore.${crypto.randomBytes(12).toString('hex')}.tmp`);
      customFs.copyFileSync(backupPath, restoreTemp);
      customFs.renameSync(restoreTemp, registryFilePath);
    } catch (rollbackError) {
      throw new RegistryError(REGISTRY_ERROR_CODES.REGISTRY_MIGRATION_ROLLBACK_FAILED, `Verification and rollback failed; target=${registryFilePath}; backup=${backupPath}`);
    }
    throw new RegistryError(REGISTRY_ERROR_CODES.REGISTRY_MIGRATION_VERIFY_FAILED, `Verification failed; source restored from ${backupPath}`);
  }
  return { ok: true, changed: true, source_schema_version: 1, target_schema_version: 2, source_sha256: source.sha256, backup_path: backupPath, project_count: Object.keys(candidate.projects).length, requires_auditor_registration: Object.keys(candidate.projects) };
}

/**
 * Create Project Registry
 *
 * Provides persistent project/session/auditor mapping authority outside target repositories.
 */
function createProjectRegistry(options = {}) {
  const customFs = options.fs || fs;
  const defaultPath = path.join(os.homedir(), '.orchestrator', 'projects.json');
  const registryFilePath = options.registryFilePath || defaultPath;

  // In-memory authoritative state
  let inMemoryData = {
    schema_version: 2,
    projects: {}
  };

  /**
   * Same-Process Mutation Queue with Error Recovery (A-05)
   * Ensures concurrent mutations execute sequentially without lost updates.
   * If a mutation fails or rejects, subsequent queued mutations continue executing normally.
   */
  let mutationQueue = Promise.resolve();

  function serializeMutation(operation) {
    const resultPromise = mutationQueue.then(() => operation());
    mutationQueue = resultPromise.catch(() => {});
    return resultPromise;
  }

  /**
   * Atomic file persistence helper (A-09)
   * Writes unique temporary file in the same directory, flushes via fsync, and renames.
   */
  function persistToDisk(dataToPersist) {
    const dir = path.dirname(registryFilePath);
    try {
      customFs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      throw new RegistryError(
        REGISTRY_ERROR_CODES.REGISTRY_PERSIST_FAILED,
        `Failed to create registry directory '${dir}': ${err.message}`
      );
    }

    const uniqueSuffix = `${Date.now()}.${crypto.randomBytes(6).toString('hex')}`;
    const tempFilePath = path.join(dir, `.projects.${uniqueSuffix}.tmp`);
    const serialized = JSON.stringify(dataToPersist, null, 2) + '\n';

    // File mode: restrictive on POSIX (0o600), standard on Windows (0o666) (A-07)
    const fileMode = process.platform === 'win32' ? 0o666 : 0o600;

    let fd;
    try {
      fd = customFs.openSync(tempFilePath, 'w', fileMode);
      customFs.writeSync(fd, serialized, 0, 'utf8');
      if (typeof customFs.fsyncSync === 'function') {
        customFs.fsyncSync(fd);
      }
      customFs.closeSync(fd);
      fd = null;
    } catch (err) {
      if (fd !== null && fd !== undefined) {
        try {
          customFs.closeSync(fd);
        } catch {}
      }
      try {
        customFs.unlinkSync(tempFilePath);
      } catch {}
      throw new RegistryError(
        REGISTRY_ERROR_CODES.REGISTRY_PERSIST_FAILED,
        `Failed to write temporary registry file '${tempFilePath}': ${err.message}`
      );
    }

    try {
      customFs.renameSync(tempFilePath, registryFilePath);
    } catch (err) {
      try {
        customFs.unlinkSync(tempFilePath);
      } catch {}
      throw new RegistryError(
        REGISTRY_ERROR_CODES.REGISTRY_PERSIST_FAILED,
        `Failed to atomically replace registry file '${registryFilePath}': ${err.message}`
      );
    }
  }

  /**
   * Load registry from disk
   */
  function loadFromDisk() {
    let exists = false;
    try {
      exists = customFs.existsSync(registryFilePath);
    } catch (err) {
      throw new RegistryError(
        REGISTRY_ERROR_CODES.REGISTRY_CORRUPT,
        `Unable to access registry file at '${registryFilePath}': ${err.message}`
      );
    }

    if (!exists) {
      inMemoryData = {
        schema_version: 2,
        projects: {}
      };
      return inMemoryData;
    }

    let rawContent;
    try {
      rawContent = customFs.readFileSync(registryFilePath, 'utf8');
    } catch (err) {
      throw new RegistryError(
        REGISTRY_ERROR_CODES.REGISTRY_CORRUPT,
        `Failed to read registry file '${registryFilePath}': ${err.message}`
      );
    }

    let parsed;
    try {
      parsed = JSON.parse(rawContent);
    } catch (err) {
      throw new RegistryError(
        REGISTRY_ERROR_CODES.REGISTRY_CORRUPT,
        `Registry file contains malformed JSON at '${registryFilePath}': ${err.message}`
      );
    }

    if (parsed && parsed.schema_version === 1) {
      throw new RegistryError(REGISTRY_ERROR_CODES.REGISTRY_MIGRATION_REQUIRED, 'Explicit Registry v1 to v2 migration required');
    }
    // Structural validation (A-02: structural validation != runtime availability)
    validateRegistryDocument(parsed);

    // Hardened load ownership (Section 20): retain detached in-memory authority
    inMemoryData = structuredClone(parsed);
    return structuredClone(inMemoryData);
  }

  // Perform initial load
  loadFromDisk();

  /**
   * getProject(projectId)
   * Resolves project mapping by explicit project ID.
   * Performs runtime availability check (A-02): checks that the registered project root
   * currently exists on disk and is a directory.
   * Revalidates runtime canonical realpath identity (REG-04): fails closed with
   * PROJECT_ROOT_UNAVAILABLE if realpath fails or resolved identity drifts from stored mapping.
   * Returns detached object.
   */
  async function getProject(projectId) {
    if (typeof projectId !== 'string' || !projectId.trim()) {
      return null;
    }

    const project = inMemoryData.projects[projectId.trim()];
    if (!project) {
      return null;
    }

    // 1. Runtime root existence and directory check (A-02)
    let stat;
    try {
      stat = customFs.statSync(project.project_root);
    } catch (err) {
      throw new RegistryError(
        REGISTRY_ERROR_CODES.PROJECT_ROOT_UNAVAILABLE,
        `Project root '${project.project_root}' for project '${projectId}' does not exist on disk: ${err.message}`
      );
    }

    if (!stat.isDirectory()) {
      throw new RegistryError(
        REGISTRY_ERROR_CODES.PROJECT_ROOT_UNAVAILABLE,
        `Project root '${project.project_root}' for project '${projectId}' is no longer a directory`
      );
    }

    // 2. Runtime realpath canonical identity revalidation (REG-04)
    let runtimeCanonical;
    try {
      const realpathFn = customFs.realpathSync && customFs.realpathSync.native
        ? customFs.realpathSync.native
        : (customFs.realpathSync || fs.realpathSync);
      runtimeCanonical = realpathFn(project.project_root);
    } catch (err) {
      throw new RegistryError(
        REGISTRY_ERROR_CODES.PROJECT_ROOT_UNAVAILABLE,
        `Failed to resolve runtime canonical path for project root '${project.project_root}': ${err.message}`
      );
    }

    const storedIdentity = computeRootIdentityKey(project.project_root);
    const runtimeIdentity = computeRootIdentityKey(runtimeCanonical);

    if (storedIdentity !== runtimeIdentity) {
      throw new RegistryError(
        REGISTRY_ERROR_CODES.PROJECT_ROOT_UNAVAILABLE,
        `Runtime canonical identity '${runtimeIdentity}' for project root does not match stored identity '${storedIdentity}'`
      );
    }

    return structuredClone(project);
  }

  /**
   * listProjects()
   * Returns list of all registered projects as detached objects.
   */
  async function listProjects() {
    return Object.values(inMemoryData.projects).map((p) => structuredClone(p));
  }

  /**
   * putProject(projectInput)
   * Adds or replaces a project mapping after full structural and runtime validation.
   * Updates in-memory state only after successful persistence.
   */
  async function putProject(projectInput) {
    return serializeMutation(async () => {
      // 1. Validate complete record shape and exact fields
      const validated = validateProjectRecord(projectInput);

      // 2. Validate and canonicalize project root (runtime availability check, REG-01/REG-02)
      const { canonicalRoot, identityKey } = canonicalizeProjectRoot(validated.project_root, customFs);

      const candidate = {
        ...validated,
        project_root: canonicalRoot,
        auditor: { ...validated.auditor, cwd: canonicalRoot }
      };
      const auditorRoot = canonicalizeProjectRoot(validated.auditor.cwd, customFs);
      if (auditorRoot.identityKey !== identityKey) {
        throw new RegistryError(REGISTRY_ERROR_CODES.AUDITOR_CWD_MISMATCH, 'auditor.cwd does not match canonical project_root');
      }

      // 3. Check for duplicate canonical root against all OTHER registered projects
      for (const [existingId, existingProject] of Object.entries(inMemoryData.projects)) {
        if (existingId !== candidate.project_id) {
          const existingIdentity = computeRootIdentityKey(existingProject.project_root);
          if (existingIdentity === identityKey) {
            throw new RegistryError(
              REGISTRY_ERROR_CODES.DUPLICATE_PROJECT_ROOT,
              `Project root '${canonicalRoot}' is already assigned to project '${existingId}'`
            );
          }
        }
      }

      // 4. Construct candidate registry document
      const nextProjects = {
        ...inMemoryData.projects,
        [candidate.project_id]: candidate
      };

      const nextRegistry = {
        schema_version: 2,
        projects: nextProjects
      };

      // 5. Persist atomically to disk
      persistToDisk(nextRegistry);

      // 6. Update in-memory state only after persistence succeeds
      inMemoryData = nextRegistry;

      return structuredClone(candidate);
    });
  }

  /**
   * removeProject(projectId)
   * Removes project mapping by explicit ID.
   * Throws PROJECT_NOT_FOUND if unknown.
   */
  async function removeProject(projectId) {
    return serializeMutation(async () => {
      if (typeof projectId !== 'string' || !projectId.trim()) {
        throw new RegistryError(
          REGISTRY_ERROR_CODES.PROJECT_NOT_FOUND,
          `Invalid or empty project_id: '${projectId}'`
        );
      }

      const id = projectId.trim();
      if (!inMemoryData.projects[id]) {
        throw new RegistryError(
          REGISTRY_ERROR_CODES.PROJECT_NOT_FOUND,
          `Project '${id}' not found in registry`
        );
      }

      const nextProjects = { ...inMemoryData.projects };
      delete nextProjects[id];

      const nextRegistry = {
        schema_version: 2,
        projects: nextProjects
      };

      persistToDisk(nextRegistry);
      inMemoryData = nextRegistry;

      return { ok: true, removed_project_id: id };
    });
  }

  /**
   * validate() (REG-03)
   * Runs structural and duplicate root validation on the loaded registry.
   * Returns a detached validated snapshot: structuredClone(inMemoryData).
   */
  function validate() {
    validateRegistryDocument(inMemoryData);
    return structuredClone(inMemoryData);
  }

  /**
   * previewLegacyImport(legacyEntries) (A-01)
   * Pure preview helper for legacy candidates.
   * Normalizes candidates, identifies invalid rows, duplicate roots, duplicate IDs,
   * and basename collisions.
   * MUST NOT write to registry or disk.
   */
  function previewLegacyImport(legacyEntries) {
    if (!Array.isArray(legacyEntries)) {
      return {
        candidates: [],
        invalid_entries: [],
        issues: ['Legacy entries must be provided as an array']
      };
    }

    const candidates = [];
    const invalidEntries = [];
    const issues = [];

    const seenIds = new Set();
    const seenRoots = new Map();
    const seenBasenames = new Map();

    for (let i = 0; i < legacyEntries.length; i++) {
      const entry = legacyEntries[i];
      const entryIndex = i;

      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        invalidEntries.push({ index: entryIndex, entry, issue: 'Entry is not an object' });
        issues.push(`Entry #${entryIndex} is not an object`);
        continue;
      }

      const id = typeof entry.id === 'string' ? entry.id.trim() : '';
      const rawPath = typeof entry.path === 'string' ? entry.path.trim() : '';
      const name = typeof entry.name === 'string' ? entry.name.trim() : '';

      if (!id) {
        invalidEntries.push({ index: entryIndex, entry, issue: 'Missing or empty project ID' });
        issues.push(`Entry #${entryIndex} has missing or empty project ID`);
        continue;
      }

      if (!PROJECT_ID_REGEX.test(id)) {
        invalidEntries.push({ index: entryIndex, entry, issue: `Project ID '${id}' does not match pattern ${PROJECT_ID_REGEX}` });
        issues.push(`Entry #${entryIndex} has invalid project ID '${id}'`);
        continue;
      }

      if (seenIds.has(id)) {
        invalidEntries.push({ index: entryIndex, entry, issue: `Duplicate project ID '${id}' in legacy dataset` });
        issues.push(`Duplicate project ID '${id}' found in legacy dataset`);
        continue;
      }

      if (!rawPath || rawPath === '\\' || rawPath === '/') {
        invalidEntries.push({ index: entryIndex, entry, issue: `Invalid project path '${rawPath}'` });
        issues.push(`Entry #${entryIndex} ('${id}') has invalid root path '${rawPath}'`);
        continue;
      }

      const identityKey = computeRootIdentityKey(rawPath);
      if (!identityKey) {
        invalidEntries.push({ index: entryIndex, entry, issue: `Cannot compute root identity for path '${rawPath}'` });
        issues.push(`Entry #${entryIndex} ('${id}') has unparseable path '${rawPath}'`);
        continue;
      }

      if (seenRoots.has(identityKey)) {
        const priorId = seenRoots.get(identityKey);
        invalidEntries.push({ index: entryIndex, entry, issue: `Path '${rawPath}' collides with prior entry '${priorId}'` });
        issues.push(`Root identity collision: '${rawPath}' matches prior project '${priorId}'`);
        continue;
      }

      // Check basename collision
      const basename = path.basename(path.normalize(rawPath)).toLowerCase();
      if (seenBasenames.has(basename)) {
        const priorId = seenBasenames.get(basename);
        issues.push(`Basename collision: project '${id}' shares basename '${basename}' with project '${priorId}' (roots differ)`);
      } else {
        seenBasenames.set(basename, id);
      }

      seenIds.add(id);
      seenRoots.set(identityKey, id);

      // Candidate proposal (incomplete - requires worker/auditor setup)
      candidates.push({
        project_id: id,
        project_name: name || id,
        project_root: rawPath,
        authoritative: false,
        worker: null,
        auditor: null,
        policy: null,
        status: 'CANDIDATE_REQUIRES_COMPLETION'
      });
    }

    return {
      candidates,
      invalid_entries: invalidEntries,
      issues
    };
  }

  return {
    getProject,
    listProjects,
    putProject,
    removeProject,
    validate,
    previewLegacyImport
  };
}

module.exports = {
  REGISTRY_ERROR_CODES,
  RegistryError,
  PROJECT_ID_REGEX,
  computeRootIdentityKey,
  validateProjectRootShape,
  canonicalizeProjectRoot,
  validateProjectRecord,
  validateRegistryDocument,
  createProjectRegistry,
  getAuditorBindingState,
  validateV1Document,
  previewV1ToV2Migration,
  applyV1ToV2Migration
};
