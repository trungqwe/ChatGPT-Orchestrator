'use strict';

/**
 * Validates whether a value is a plain JavaScript object.
 * Prototype must be Object.prototype or null.
 */
function isPlainObject(val) {
  if (!val || typeof val !== 'object' || Array.isArray(val)) {
    return false;
  }
  const proto = Object.getPrototypeOf(val);
  return proto === Object.prototype || proto === null;
}

/**
 * Checks whether a string contains leading or trailing whitespace.
 */
function hasSurroundingWhitespace(str) {
  return /^\s|\s$/.test(str);
}

/**
 * Generic Worker Adapter Registry Factory (WO-V4-08B / WP-V4-08)
 *
 * Implements a broker-facing WorkerPortV1 facade:
 * - dispatch(args): routes to exact registered engine adapter
 * - wait(args): routes to exact registered engine adapter
 *
 * Enforces closure-private snapshot immutability, exact engine matching,
 * zero fallback, and fail-closed resolution semantics.
 */
function createWorkerAdapterRegistry(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new Error('options must be an object');
  }

  if (!Array.isArray(options.adapters)) {
    throw new Error('options.adapters must be an array');
  }

  if (options.adapters.length === 0) {
    throw new Error('options.adapters must be a non-empty array');
  }

  // Closure-private snapshot lookup storage (never exposed to callers)
  const adaptersByEngine = new Map();

  for (let i = 0; i < options.adapters.length; i++) {
    const entry = options.adapters[i];

    if (!isPlainObject(entry)) {
      throw new Error(`Worker adapter registration entry at index ${i} must be a plain object`);
    }

    if (typeof entry.engine !== 'string' || entry.engine.length === 0) {
      throw new Error(`Worker adapter registration at index ${i} requires a non-empty engine string`);
    }

    if (hasSurroundingWhitespace(entry.engine)) {
      throw new Error(`Worker adapter registration engine token cannot contain surrounding whitespace: '${entry.engine}'`);
    }

    if (adaptersByEngine.has(entry.engine)) {
      throw new Error(`Duplicate worker adapter engine registration: '${entry.engine}'`);
    }

    if (!entry.adapter || typeof entry.adapter !== 'object' || Array.isArray(entry.adapter)) {
      throw new Error(`Worker adapter for engine '${entry.engine}' must be a non-null object`);
    }

    if (typeof entry.adapter.dispatch !== 'function') {
      throw new Error(`Worker adapter for engine '${entry.engine}' must provide a dispatch function`);
    }

    if (typeof entry.adapter.wait !== 'function') {
      throw new Error(`Worker adapter for engine '${entry.engine}' must provide a wait function`);
    }

    // Snapshot exact engine string and adapter reference
    adaptersByEngine.set(entry.engine, entry.adapter);
  }

  /**
   * Internal private resolution logic.
   * Resolves ONLY from args.project.worker.engine.
   */
  function resolveAdapter(args) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      return null;
    }

    const { project, project_id } = args;

    if (!project || typeof project !== 'object' || Array.isArray(project)) {
      return null;
    }

    if (project.project_id !== project_id) {
      return null;
    }

    if (!project.worker || typeof project.worker !== 'object' || Array.isArray(project.worker)) {
      return null;
    }

    if (project.worker.enabled !== true) {
      return null;
    }

    if (typeof project.worker.engine !== 'string') {
      return null;
    }

    const engine = project.worker.engine;
    if (!adaptersByEngine.has(engine)) {
      return null;
    }

    return adaptersByEngine.get(engine);
  }

  /**
   * dispatch(args): WorkerPortV1 entry
   *
   * On resolution failure: returns deterministic definitive local failure.
   * On resolution success: delegates to adapter.dispatch with identical args.
   */
  async function dispatch(args) {
    const adapter = resolveAdapter(args);
    if (!adapter) {
      return {
        ok: false,
        definitive: true,
        error: 'Worker adapter unavailable'
      };
    }
    return adapter.dispatch(args);
  }

  /**
   * wait(args): WorkerPortV1 entry
   *
   * On resolution failure: THROWS Error('Worker adapter unavailable')
   * to enter broker catch boundary and map to WORKER_WAIT_UNAVAILABLE with zero state mutation.
   * On resolution success: delegates to adapter.wait with identical args.
   */
  function wait(args) {
    const adapter = resolveAdapter(args);
    if (!adapter) {
      throw new Error('Worker adapter unavailable');
    }
    return adapter.wait(args);
  }

  return {
    dispatch,
    wait
  };
}

module.exports = {
  createWorkerAdapterRegistry
};
