'use strict';

const { createProjectRegistry } = require('./registry');
const { createWorkspaceStatePort } = require('./workspace-state');
const { createSqliteLifecycleStore } = require('./sqlite-lifecycle-store');
const { createAntigravityWorkerPort } = require('./worker-adapter');
const { createBroker } = require('./broker');

/**
 * Broker Runtime Factory (WO-V3-006 / WP-V3-06)
 *
 * Composes the authoritative broker and port components:
 * - Project Registry
 * - Workspace State Port
 * - SQLite Lifecycle Store (MANDATORY for durable control commands)
 * - Antigravity Worker Port
 * - Deterministic Broker Core
 *
 * Supports dependency injection for testing while enforcing durable defaults in production.
 */
function createBrokerRuntime(options = {}) {
  const registryFilePath = options.registryPath || options.registryFilePath;
  const registryPort = options.registryPort || createProjectRegistry({
    registryFilePath,
    fs: options.registryFs || options.fs
  });

  const workspacePort = options.workspacePort || createWorkspaceStatePort(
    options.workspaceOptions || {}
  );

  // Mandatory: Production control commands MUST use durable SQLite store.
  // Never fallback to volatile memory store.
  const lifecycleStore = options.lifecycleStore || createSqliteLifecycleStore({
    dbPath: options.dbPath,
    clock: options.clock
  });

  const workerPort = options.workerPort || createAntigravityWorkerPort(
    options.workerOptions || {}
  );

  const broker = options.broker || createBroker({
    registryPort,
    workspacePort,
    workerPort,
    lifecycleStore,
    clock: options.clock,
    idFactory: options.idFactory
  });

  let closed = false;

  function close() {
    if (!closed) {
      closed = true;
      if (lifecycleStore && typeof lifecycleStore.close === 'function') {
        lifecycleStore.close();
      }
    }
  }

  return {
    broker,
    registryPort,
    workspacePort,
    workerPort,
    lifecycleStore,
    close
  };
}

module.exports = {
  createBrokerRuntime
};
