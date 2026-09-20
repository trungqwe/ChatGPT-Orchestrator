'use strict';

/**
 * Model Policy Resolver Test Suite (MPR-001 .. MPR-021)
 * Validates pure deterministic resolution of logical auditor policies against runtime catalog.
 */

const assert = require('node:assert');
const {
  MODEL_POLICY_ERROR_CODES,
  DEFAULT_EFFORT_PREFERENCES,
  resolveAuditorModelPolicy
} = require('../../lib/auditor/model-policy-resolver');

function createSampleCatalog() {
  return [
    {
      id: 'mock-model-fast',
      model: 'mock-model-fast',
      displayName: 'Mock Fast',
      description: 'Fast model',
      hidden: false,
      isDefault: false,
      defaultReasoningEffort: 'low',
      supportedReasoningEfforts: [
        { reasoningEffort: 'none', description: 'None' },
        { reasoningEffort: 'minimal', description: 'Minimal' },
        { reasoningEffort: 'low', description: 'Low' }
      ]
    },
    {
      id: 'mock-model-standard',
      model: 'mock-model-standard',
      displayName: 'Mock Standard',
      description: 'Standard model',
      hidden: false,
      isDefault: true,
      defaultReasoningEffort: 'medium',
      supportedReasoningEfforts: [
        { reasoningEffort: 'low', description: 'Low' },
        { reasoningEffort: 'medium', description: 'Medium' },
        { reasoningEffort: 'high', description: 'High' }
      ]
    },
    {
      id: 'mock-model-deep',
      model: 'mock-model-deep',
      displayName: 'Mock Deep',
      description: 'Deep model',
      hidden: false,
      isDefault: false,
      defaultReasoningEffort: 'high',
      supportedReasoningEfforts: [
        { reasoningEffort: 'medium', description: 'Medium' },
        { reasoningEffort: 'high', description: 'High' },
        { reasoningEffort: 'ultra', description: 'Ultra' }
      ]
    }
  ];
}

console.log('Starting Model Policy Resolver test suite (MPR-001 .. MPR-021)...');

// MPR-001: valid standard provider-default selection
{
  const catalog = createSampleCatalog();
  const res = resolveAuditorModelPolicy({ policy: 'auditor_standard', models: catalog });
  assert.strictEqual(res.catalog_id, 'mock-model-standard');
  assert.strictEqual(res.model, 'mock-model-standard');
  assert.strictEqual(res.reasoning_effort, 'medium');
  assert.strictEqual(res.policy, 'auditor_standard');
  console.log('PASS: MPR-001 — Valid standard provider-default selection');
}

// MPR-002: standard default effort explicitly supported
{
  const catalog = [
    {
      id: 'mock-model-a',
      model: 'mock-model-a',
      hidden: false,
      isDefault: true,
      defaultReasoningEffort: 'low',
      supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Low' }]
    }
  ];
  const res = resolveAuditorModelPolicy({ policy: 'auditor_standard', models: catalog });
  assert.strictEqual(res.model, 'mock-model-a');
  assert.strictEqual(res.reasoning_effort, 'low');
  console.log('PASS: MPR-002 — Standard default effort explicitly supported');
}

// MPR-003: standard fallback to first valid catalog model when none claims isDefault
{
  const catalog = [
    {
      id: 'mock-model-first',
      model: 'mock-model-first',
      hidden: false,
      isDefault: false,
      defaultReasoningEffort: 'medium',
      supportedReasoningEfforts: [{ reasoningEffort: 'medium' }]
    },
    {
      id: 'mock-model-second',
      model: 'mock-model-second',
      hidden: false,
      isDefault: false,
      defaultReasoningEffort: 'high',
      supportedReasoningEfforts: [{ reasoningEffort: 'high' }]
    }
  ];
  const res = resolveAuditorModelPolicy({ policy: 'auditor_standard', models: catalog });
  assert.strictEqual(res.catalog_id, 'mock-model-first');
  assert.strictEqual(res.model, 'mock-model-first');
  assert.strictEqual(res.reasoning_effort, 'medium');
  console.log('PASS: MPR-003 — Standard fallback to first valid catalog model');
}

// MPR-004: multiple isDefault models rejected
{
  const catalog = [
    {
      id: 'mock-model-1',
      model: 'mock-model-1',
      hidden: false,
      isDefault: true,
      defaultReasoningEffort: 'low',
      supportedReasoningEfforts: [{ reasoningEffort: 'low' }]
    },
    {
      id: 'mock-model-2',
      model: 'mock-model-2',
      hidden: false,
      isDefault: true,
      defaultReasoningEffort: 'medium',
      supportedReasoningEfforts: [{ reasoningEffort: 'medium' }]
    }
  ];
  assert.throws(
    () => resolveAuditorModelPolicy({ policy: 'auditor_standard', models: catalog }),
    (err) => err.code === MODEL_POLICY_ERROR_CODES.MODEL_POLICY_CATALOG_INVALID
  );
  console.log('PASS: MPR-004 — Multiple isDefault models rejected as ambiguous');
}

// MPR-005: fast effort preference selects highest priority supported effort
{
  const catalog = createSampleCatalog();
  const res = resolveAuditorModelPolicy({ policy: 'auditor_fast', models: catalog });
  // auditor_fast preferences: ['none', 'minimal', 'low', 'medium', 'high', ...]
  // mock-model-fast supports 'none'
  assert.strictEqual(res.catalog_id, 'mock-model-fast');
  assert.strictEqual(res.model, 'mock-model-fast');
  assert.strictEqual(res.reasoning_effort, 'none');
  assert.strictEqual(res.policy, 'auditor_fast');
  console.log('PASS: MPR-005 — Fast effort preference selects none/minimal before low');
}

// MPR-006: deep effort preference selects highest priority supported effort
{
  const catalog = createSampleCatalog();
  const res = resolveAuditorModelPolicy({ policy: 'auditor_deep', models: catalog });
  // auditor_deep preferences: ['ultra', 'max', 'xhigh', 'high', ...]
  // mock-model-deep supports 'ultra'
  assert.strictEqual(res.catalog_id, 'mock-model-deep');
  assert.strictEqual(res.model, 'mock-model-deep');
  assert.strictEqual(res.reasoning_effort, 'ultra');
  assert.strictEqual(res.policy, 'auditor_deep');
  console.log('PASS: MPR-006 — Deep effort preference selects ultra');
}

// MPR-007: architecture_deep behavior
{
  const catalog = createSampleCatalog();
  const res = resolveAuditorModelPolicy({ policy: 'architecture_deep', models: catalog });
  assert.strictEqual(res.catalog_id, 'mock-model-deep');
  assert.strictEqual(res.model, 'mock-model-deep');
  assert.strictEqual(res.reasoning_effort, 'ultra');
  assert.strictEqual(res.policy, 'architecture_deep');
  console.log('PASS: MPR-007 — architecture_deep resolves identically to deep preference');
}

// MPR-008: unsupported policy rejected
{
  const catalog = createSampleCatalog();
  assert.throws(
    () => resolveAuditorModelPolicy({ policy: 'unsupported_policy', models: catalog }),
    (err) => err.code === MODEL_POLICY_ERROR_CODES.MODEL_POLICY_INVALID_REQUEST
  );
  console.log('PASS: MPR-008 — Unsupported policy rejected');
}

// MPR-009: worker policies rejected as out of scope
{
  const catalog = createSampleCatalog();
  assert.throws(
    () => resolveAuditorModelPolicy({ policy: 'worker_economy', models: catalog }),
    (err) => err.code === MODEL_POLICY_ERROR_CODES.MODEL_POLICY_INVALID_REQUEST
  );
  assert.throws(
    () => resolveAuditorModelPolicy({ policy: 'worker_standard', models: catalog }),
    (err) => err.code === MODEL_POLICY_ERROR_CODES.MODEL_POLICY_INVALID_REQUEST
  );
  console.log('PASS: MPR-009 — Worker policies rejected as out of scope');
}

// MPR-010: empty catalog unavailable
{
  assert.throws(
    () => resolveAuditorModelPolicy({ policy: 'auditor_standard', models: [] }),
    (err) => err.code === MODEL_POLICY_ERROR_CODES.MODEL_POLICY_UNAVAILABLE
  );
  console.log('PASS: MPR-010 — Empty catalog unavailable');
}

// MPR-011: all hidden unavailable
{
  const catalog = [
    {
      id: 'mock-model-hidden-1',
      model: 'mock-model-hidden-1',
      hidden: true,
      isDefault: false,
      defaultReasoningEffort: 'low',
      supportedReasoningEfforts: [{ reasoningEffort: 'low' }]
    },
    {
      id: 'mock-model-hidden-2',
      model: 'mock-model-hidden-2',
      hidden: true,
      isDefault: true,
      defaultReasoningEffort: 'medium',
      supportedReasoningEfforts: [{ reasoningEffort: 'medium' }]
    }
  ];
  assert.throws(
    () => resolveAuditorModelPolicy({ policy: 'auditor_standard', models: catalog }),
    (err) => err.code === MODEL_POLICY_ERROR_CODES.MODEL_POLICY_UNAVAILABLE
  );
  console.log('PASS: MPR-011 — All hidden models unavailable');
}

// MPR-012: malformed model entry rejected
{
  assert.throws(
    () => resolveAuditorModelPolicy({ policy: 'auditor_standard', models: [null] }),
    (err) => err.code === MODEL_POLICY_ERROR_CODES.MODEL_POLICY_CATALOG_INVALID
  );
  assert.throws(
    () => resolveAuditorModelPolicy({ policy: 'auditor_standard', models: ['string-item'] }),
    (err) => err.code === MODEL_POLICY_ERROR_CODES.MODEL_POLICY_CATALOG_INVALID
  );
  console.log('PASS: MPR-012 — Malformed model entry rejected');
}

// MPR-013: missing model selector rejected
{
  const catalog = [
    {
      id: 'mock-model-1',
      // missing 'model'
      hidden: false,
      isDefault: false,
      defaultReasoningEffort: 'low',
      supportedReasoningEfforts: [{ reasoningEffort: 'low' }]
    }
  ];
  assert.throws(
    () => resolveAuditorModelPolicy({ policy: 'auditor_standard', models: catalog }),
    (err) => err.code === MODEL_POLICY_ERROR_CODES.MODEL_POLICY_CATALOG_INVALID
  );
  console.log('PASS: MPR-013 — Missing model selector rejected');
}

// MPR-014: missing catalog id rejected
{
  const catalog = [
    {
      // missing 'id'
      model: 'mock-model-1',
      hidden: false,
      isDefault: false,
      defaultReasoningEffort: 'low',
      supportedReasoningEfforts: [{ reasoningEffort: 'low' }]
    }
  ];
  assert.throws(
    () => resolveAuditorModelPolicy({ policy: 'auditor_standard', models: catalog }),
    (err) => err.code === MODEL_POLICY_ERROR_CODES.MODEL_POLICY_CATALOG_INVALID
  );
  console.log('PASS: MPR-014 — Missing catalog id rejected');
}

// MPR-015: malformed supportedReasoningEfforts rejected
{
  const catalog = [
    {
      id: 'mock-model-1',
      model: 'mock-model-1',
      hidden: false,
      isDefault: false,
      defaultReasoningEffort: 'low',
      supportedReasoningEfforts: 'not-an-array'
    }
  ];
  assert.throws(
    () => resolveAuditorModelPolicy({ policy: 'auditor_standard', models: catalog }),
    (err) => err.code === MODEL_POLICY_ERROR_CODES.MODEL_POLICY_CATALOG_INVALID
  );
  console.log('PASS: MPR-015 — Malformed supportedReasoningEfforts rejected');
}

// MPR-016: default effort not advertised yields MODEL_POLICY_UNAVAILABLE
{
  const catalog = [
    {
      id: 'mock-model-unsupported-default',
      model: 'mock-model-unsupported-default',
      hidden: false,
      isDefault: true,
      defaultReasoningEffort: 'ultra', // Not in supported list
      supportedReasoningEfforts: [{ reasoningEffort: 'low' }]
    }
  ];
  assert.throws(
    () => resolveAuditorModelPolicy({ policy: 'auditor_standard', models: catalog }),
    (err) => err.code === MODEL_POLICY_ERROR_CODES.MODEL_POLICY_UNAVAILABLE
  );
  console.log('PASS: MPR-016 — Default effort not advertised yields MODEL_POLICY_UNAVAILABLE');
}

// MPR-017: duplicate model selector rejected
{
  const catalog = [
    {
      id: 'mock-model-1',
      model: 'shared-model-selector',
      hidden: false,
      isDefault: false,
      defaultReasoningEffort: 'low',
      supportedReasoningEfforts: [{ reasoningEffort: 'low' }]
    },
    {
      id: 'mock-model-2',
      model: 'shared-model-selector', // duplicate model selector
      hidden: false,
      isDefault: false,
      defaultReasoningEffort: 'low',
      supportedReasoningEfforts: [{ reasoningEffort: 'low' }]
    }
  ];
  assert.throws(
    () => resolveAuditorModelPolicy({ policy: 'auditor_standard', models: catalog }),
    (err) => err.code === MODEL_POLICY_ERROR_CODES.MODEL_POLICY_CATALOG_INVALID
  );
  console.log('PASS: MPR-017 — Duplicate model selector rejected fail-closed');
}

// MPR-018: unknown efforts are not guessed
{
  const catalog = [
    {
      id: 'mock-model-exotic',
      model: 'mock-model-exotic',
      hidden: false,
      isDefault: false,
      defaultReasoningEffort: 'quantum',
      supportedReasoningEfforts: [{ reasoningEffort: 'quantum' }]
    }
  ];
  assert.throws(
    () => resolveAuditorModelPolicy({ policy: 'auditor_fast', models: catalog }),
    (err) => err.code === MODEL_POLICY_ERROR_CODES.MODEL_POLICY_UNAVAILABLE
  );
  console.log('PASS: MPR-018 — Unknown efforts are not guessed');
}

// MPR-019: input objects unchanged (immutability)
{
  const catalog = createSampleCatalog();
  const catalogSnapshot = JSON.stringify(catalog);
  const preferences = { auditor_fast: ['low', 'medium'] };
  const preferencesSnapshot = JSON.stringify(preferences);

  resolveAuditorModelPolicy({ policy: 'auditor_fast', models: catalog, preferences });

  assert.strictEqual(JSON.stringify(catalog), catalogSnapshot);
  assert.strictEqual(JSON.stringify(preferences), preferencesSnapshot);
  console.log('PASS: MPR-019 — Input catalog and preferences remain unchanged');
}

// MPR-020: provider-order tie preserved when neither is default
{
  const catalog = [
    {
      id: 'mock-model-first-order',
      model: 'mock-model-first-order',
      hidden: false,
      isDefault: false,
      defaultReasoningEffort: 'low',
      supportedReasoningEfforts: [{ reasoningEffort: 'low' }]
    },
    {
      id: 'mock-model-second-order',
      model: 'mock-model-second-order',
      hidden: false,
      isDefault: false,
      defaultReasoningEffort: 'low',
      supportedReasoningEfforts: [{ reasoningEffort: 'low' }]
    }
  ];
  const res = resolveAuditorModelPolicy({ policy: 'auditor_fast', models: catalog });
  assert.strictEqual(res.catalog_id, 'mock-model-first-order');
  console.log('PASS: MPR-020 — Provider catalog order tie preserved');
}

// MPR-021: no hard-coded model names in preference configuration
{
  for (const [pol, efforts] of Object.entries(DEFAULT_EFFORT_PREFERENCES)) {
    assert.strictEqual(Array.isArray(efforts), true);
    for (const eff of efforts) {
      assert.strictEqual(typeof eff, 'string');
      // Assert it is purely a semantic effort string, not a model name
      assert.strictEqual(/^[a-z]+$/.test(eff), true);
      assert.strictEqual(eff.includes('gpt'), false);
      assert.strictEqual(eff.includes('claude'), false);
      assert.strictEqual(eff.includes('model'), false);
    }
  }
  console.log('PASS: MPR-021 — Preference configuration contains zero hard-coded model names');
}

console.log('======================================================================');
console.log('ALL MODEL POLICY RESOLVER TESTS PASSED (MPR-001 .. MPR-021: 21/21 PASS)');
console.log('======================================================================');
