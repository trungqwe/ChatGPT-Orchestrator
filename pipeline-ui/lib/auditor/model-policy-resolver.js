'use strict';

/**
 * Native Codex Model Policy Resolver (WP-V4-06A)
 * Pure, deterministic resolution of logical auditor policies against runtime Codex App Server catalog.
 * Strictly decoupled from Registry schema and Antigravity worker lifecycle.
 */

const MODEL_POLICY_ERROR_CODES = Object.freeze({
  MODEL_POLICY_INVALID_REQUEST: 'MODEL_POLICY_INVALID_REQUEST',
  MODEL_POLICY_CATALOG_INVALID: 'MODEL_POLICY_CATALOG_INVALID',
  MODEL_POLICY_UNAVAILABLE: 'MODEL_POLICY_UNAVAILABLE'
});

class ModelPolicyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ModelPolicyError';
    this.code = code;
  }
}

function createModelPolicyError(code, message) {
  return new ModelPolicyError(code, message);
}

const VALID_AUDITOR_POLICIES = Object.freeze(new Set([
  'auditor_fast',
  'auditor_standard',
  'auditor_deep',
  'architecture_deep'
]));

const WORKER_POLICIES = Object.freeze(new Set([
  'worker_economy',
  'worker_standard'
]));

const DEFAULT_EFFORT_PREFERENCES = Object.freeze({
  auditor_fast: Object.freeze([
    'none',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
    'ultra'
  ]),
  auditor_deep: Object.freeze([
    'ultra',
    'max',
    'xhigh',
    'high',
    'medium',
    'low',
    'minimal',
    'none'
  ]),
  architecture_deep: Object.freeze([
    'ultra',
    'max',
    'xhigh',
    'high',
    'medium',
    'low',
    'minimal',
    'none'
  ])
});

const CONTROL_CHAR_REGEX = /[\x00-\x1f\x7f]/;
const MAX_IDENTIFIER_BYTES = 256;
const MAX_EFFORT_BYTES = 64;

function validateCatalogEntry(entry, idx) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw createModelPolicyError(
      MODEL_POLICY_ERROR_CODES.MODEL_POLICY_CATALOG_INVALID,
      `Catalog entry at index ${idx} must be a JSON object`
    );
  }

  // id (catalog id)
  if (
    typeof entry.id !== 'string' ||
    entry.id.trim().length === 0 ||
    entry.id.trim() !== entry.id ||
    Buffer.byteLength(entry.id, 'utf8') > MAX_IDENTIFIER_BYTES ||
    CONTROL_CHAR_REGEX.test(entry.id)
  ) {
    throw createModelPolicyError(
      MODEL_POLICY_ERROR_CODES.MODEL_POLICY_CATALOG_INVALID,
      `Catalog entry at index ${idx} has invalid or missing 'id'`
    );
  }

  // model (wire model selector)
  if (
    typeof entry.model !== 'string' ||
    entry.model.trim().length === 0 ||
    entry.model.trim() !== entry.model ||
    Buffer.byteLength(entry.model, 'utf8') > MAX_IDENTIFIER_BYTES ||
    CONTROL_CHAR_REGEX.test(entry.model)
  ) {
    throw createModelPolicyError(
      MODEL_POLICY_ERROR_CODES.MODEL_POLICY_CATALOG_INVALID,
      `Catalog entry at index ${idx} has invalid or missing 'model' selector`
    );
  }

  // hidden (boolean)
  if (typeof entry.hidden !== 'boolean') {
    throw createModelPolicyError(
      MODEL_POLICY_ERROR_CODES.MODEL_POLICY_CATALOG_INVALID,
      `Catalog entry at index ${idx} has invalid or missing boolean 'hidden'`
    );
  }

  // isDefault (boolean)
  if (typeof entry.isDefault !== 'boolean') {
    throw createModelPolicyError(
      MODEL_POLICY_ERROR_CODES.MODEL_POLICY_CATALOG_INVALID,
      `Catalog entry at index ${idx} has invalid or missing boolean 'isDefault'`
    );
  }

  // defaultReasoningEffort (string)
  if (
    typeof entry.defaultReasoningEffort !== 'string' ||
    entry.defaultReasoningEffort.trim().length === 0 ||
    entry.defaultReasoningEffort.trim() !== entry.defaultReasoningEffort ||
    Buffer.byteLength(entry.defaultReasoningEffort, 'utf8') > MAX_EFFORT_BYTES ||
    CONTROL_CHAR_REGEX.test(entry.defaultReasoningEffort)
  ) {
    throw createModelPolicyError(
      MODEL_POLICY_ERROR_CODES.MODEL_POLICY_CATALOG_INVALID,
      `Catalog entry at index ${idx} has invalid or missing 'defaultReasoningEffort'`
    );
  }

  // supportedReasoningEfforts (array of objects with reasoningEffort)
  if (!Array.isArray(entry.supportedReasoningEfforts)) {
    throw createModelPolicyError(
      MODEL_POLICY_ERROR_CODES.MODEL_POLICY_CATALOG_INVALID,
      `Catalog entry at index ${idx} has invalid 'supportedReasoningEfforts' (must be array)`
    );
  }

  for (let sIdx = 0; sIdx < entry.supportedReasoningEfforts.length; sIdx++) {
    const item = entry.supportedReasoningEfforts[sIdx];
    if (
      !item ||
      typeof item !== 'object' ||
      Array.isArray(item) ||
      typeof item.reasoningEffort !== 'string' ||
      item.reasoningEffort.trim().length === 0 ||
      item.reasoningEffort.trim() !== item.reasoningEffort ||
      Buffer.byteLength(item.reasoningEffort, 'utf8') > MAX_EFFORT_BYTES ||
      CONTROL_CHAR_REGEX.test(item.reasoningEffort)
    ) {
      throw createModelPolicyError(
        MODEL_POLICY_ERROR_CODES.MODEL_POLICY_CATALOG_INVALID,
        `Catalog entry at index ${idx} supportedReasoningEfforts at index ${sIdx} is malformed`
      );
    }
  }
}

/**
 * Resolve logical auditor model policy against visible Codex App Server catalog entries.
 * Pure function: performs no network, process, or filesystem access.
 *
 * @param {Object} params
 * @param {string} params.policy - Logical auditor policy ('auditor_fast', 'auditor_standard', 'auditor_deep', 'architecture_deep')
 * @param {Array<Object>} params.models - Complete visible catalog returned by App Server model/list
 * @param {Object} [params.preferences] - Optional reasoning effort preference overrides
 * @returns {{ catalog_id: string, model: string, reasoning_effort: string, policy: string }}
 */
function resolveAuditorModelPolicy(params = {}) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    throw createModelPolicyError(
      MODEL_POLICY_ERROR_CODES.MODEL_POLICY_INVALID_REQUEST,
      'resolveAuditorModelPolicy requires a parameters object'
    );
  }

  const { policy, models, preferences } = params;

  if (WORKER_POLICIES.has(policy)) {
    throw createModelPolicyError(
      MODEL_POLICY_ERROR_CODES.MODEL_POLICY_INVALID_REQUEST,
      `Worker policy '${policy}' is out of Codex resolver scope`
    );
  }

  if (typeof policy !== 'string' || !VALID_AUDITOR_POLICIES.has(policy)) {
    throw createModelPolicyError(
      MODEL_POLICY_ERROR_CODES.MODEL_POLICY_INVALID_REQUEST,
      `Invalid or unsupported auditor model policy '${policy}'`
    );
  }

  if (!Array.isArray(models)) {
    throw createModelPolicyError(
      MODEL_POLICY_ERROR_CODES.MODEL_POLICY_CATALOG_INVALID,
      'Catalog models must be an array'
    );
  }

  if (models.length === 0) {
    throw createModelPolicyError(
      MODEL_POLICY_ERROR_CODES.MODEL_POLICY_UNAVAILABLE,
      'Catalog is empty; no model available'
    );
  }

  // Validate all catalog entries & check duplicate model selectors
  const seenSelectors = new Set();
  for (let i = 0; i < models.length; i++) {
    const entry = models[i];
    validateCatalogEntry(entry, i);
    if (seenSelectors.has(entry.model)) {
      throw createModelPolicyError(
        MODEL_POLICY_ERROR_CODES.MODEL_POLICY_CATALOG_INVALID,
        `Duplicate model selector '${entry.model}' in catalog`
      );
    }
    seenSelectors.add(entry.model);
  }

  // Filter visible models (hidden models are not candidates in 06A)
  const visibleModels = models.filter((m) => !m.hidden);
  if (visibleModels.length === 0) {
    throw createModelPolicyError(
      MODEL_POLICY_ERROR_CODES.MODEL_POLICY_UNAVAILABLE,
      'All catalog models are hidden; no visible candidate available'
    );
  }

  // Check multiple visible isDefault models
  const defaultVisibleCount = visibleModels.filter((m) => m.isDefault === true).length;
  if (defaultVisibleCount > 1) {
    throw createModelPolicyError(
      MODEL_POLICY_ERROR_CODES.MODEL_POLICY_CATALOG_INVALID,
      'Ambiguous catalog: multiple visible models marked isDefault'
    );
  }

  // Validate optional preferences
  let activePreferences = DEFAULT_EFFORT_PREFERENCES;
  if (preferences !== undefined) {
    if (!preferences || typeof preferences !== 'object' || Array.isArray(preferences)) {
      throw createModelPolicyError(
        MODEL_POLICY_ERROR_CODES.MODEL_POLICY_INVALID_REQUEST,
        'Preferences must be an object'
      );
    }
    for (const [k, v] of Object.entries(preferences)) {
      if (!Array.isArray(v)) {
        throw createModelPolicyError(
          MODEL_POLICY_ERROR_CODES.MODEL_POLICY_INVALID_REQUEST,
          `Preferences for '${k}' must be an array of reasoning effort strings`
        );
      }
      for (const item of v) {
        if (
          typeof item !== 'string' ||
          item.trim().length === 0 ||
          item.trim() !== item ||
          Buffer.byteLength(item, 'utf8') > MAX_EFFORT_BYTES ||
          CONTROL_CHAR_REGEX.test(item)
        ) {
          throw createModelPolicyError(
            MODEL_POLICY_ERROR_CODES.MODEL_POLICY_INVALID_REQUEST,
            `Preferences for '${k}' contains invalid reasoning effort string`
          );
        }
      }
    }
    activePreferences = Object.assign({}, DEFAULT_EFFORT_PREFERENCES, preferences);
  }

  // Standard policy: provider-default-oriented resolution
  if (policy === 'auditor_standard') {
    let selectedModel = null;
    let selectedEffort = null;

    const defaultModel = visibleModels.find((m) => m.isDefault === true);
    if (defaultModel) {
      const isDefaultEffortSupported = defaultModel.supportedReasoningEfforts.some(
        (s) => s.reasoningEffort === defaultModel.defaultReasoningEffort
      );
      if (isDefaultEffortSupported) {
        selectedModel = defaultModel;
        selectedEffort = defaultModel.defaultReasoningEffort;
      }
    }

    if (!selectedModel) {
      if (!defaultModel) {
        for (const candidate of visibleModels) {
          const isSupported = candidate.supportedReasoningEfforts.some(
            (s) => s.reasoningEffort === candidate.defaultReasoningEffort
          );
          if (isSupported) {
            selectedModel = candidate;
            selectedEffort = candidate.defaultReasoningEffort;
            break;
          }
        }
      }
    }

    if (!selectedModel || !selectedEffort) {
      throw createModelPolicyError(
        MODEL_POLICY_ERROR_CODES.MODEL_POLICY_UNAVAILABLE,
        'No compatible model candidate available for standard policy'
      );
    }

    return Object.freeze({
      catalog_id: selectedModel.id,
      model: selectedModel.model,
      reasoning_effort: selectedEffort,
      policy: 'auditor_standard'
    });
  }

  // Fast & Deep policies: effort preference traversal with provider-order / isDefault tie breaking
  const effortList = activePreferences[policy];
  if (!Array.isArray(effortList) || effortList.length === 0) {
    throw createModelPolicyError(
      MODEL_POLICY_ERROR_CODES.MODEL_POLICY_UNAVAILABLE,
      `No effort preferences configured for policy '${policy}'`
    );
  }

  let selectedModel = null;
  let selectedEffort = null;

  for (const effort of effortList) {
    const candidates = visibleModels.filter((m) =>
      m.supportedReasoningEfforts.some((s) => s.reasoningEffort === effort)
    );
    if (candidates.length > 0) {
      const defaultCandidate = candidates.find((m) => m.isDefault === true);
      selectedModel = defaultCandidate || candidates[0];
      selectedEffort = effort;
      break;
    }
  }

  if (!selectedModel || !selectedEffort) {
    throw createModelPolicyError(
      MODEL_POLICY_ERROR_CODES.MODEL_POLICY_UNAVAILABLE,
      `No compatible visible model supports preferred reasoning efforts for policy '${policy}'`
    );
  }

  return Object.freeze({
    catalog_id: selectedModel.id,
    model: selectedModel.model,
    reasoning_effort: selectedEffort,
    policy
  });
}

module.exports = {
  MODEL_POLICY_ERROR_CODES,
  ModelPolicyError,
  createModelPolicyError,
  VALID_AUDITOR_POLICIES,
  WORKER_POLICIES,
  DEFAULT_EFFORT_PREFERENCES,
  resolveAuditorModelPolicy
};
