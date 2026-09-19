'use strict';

const path = require('node:path');
const { previewV1ToV2Migration, applyV1ToV2Migration } = require('./lib/broker/registry');

function parseArgs(argv) {
  const [operation, ...rest] = argv;
  if (!['preview', 'apply'].includes(operation)) throw Object.assign(new Error('Unknown command'), { code: 'INVALID_REQUEST' });
  const allowed = operation === 'preview' ? new Set(['--registry-file']) : new Set(['--registry-file', '--expected-source-sha256']);
  const flags = {};
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i];
    if (!allowed.has(flag) || flags[flag] || i + 1 >= rest.length || rest[i + 1].startsWith('--')) {
      throw Object.assign(new Error('Invalid or duplicate flag'), { code: 'INVALID_REQUEST' });
    }
    flags[flag] = rest[i + 1];
  }
  if (!flags['--registry-file'] || !path.isAbsolute(flags['--registry-file']) || (operation === 'apply' && !flags['--expected-source-sha256'])) {
    throw Object.assign(new Error('Explicit absolute --registry-file and apply hash required'), { code: 'INVALID_REQUEST' });
  }
  return { operation, registryFilePath: flags['--registry-file'], expected_source_sha256: flags['--expected-source-sha256'] };
}

function main(argv = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv);
    const result = args.operation === 'preview' ? previewV1ToV2Migration(args) : applyV1ToV2Migration(args);
    const { candidate, ...publicResult } = result;
    process.stdout.write(JSON.stringify({ ...publicResult, operation: args.operation }) + '\n');
    return 0;
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, code: error.code || 'REGISTRY_MIGRATION_PERSIST_FAILED', error: error.message }) + '\n');
    return 1;
  }
}

if (require.main === module) process.exitCode = main();
module.exports = { main, parseArgs };
