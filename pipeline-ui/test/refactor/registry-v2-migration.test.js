'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { createProjectRegistry, previewV1ToV2Migration, applyV1ToV2Migration, getAuditorBindingState, validateProjectRecord } = require('../../lib/broker/registry');
const { createBroker } = require('../../lib/broker/broker');

const CLI = path.resolve(__dirname, '../../registry-v2-migrate.js');
let count = 0;
function check(id, description, fn) {
  fn();
  count++;
  console.log(`✓ ${id} PASSED: ${description}`);
}
function expectCode(fn, code) { assert.throws(fn, (error) => error.code === code); }
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-v2-'));
  const root = path.join(dir, 'project'); fs.mkdirSync(root);
  const file = path.join(dir, 'projects.json');
  const doc = { schema_version: 1, projects: { proj: {
    project_id: 'proj', project_name: 'Project', project_root: root,
    worker: { engine: 'antigravity', session_id: 'exact-session', enabled: true },
    auditor: { engine: 'codex', task_id: 'retired-task-id', task_id_verified: false, expected_model_label: 'retired-model', mode: 'full-harness', managed_by_orchestrator: false },
    policy: { max_active_dispatches: 1, require_workspace_state: true }
  } } };
  const raw = Buffer.from(JSON.stringify(doc, null, 2) + '\n', 'utf8');
  fs.writeFileSync(file, raw);
  return { dir, root, file, doc, raw, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
function preview(f) { return previewV1ToV2Migration({ registryFilePath: f.file }); }
function apply(f, hash = preview(f).source_sha256, extra = {}) { return applyV1ToV2Migration({ registryFilePath: f.file, expected_source_sha256: hash, ...extra }); }
function cli(...args) {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  const lines = result.stdout.trim().split(/\r?\n/);
  assert.strictEqual(lines.length, 1, 'CLI must emit exactly one JSON object');
  return { status: result.status, json: JSON.parse(lines[0]) };
}

async function run() {
  const f = fixture();
  try {
    const p = preview(f); const migrated = p.candidate.projects.proj;
    check('RV2-001', 'preview constructs strict v2 candidate', () => assert.strictEqual(p.candidate.schema_version, 2));
    check('RV2-002', 'preview creates no file', () => assert.deepStrictEqual(fs.readdirSync(f.dir).sort(), ['project', 'projects.json']));
    check('RV2-003', 'source hash covers exact bytes', () => assert.strictEqual(p.source_sha256, crypto.createHash('sha256').update(f.raw).digest('hex')));
    check('RV2-004', 'legacy task ID is discarded', () => { assert.strictEqual(migrated.auditor.thread_id, null); assert.ok(!JSON.stringify(p.candidate).includes('retired-task-id')); });
    check('RV2-005', 'legacy model label is discarded', () => assert.ok(!JSON.stringify(p.candidate).includes('retired-model')));
    check('RV2-006', 'migrated auditor is unbound and disabled', () => { assert.strictEqual(migrated.auditor.enabled, false); assert.strictEqual(migrated.auditor.engine, 'codex_app_server'); });
    check('RV2-007', 'auditor cwd equals canonical root', () => assert.strictEqual(migrated.auditor.cwd, fs.realpathSync.native(f.root)));
    check('RV2-008', 'worker session is exact', () => assert.strictEqual(migrated.worker.session_id, 'exact-session'));
    check('RV2-009', 'worker policy default', () => assert.strictEqual(migrated.worker.model_policy, 'worker_standard'));
    check('RV2-010', 'auditor policy default', () => assert.strictEqual(migrated.auditor.model_policy, 'auditor_standard'));
    check('RV2-011', 'normal v1 load requires migration', () => expectCode(() => createProjectRegistry({ registryFilePath: f.file }), 'REGISTRY_MIGRATION_REQUIRED'));
    check('RV2-012', 'normal load preserves bytes', () => assert.deepStrictEqual(fs.readFileSync(f.file), f.raw));
    check('RV2-013', 'apply requires expected hash', () => expectCode(() => applyV1ToV2Migration({ registryFilePath: f.file }), 'INVALID_REQUEST'));
    check('RV2-014', 'hash mismatch writes nothing', () => { expectCode(() => apply(f, '0'.repeat(64)), 'REGISTRY_MIGRATION_SOURCE_CHANGED'); assert.deepStrictEqual(fs.readFileSync(f.file), f.raw); assert.strictEqual(fs.readdirSync(f.dir).length, 2); });
    const result = apply(f);
    check('RV2-015', 'backup is byte-exact', () => assert.deepStrictEqual(fs.readFileSync(result.backup_path), f.raw));
    check('RV2-016', 'apply writes strict schema v2', () => assert.strictEqual(JSON.parse(fs.readFileSync(f.file, 'utf8')).schema_version, 2));
    check('RV2-017', 'applied v2 reloads', () => assert.strictEqual(createProjectRegistry({ registryFilePath: f.file }).validate().projects.proj.auditor.thread_id, null));
    const already = apply(f, crypto.createHash('sha256').update(fs.readFileSync(f.file)).digest('hex'));
    check('RV2-020', 'already-v2 apply is no-op', () => { assert.strictEqual(already.changed, false); assert.strictEqual(fs.readdirSync(f.dir).length, 3); });
    check('RV2-024', 'binding state derives from thread ID and enabled', () => {
      assert.strictEqual(getAuditorBindingState(migrated.auditor), 'AUDITOR_REGISTRATION_REQUIRED');
      assert.strictEqual(getAuditorBindingState({ thread_id: 'opaque', enabled: false }), 'AUDITOR_BOUND_DISABLED');
      assert.strictEqual(getAuditorBindingState({ thread_id: 'opaque', enabled: true }), 'AUDITOR_BOUND_READY');
    });
    {
      const registry = createProjectRegistry({ registryFilePath: f.file });
      let dispatched = null;
      const broker = createBroker({ registryPort: registry, workspacePort: { getWorkspaceState: async () => ({ workspace_state_id: 'state' }) }, workerPort: { dispatch: async (args) => { dispatched = args; return { ok: true, state: 'DISPATCH_ACCEPTED' }; } } });
      const response = await broker.dispatchWorker({ schema_version: 1, project_id: 'proj', work_order_id: 'WO-RV2-025', expected_workspace_state_id: 'state', directive: 'fixture-only dispatch' });
      assert.strictEqual(response.ok, true);
      assert.strictEqual(dispatched.project.worker.session_id, 'exact-session');
      assert.strictEqual(dispatched.project.worker.model_policy, 'worker_standard');
      assert.strictEqual(dispatched.project.auditor.thread_id, null);
      count++;
      console.log('✓ RV2-025 PASSED: worker dispatch receives exact migrated worker with unbound auditor');
    }
  } finally { f.cleanup(); }

  const fault = fixture();
  try {
    const fakeBackupFs = { ...fs, openSync: (file, flags, mode) => { if (flags === 'wx' && file.endsWith('.bak')) throw new Error('denied'); return fs.openSync(file, flags, mode); } };
    check('RV2-018', 'backup failure preserves v1 bytes', () => { expectCode(() => apply(fault, preview(fault).source_sha256, { fs: fakeBackupFs }), 'REGISTRY_BACKUP_FAILED'); assert.deepStrictEqual(fs.readFileSync(fault.file), fault.raw); });
    const fakePersistFs = { ...fs, renameSync: () => { throw new Error('denied'); } };
    check('RV2-019', 'atomic persist failure preserves v1 bytes', () => { expectCode(() => apply(fault, preview(fault).source_sha256, { fs: fakePersistFs }), 'REGISTRY_MIGRATION_PERSIST_FAILED'); assert.deepStrictEqual(fs.readFileSync(fault.file), fault.raw); });
    check('RV2-021', 'malformed v1 fails without mutation', () => { fs.writeFileSync(fault.file, '{bad'); expectCode(() => preview(fault), 'REGISTRY_CORRUPT'); assert.strictEqual(fs.readFileSync(fault.file, 'utf8'), '{bad'); });
  } finally { fault.cleanup(); }
  const invalid = fixture();
  try {
    check('RV2-022', 'duplicate canonical root rejects whole migration', () => { invalid.doc.projects.other = { ...invalid.doc.projects.proj, project_id: 'other' }; fs.writeFileSync(invalid.file, JSON.stringify(invalid.doc)); expectCode(() => preview(invalid), 'DUPLICATE_PROJECT_ROOT'); assert.strictEqual(JSON.parse(fs.readFileSync(invalid.file)).schema_version, 1); });
    check('RV2-023', 'unavailable root rejects whole migration', () => { delete invalid.doc.projects.other; invalid.doc.projects.proj.project_root = path.join(invalid.dir, 'missing'); fs.writeFileSync(invalid.file, JSON.stringify(invalid.doc)); expectCode(() => preview(invalid), 'INVALID_PROJECT_ROOT'); assert.strictEqual(JSON.parse(fs.readFileSync(invalid.file)).schema_version, 1); });
  } finally { invalid.cleanup(); }
  const cliFixture = fixture();
  try {
    check('RV2-026', 'CLI preview requires explicit file', () => assert.strictEqual(cli('preview').json.code, 'INVALID_REQUEST'));
    check('RV2-027', 'CLI apply requires explicit file', () => assert.strictEqual(cli('apply', '--expected-source-sha256', '0'.repeat(64)).json.code, 'INVALID_REQUEST'));
    check('RV2-028', 'CLI apply requires hash', () => assert.strictEqual(cli('apply', '--registry-file', cliFixture.file).json.code, 'INVALID_REQUEST'));
    check('RV2-029', 'CLI rejects relative file', () => assert.strictEqual(cli('preview', '--registry-file', 'projects.json').json.code, 'INVALID_REQUEST'));
    check('RV2-030', 'CLI rejects unknown flag and command', () => { assert.strictEqual(cli('preview', '--bad', 'x').status, 1); assert.strictEqual(cli('unknown').status, 1); });
    check('RV2-031', 'CLI preview is read-only', () => { const out = cli('preview', '--registry-file', cliFixture.file); assert.strictEqual(out.json.ok, true); assert.deepStrictEqual(fs.readFileSync(cliFixture.file), cliFixture.raw); });
    check('RV2-032', 'CLI applies only explicit fixture', () => { const out = cli('apply', '--registry-file', cliFixture.file, '--expected-source-sha256', preview(cliFixture).source_sha256); assert.strictEqual(out.json.changed, true); assert.strictEqual(JSON.parse(fs.readFileSync(cliFixture.file)).schema_version, 2); });
  } finally { cliFixture.cleanup(); }
  const shape = fixture();
  try {
    const candidate = preview(shape).candidate.projects.proj;
    check('RV2-033', 'enabled auditor requires thread', () => expectCode(() => validateProjectRecord({ ...candidate, auditor: { ...candidate.auditor, enabled: true } }), 'REGISTRY_SCHEMA_INVALID'));
    check('RV2-034', 'thread ID rejects control bytes', () => expectCode(() => validateProjectRecord({ ...candidate, auditor: { ...candidate.auditor, thread_id: 'a\n' } }), 'REGISTRY_SCHEMA_INVALID'));
    check('RV2-035', 'retired v1 auditor fields rejected', () => expectCode(() => validateProjectRecord({ ...candidate, auditor: { ...candidate.auditor, task_id: 'old' } }), 'REGISTRY_SCHEMA_INVALID'));
    {
      const registry = createProjectRegistry({ registryFilePath: path.join(shape.dir, 'new-v2.json') });
      await assert.rejects(registry.putProject({ ...candidate, auditor: { ...candidate.auditor, cwd: shape.dir } }), (error) => error.code === 'AUDITOR_CWD_MISMATCH');
      count++;
      console.log('✓ RV2-036 PASSED: canonical cwd mismatch rejected');
    }
    check('RV2-037', 'unknown policy rejected', () => expectCode(() => validateProjectRecord({ ...candidate, worker: { ...candidate.worker, model_policy: 'unknown' } }), 'REGISTRY_SCHEMA_INVALID'));
  } finally { shape.cleanup(); }
  const verifyFault = fixture();
  try {
    let reads = 0;
    const injected = { ...fs, readFileSync: (descriptor, ...args) => {
      reads++;
      if (reads === 3) return Buffer.from('{broken');
      return fs.readFileSync(descriptor, ...args);
    } };
    check('RV2-038', 'post-write verification failure restores exact v1 bytes', () => {
      expectCode(() => apply(verifyFault, preview(verifyFault).source_sha256, { fs: injected }), 'REGISTRY_MIGRATION_VERIFY_FAILED');
      assert.deepStrictEqual(fs.readFileSync(verifyFault.file), verifyFault.raw);
    });
  } finally { verifyFault.cleanup(); }
  const rollbackFault = fixture();
  try {
    let reads = 0; let renames = 0;
    const injected = { ...fs,
      readFileSync: (descriptor, ...args) => ++reads === 3 ? Buffer.from('{broken') : fs.readFileSync(descriptor, ...args),
      renameSync: (...args) => { if (++renames === 2) throw new Error('rollback denied'); return fs.renameSync(...args); }
    };
    check('RV2-039', 'rollback failure returns dedicated code', () => expectCode(() => apply(rollbackFault, preview(rollbackFault).source_sha256, { fs: injected }), 'REGISTRY_MIGRATION_ROLLBACK_FAILED'));
  } finally { rollbackFault.cleanup(); }
  const sourceFault = fixture();
  try {
    const linkedFs = { ...fs, lstatSync: () => ({ isFile: () => false, isSymbolicLink: () => true }) };
    check('RV2-040', 'symlink migration source rejected', () => expectCode(() => previewV1ToV2Migration({ registryFilePath: sourceFault.file, fs: linkedFs }), 'REGISTRY_CORRUPT'));
    check('RV2-041', 'directory migration source rejected', () => expectCode(() => previewV1ToV2Migration({ registryFilePath: sourceFault.dir }), 'REGISTRY_CORRUPT'));
    check('RV2-042', 'one invalid project blocks entire preview', () => {
      sourceFault.doc.projects.other = { ...sourceFault.doc.projects.proj, project_id: 'other', project_root: sourceFault.dir, worker: { ...sourceFault.doc.projects.proj.worker, enabled: false } };
      fs.writeFileSync(sourceFault.file, JSON.stringify(sourceFault.doc));
      expectCode(() => preview(sourceFault), 'REGISTRY_SCHEMA_INVALID');
      assert.strictEqual(JSON.parse(fs.readFileSync(sourceFault.file)).schema_version, 1);
    });
  } finally { sourceFault.cleanup(); }
  const bound = fixture();
  try {
    const candidate = preview(bound).candidate.projects.proj;
    const target = path.join(bound.dir, 'bound-v2.json');
    const registry = createProjectRegistry({ registryFilePath: target });
    await registry.putProject({ ...candidate, auditor: { ...candidate.auditor, thread_id: ' opaque-id ', enabled: true, cwd: path.join(bound.root, '.') } });
    check('RV2-043', 'bound auditor persists opaque ID without rewriting it', () => assert.strictEqual(registry.validate().projects.proj.auditor.thread_id, ' opaque-id '));
    check('RV2-044', 'successful persistence normalizes cwd to canonical root', () => assert.strictEqual(registry.validate().projects.proj.auditor.cwd, registry.validate().projects.proj.project_root));
    check('RV2-045', 'normal registry rejects v2 persisted cwd mismatch', () => {
      const doc = JSON.parse(fs.readFileSync(target, 'utf8'));
      doc.projects.proj.auditor.cwd = bound.dir;
      fs.writeFileSync(target, JSON.stringify(doc));
      expectCode(() => createProjectRegistry({ registryFilePath: target }), 'AUDITOR_CWD_MISMATCH');
    });
  } finally { bound.cleanup(); }
  console.log(`ALL REGISTRY V2 MIGRATION TESTS PASSED (RV2-001 .. RV2-045: ${count}/45 PASS)`);
}

if (require.main === module) run().catch((error) => { console.error(error); process.exitCode = 1; });
module.exports = { run };
