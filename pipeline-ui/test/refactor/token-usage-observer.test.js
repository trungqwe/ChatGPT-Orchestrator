'use strict';

/**
 * Token Usage Observer Test Suite (TUO-001 .. TUO-023)
 * Validates pure bounded token-usage observation, exact counter preservation,
 * detachment immutability, bounded eviction, and rejection of malformed payloads.
 */

const assert = require('node:assert');
const {
  TokenUsageObserver,
  createTokenUsageObserver,
  validateTokenUsageNotification,
  REQUIRED_COUNTERS
} = require('../../lib/auditor/token-usage-observer');

function createSampleNotification(overrides = {}) {
  const base = {
    threadId: 'thr_test_001',
    turnId: 'turn_test_001',
    tokenUsage: {
      total: {
        totalTokens: 18055,
        inputTokens: 18050,
        cachedInputTokens: 11008,
        cacheWriteInputTokens: 0,
        outputTokens: 5,
        reasoningOutputTokens: 0
      },
      last: {
        totalTokens: 18055,
        inputTokens: 18050,
        cachedInputTokens: 11008,
        cacheWriteInputTokens: 0,
        outputTokens: 5,
        reasoningOutputTokens: 0
      },
      modelContextWindow: 258400
    }
  };
  return JSON.parse(JSON.stringify(Object.assign(base, overrides)));
}

console.log('Starting Token Usage Observer test suite (TUO-001 .. TUO-023)...');

// TUO-001: valid notification accepted
{
  const observer = createTokenUsageObserver();
  const notif = createSampleNotification();
  const result = observer.record(notif);
  assert.strictEqual(typeof result, 'object');
  assert.strictEqual(result.threadId, 'thr_test_001');
  assert.strictEqual(result.turnId, 'turn_test_001');
  assert.strictEqual(result.modelContextWindow, 258400);
  console.log('PASS: TUO-001 — valid notification accepted');
}

// TUO-002: all six total counters preserved losslessly
{
  const observer = createTokenUsageObserver();
  const notif = createSampleNotification();
  notif.tokenUsage.total = {
    totalTokens: 1234567,
    inputTokens: 1000000,
    cachedInputTokens: 200000,
    cacheWriteInputTokens: 30000,
    outputTokens: 4567,
    reasoningOutputTokens: 2000
  };
  observer.record(notif);
  const snapshot = observer.getLatestForThread('thr_test_001');
  assert.notStrictEqual(snapshot, null);
  for (const counter of REQUIRED_COUNTERS) {
    assert.strictEqual(
      snapshot.total[counter],
      notif.tokenUsage.total[counter],
      `Counter total.${counter} must be preserved losslessly`
    );
  }
  console.log('PASS: TUO-002 — all six total counters preserved');
}

// TUO-003: all six last counters preserved losslessly
{
  const observer = createTokenUsageObserver();
  const notif = createSampleNotification();
  notif.tokenUsage.last = {
    totalTokens: 98765,
    inputTokens: 80000,
    cachedInputTokens: 15000,
    cacheWriteInputTokens: 500,
    outputTokens: 18765,
    reasoningOutputTokens: 9000
  };
  observer.record(notif);
  const snapshot = observer.getLatestForThread('thr_test_001');
  assert.notStrictEqual(snapshot, null);
  for (const counter of REQUIRED_COUNTERS) {
    assert.strictEqual(
      snapshot.last[counter],
      notif.tokenUsage.last[counter],
      `Counter last.${counter} must be preserved losslessly`
    );
  }
  console.log('PASS: TUO-003 — all six last counters preserved');
}

// TUO-004: modelContextWindow null accepted
{
  const observer = createTokenUsageObserver();
  const notif = createSampleNotification();
  notif.tokenUsage.modelContextWindow = null;
  const recorded = observer.record(notif);
  assert.strictEqual(recorded.modelContextWindow, null);
  const retrieved = observer.getLatestForThread('thr_test_001');
  assert.strictEqual(retrieved.modelContextWindow, null);
  console.log('PASS: TUO-004 — modelContextWindow null accepted');
}

// TUO-005: modelContextWindow integer accepted
{
  const observer = createTokenUsageObserver();
  const notif = createSampleNotification();
  notif.tokenUsage.modelContextWindow = 1048576;
  const recorded = observer.record(notif);
  assert.strictEqual(recorded.modelContextWindow, 1048576);
  const retrieved = observer.getLatestForThread('thr_test_001');
  assert.strictEqual(retrieved.modelContextWindow, 1048576);
  console.log('PASS: TUO-005 — modelContextWindow integer accepted');
}

// TUO-006: negative counter rejected
{
  const observer = createTokenUsageObserver();
  const notif = createSampleNotification();
  notif.tokenUsage.total.outputTokens = -1;
  let caught = null;
  try {
    observer.record(notif);
  } catch (err) {
    caught = err;
  }
  assert.notStrictEqual(caught, null);
  assert.strictEqual(caught.code, 'TOKEN_USAGE_INVALID_COUNTER');
  console.log('PASS: TUO-006 — negative counter rejected');
}

// TUO-007: fraction counter rejected
{
  const observer = createTokenUsageObserver();
  const notif = createSampleNotification();
  notif.tokenUsage.last.inputTokens = 12.34;
  let caught = null;
  try {
    observer.record(notif);
  } catch (err) {
    caught = err;
  }
  assert.notStrictEqual(caught, null);
  assert.strictEqual(caught.code, 'TOKEN_USAGE_INVALID_COUNTER');
  console.log('PASS: TUO-007 — fraction rejected');
}

// TUO-008: unsafe integer rejected
{
  const observer = createTokenUsageObserver();
  const notif = createSampleNotification();
  notif.tokenUsage.total.totalTokens = Number.MAX_SAFE_INTEGER + 1000;
  let caught = null;
  try {
    observer.record(notif);
  } catch (err) {
    caught = err;
  }
  assert.notStrictEqual(caught, null);
  assert.strictEqual(caught.code, 'TOKEN_USAGE_INVALID_COUNTER');
  console.log('PASS: TUO-008 — unsafe integer rejected');
}

// TUO-009: missing counter rejected
{
  const observer = createTokenUsageObserver();
  const notif = createSampleNotification();
  delete notif.tokenUsage.total.reasoningOutputTokens;
  let caught = null;
  try {
    observer.record(notif);
  } catch (err) {
    caught = err;
  }
  assert.notStrictEqual(caught, null);
  assert.strictEqual(caught.code, 'TOKEN_USAGE_INVALID_NOTIFICATION');
  console.log('PASS: TUO-009 — missing counter rejected');
}

// TUO-010: missing breakdown object rejected
{
  const observer = createTokenUsageObserver();
  const notif = createSampleNotification();
  delete notif.tokenUsage.last;
  let caught = null;
  try {
    observer.record(notif);
  } catch (err) {
    caught = err;
  }
  assert.notStrictEqual(caught, null);
  assert.strictEqual(caught.code, 'TOKEN_USAGE_INVALID_NOTIFICATION');
  console.log('PASS: TUO-010 — missing breakdown object rejected');
}

// TUO-011: invalid threadId rejected
{
  const observer = createTokenUsageObserver();
  const invalidIds = ['', '   ', null, undefined, 123, 'a'.repeat(257), 'bad\x00id'];
  for (const id of invalidIds) {
    const notif = createSampleNotification({ threadId: id });
    let caught = null;
    try {
      observer.record(notif);
    } catch (err) {
      caught = err;
    }
    assert.notStrictEqual(caught, null, `threadId '${id}' should be rejected`);
    assert.strictEqual(caught.code, 'TOKEN_USAGE_INVALID_NOTIFICATION');
  }
  console.log('PASS: TUO-011 — invalid threadId rejected');
}

// TUO-012: invalid turnId rejected
{
  const observer = createTokenUsageObserver();
  const invalidIds = ['', '   ', null, undefined, 123, 'a'.repeat(257), 'bad\x1fid'];
  for (const id of invalidIds) {
    const notif = createSampleNotification({ turnId: id });
    let caught = null;
    try {
      observer.record(notif);
    } catch (err) {
      caught = err;
    }
    assert.notStrictEqual(caught, null, `turnId '${id}' should be rejected`);
    assert.strictEqual(caught.code, 'TOKEN_USAGE_INVALID_NOTIFICATION');
  }
  console.log('PASS: TUO-012 — invalid turnId rejected');
}

// TUO-013: input immutability
{
  const observer = createTokenUsageObserver();
  const notif = createSampleNotification();
  observer.record(notif);

  // Mutate caller input object after record
  notif.tokenUsage.total.totalTokens = 999999999;
  notif.tokenUsage.last.outputTokens = 888888;
  notif.tokenUsage.modelContextWindow = 1;

  const snapshot = observer.getLatestForThread('thr_test_001');
  assert.strictEqual(snapshot.total.totalTokens, 18055);
  assert.strictEqual(snapshot.last.outputTokens, 5);
  assert.strictEqual(snapshot.modelContextWindow, 258400);
  console.log('PASS: TUO-013 — input immutability');
}

// TUO-014: output detachment
{
  const observer = createTokenUsageObserver();
  const notif = createSampleNotification();
  const ret1 = observer.record(notif);

  // Mutate return value from record()
  ret1.total.totalTokens = 999999999;
  ret1.last.outputTokens = 888888;

  const snapshot1 = observer.getLatestForThread('thr_test_001');
  assert.strictEqual(snapshot1.total.totalTokens, 18055);
  assert.strictEqual(snapshot1.last.outputTokens, 5);

  // Mutate return value from getLatestForThread()
  snapshot1.total.totalTokens = 777777777;

  const snapshot2 = observer.getLatestForThread('thr_test_001');
  assert.strictEqual(snapshot2.total.totalTokens, 18055);
  console.log('PASS: TUO-014 — output detachment');
}

// TUO-015: latest thread snapshot replacement
{
  const observer = createTokenUsageObserver();
  const notif1 = createSampleNotification({ turnId: 'turn_001' });
  notif1.tokenUsage.total.totalTokens = 1000;
  observer.record(notif1);

  const notif2 = createSampleNotification({ turnId: 'turn_002' });
  notif2.tokenUsage.total.totalTokens = 2500;
  observer.record(notif2);

  const latest = observer.getLatestForThread('thr_test_001');
  assert.strictEqual(latest.turnId, 'turn_002');
  assert.strictEqual(latest.total.totalTokens, 2500);
  console.log('PASS: TUO-015 — latest thread snapshot replacement');
}

// TUO-016: latest turn snapshot replacement
{
  const observer = createTokenUsageObserver();
  const notif1 = createSampleNotification({ turnId: 'turn_001' });
  notif1.tokenUsage.total.totalTokens = 1000;
  observer.record(notif1);

  const notif2 = createSampleNotification({ turnId: 'turn_001' });
  notif2.tokenUsage.total.totalTokens = 1500;
  observer.record(notif2);

  const turnUsage = observer.getLatestForTurn({
    threadId: 'thr_test_001',
    turnId: 'turn_001'
  });
  assert.strictEqual(turnUsage.total.totalTokens, 1500);
  console.log('PASS: TUO-016 — latest turn snapshot replacement');
}

// TUO-017: no accumulation across repeated snapshots
{
  const observer = createTokenUsageObserver();
  const notif1 = createSampleNotification({ turnId: 'turn_001' });
  notif1.tokenUsage.total.totalTokens = 100;
  notif1.tokenUsage.last.totalTokens = 100;
  observer.record(notif1);

  const notif2 = createSampleNotification({ turnId: 'turn_001' });
  notif2.tokenUsage.total.totalTokens = 150;
  notif2.tokenUsage.last.totalTokens = 50;
  observer.record(notif2);

  const latest = observer.getLatestForTurn({
    threadId: 'thr_test_001',
    turnId: 'turn_001'
  });
  // Must be 150, NEVER 100 + 150 = 250
  assert.strictEqual(latest.total.totalTokens, 150);
  // Must be 50, NEVER 100 + 50 = 150
  assert.strictEqual(latest.last.totalTokens, 50);
  console.log('PASS: TUO-017 — no accumulation across repeated snapshots');
}

// TUO-018: bounded thread eviction
{
  const observer = createTokenUsageObserver({ maxThreads: 3 });
  observer.record(createSampleNotification({ threadId: 'thr_1', turnId: 't1' }));
  observer.record(createSampleNotification({ threadId: 'thr_2', turnId: 't2' }));
  observer.record(createSampleNotification({ threadId: 'thr_3', turnId: 't3' }));

  assert.notStrictEqual(observer.getLatestForThread('thr_1'), null);
  assert.notStrictEqual(observer.getLatestForThread('thr_2'), null);
  assert.notStrictEqual(observer.getLatestForThread('thr_3'), null);

  // 4th thread pushes out oldest (thr_1)
  observer.record(createSampleNotification({ threadId: 'thr_4', turnId: 't4' }));
  assert.strictEqual(observer.getLatestForThread('thr_1'), null);
  assert.notStrictEqual(observer.getLatestForThread('thr_2'), null);
  assert.notStrictEqual(observer.getLatestForThread('thr_3'), null);
  assert.notStrictEqual(observer.getLatestForThread('thr_4'), null);
  console.log('PASS: TUO-018 — bounded thread eviction');
}

// TUO-019: bounded turn eviction
{
  const observer = createTokenUsageObserver({ maxTurns: 3 });
  observer.record(createSampleNotification({ threadId: 'thr_1', turnId: 'turn_1' }));
  observer.record(createSampleNotification({ threadId: 'thr_1', turnId: 'turn_2' }));
  observer.record(createSampleNotification({ threadId: 'thr_1', turnId: 'turn_3' }));

  assert.notStrictEqual(observer.getLatestForTurn({ threadId: 'thr_1', turnId: 'turn_1' }), null);
  assert.notStrictEqual(observer.getLatestForTurn({ threadId: 'thr_1', turnId: 'turn_2' }), null);
  assert.notStrictEqual(observer.getLatestForTurn({ threadId: 'thr_1', turnId: 'turn_3' }), null);

  // 4th turn pushes out oldest (turn_1)
  observer.record(createSampleNotification({ threadId: 'thr_1', turnId: 'turn_4' }));
  assert.strictEqual(observer.getLatestForTurn({ threadId: 'thr_1', turnId: 'turn_1' }), null);
  assert.notStrictEqual(observer.getLatestForTurn({ threadId: 'thr_1', turnId: 'turn_2' }), null);
  assert.notStrictEqual(observer.getLatestForTurn({ threadId: 'thr_1', turnId: 'turn_3' }), null);
  assert.notStrictEqual(observer.getLatestForTurn({ threadId: 'thr_1', turnId: 'turn_4' }), null);
  console.log('PASS: TUO-019 — bounded turn eviction');
}

// TUO-020: unknown exact lookup returns null
{
  const observer = createTokenUsageObserver();
  assert.strictEqual(observer.getLatestForThread('nonexistent_thread'), null);
  assert.strictEqual(observer.getLatestForTurn({ threadId: 'thr_none', turnId: 'turn_none' }), null);
  assert.strictEqual(observer.getLatestForTurn(null), null);
  assert.strictEqual(observer.getLatestForTurn({}), null);
  console.log('PASS: TUO-020 — unknown exact lookup returns null');
}

// TUO-021: getLatestForTurn does not fall back to other threads or turns
{
  const observer = createTokenUsageObserver();
  observer.record(createSampleNotification({ threadId: 'thr_A', turnId: 'turn_1' }));
  observer.record(createSampleNotification({ threadId: 'thr_B', turnId: 'turn_2' }));

  // Query thr_B with turn_1 => null (must NOT fall back to thr_A's turn_1)
  assert.strictEqual(observer.getLatestForTurn({ threadId: 'thr_B', turnId: 'turn_1' }), null);

  // Query thr_A with turn_2 => null (must NOT fall back to thr_B's turn_2)
  assert.strictEqual(observer.getLatestForTurn({ threadId: 'thr_A', turnId: 'turn_2' }), null);
  console.log('PASS: TUO-021 — getLatestForTurn does not fall back to other threads');
}

// TUO-022: array where object expected rejected
{
  const observer = createTokenUsageObserver();
  let caught = null;
  try {
    observer.record([createSampleNotification()]);
  } catch (err) {
    caught = err;
  }
  assert.notStrictEqual(caught, null);
  assert.strictEqual(caught.code, 'TOKEN_USAGE_INVALID_NOTIFICATION');

  const notifArrayBreakdown = createSampleNotification();
  notifArrayBreakdown.tokenUsage.total = [1, 2, 3];
  caught = null;
  try {
    observer.record(notifArrayBreakdown);
  } catch (err) {
    caught = err;
  }
  assert.notStrictEqual(caught, null);
  assert.strictEqual(caught.code, 'TOKEN_USAGE_INVALID_NOTIFICATION');
  console.log('PASS: TUO-022 — array where object expected rejected');
}

// TUO-023: invalid modelContextWindow rejected
{
  const observer = createTokenUsageObserver();
  const invalidMcws = [-1, 10.5, '258400', true, false, Number.MAX_SAFE_INTEGER + 10];
  for (const mcw of invalidMcws) {
    const notif = createSampleNotification();
    notif.tokenUsage.modelContextWindow = mcw;
    let caught = null;
    try {
      observer.record(notif);
    } catch (err) {
      caught = err;
    }
    assert.notStrictEqual(caught, null, `modelContextWindow '${mcw}' should be rejected`);
    assert.strictEqual(caught.code, 'TOKEN_USAGE_INVALID_COUNTER');
  }
  console.log('PASS: TUO-023 — invalid modelContextWindow rejected');
}

console.log('======================================================================');
console.log('ALL TOKEN USAGE OBSERVER TESTS PASSED (TUO-001 .. TUO-023: 23/23 PASS)');
console.log('======================================================================');
