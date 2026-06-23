// Migration 027: Stop-hook auto-advance decision-core regression test.
//
// Run: node --test tests/stop-auto-advance.test.cjs
//
// Covers the pure `decideContinuation` core that the Stop hook uses to choose
// between blocking (injecting the next step) and allowing the stop, plus the
// `continuationMarkerPath` sanitiser. The live HTTP fetch and stdout emission
// are exercised separately by manual stdin-driven runs (see PR notes); this
// suite locks the loop-guard + opt-out invariants that protect the agent from
// infinite re-injection.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { __test__ } = require('../adapters/shared/claude-hooks.cjs');
const { decideContinuation, continuationMarkerPath } = __test__;

test('null continuation (daemon down / opt-out / plan complete) allows stop and clears marker', () => {
  for (const continuation of [null, {}, { next: null }, { next: {} }]) {
    const d = decideContinuation({ continuation, lastStepId: null, stopHookActive: false });
    assert.equal(d.block, false, `expected allow-stop for ${JSON.stringify(continuation)}`);
    assert.equal(d.marker, null, 'marker must be cleared');
  }
});

test('first injection of a fresh step blocks and records the marker', () => {
  const continuation = {
    next: { kind: 'task', id: 'TASK-1', title: 'T1' },
    instruction: '다음 태스크를 진행하라: T1 (TASK-1).',
  };
  const d = decideContinuation({ continuation, lastStepId: null, stopHookActive: false });
  assert.equal(d.block, true);
  assert.equal(d.reason, continuation.instruction);
  assert.equal(d.marker, 'TASK-1');
});

test('a genuinely new step after a prior one blocks again', () => {
  const continuation = {
    next: { kind: 'task', id: 'TASK-2', title: 'T2' },
    instruction: 'go T2',
  };
  const d = decideContinuation({ continuation, lastStepId: 'TASK-1', stopHookActive: false });
  assert.equal(d.block, true);
  assert.equal(d.marker, 'TASK-2');
});

test('progress guard: identical step to the last injection allows stop (no infinite loop)', () => {
  const continuation = {
    next: { kind: 'task', id: 'TASK-1', title: 'T1' },
    instruction: 'go T1 again',
  };
  // Same step repeated → agent made no progress → allow stop.
  const d = decideContinuation({ continuation, lastStepId: 'TASK-1', stopHookActive: false });
  assert.equal(d.block, false);
  assert.equal(d.marker, 'TASK-1', 'marker retained so the guard persists');
});

test('progress guard holds even when stop_hook_active is set', () => {
  const continuation = {
    next: { kind: 'task', id: 'TASK-1', title: 'T1' },
    instruction: 'go T1',
  };
  const d = decideContinuation({ continuation, lastStepId: 'TASK-1', stopHookActive: true });
  assert.equal(d.block, false);
});

test('unit-kind next step blocks and injects the phase instruction', () => {
  const continuation = {
    next: { kind: 'unit', id: 'UNIT-9', title: 'Phase 2' },
    instruction: '다음 페이즈(unit)로 진행: Phase 2 (UNIT-9).',
  };
  const d = decideContinuation({ continuation, lastStepId: 'TASK-7', stopHookActive: false });
  assert.equal(d.block, true);
  assert.equal(d.marker, 'UNIT-9');
  assert.equal(d.reason, continuation.instruction);
});

test('continuationMarkerPath sanitises the session id and stays in cacheDir', () => {
  const p = continuationMarkerPath('sess/../../etc/passwd');
  assert.equal(path.basename(p), 'continuation-sess_.._.._etc_passwd.json');
  assert.ok(!p.includes('..' + path.sep), 'no path traversal segments survive');
  const p2 = continuationMarkerPath('');
  assert.equal(path.basename(p2), 'continuation-unknown.json');
});
