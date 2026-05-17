// LM-257 — project.enabled=0 hook bypass.
//
// Run: node --test tests/disabled-project-bypass.test.cjs
//
// `clawket project disable <id>` is the only legitimate hook bypass. The
// dashboard surfaces the same toggle (web/src/components/ProjectSettings.tsx).
// Before this leaf the toggle was cosmetic — hooks ignored `enabled` and
// kept enforcing. This test stubs the CLI shell-out used by
// `isProjectDisabled` and asserts the helper returns the right boolean for
// each project state, and that malformed daemon output fails closed.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const COMMON_PATH = path.resolve(__dirname, '..', 'adapters', 'shared', 'common.cjs');

// We intercept `exec` from common.cjs so the test never spawns a real
// `clawket` binary or daemon. The helper under test is `isProjectDisabled`,
// which calls `exec(\`${clawket} project resolve --cwd "${cwd}" --format json\`)`.
let stubbedExecOutput = null;
const realCommon = require(COMMON_PATH);
const originalLoad = Module._load;

function withStubbedExec(output, fn) {
  stubbedExecOutput = output;
  Module._load = function patched(request, parent, isMain) {
    if (request === path.resolve(parent ? path.dirname(parent.filename) : __dirname, 'common.cjs')
        || request.endsWith('/common.cjs')) {
      return { ...realCommon, exec: () => stubbedExecOutput };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  // Wipe require cache for the module under test so it picks up the stubbed
  // `exec` on its next require() call.
  delete require.cache[require.resolve('../adapters/shared/claude-hooks.cjs')];
  try {
    const { __test__ } = require('../adapters/shared/claude-hooks.cjs');
    return fn(__test__.isProjectDisabled);
  } finally {
    Module._load = originalLoad;
    stubbedExecOutput = null;
    delete require.cache[require.resolve('../adapters/shared/claude-hooks.cjs')];
  }
}

test('isProjectDisabled: enabled=0 → true (the bypass case)', () => {
  withStubbedExec(JSON.stringify({ id: 'PROJ-X', enabled: 0 }), (isProjectDisabled) => {
    assert.equal(isProjectDisabled('clawket-bin', '/tmp/some/cwd'), true);
  });
});

test('isProjectDisabled: enabled=1 → false (default enforcement)', () => {
  withStubbedExec(JSON.stringify({ id: 'PROJ-X', enabled: 1 }), (isProjectDisabled) => {
    assert.equal(isProjectDisabled('clawket-bin', '/tmp/some/cwd'), false);
  });
});

test('isProjectDisabled: project not found (null) → false (fail-closed)', () => {
  withStubbedExec('null', (isProjectDisabled) => {
    assert.equal(isProjectDisabled('clawket-bin', '/tmp/some/cwd'), false);
  });
});

test('isProjectDisabled: malformed JSON → false (fail-closed)', () => {
  withStubbedExec('not-json{', (isProjectDisabled) => {
    assert.equal(isProjectDisabled('clawket-bin', '/tmp/some/cwd'), false);
  });
});

test('isProjectDisabled: empty output (daemon down) → false (fail-closed)', () => {
  withStubbedExec('', (isProjectDisabled) => {
    assert.equal(isProjectDisabled('clawket-bin', '/tmp/some/cwd'), false);
  });
});

test('isProjectDisabled: empty cwd → false (no-op, no shell-out)', () => {
  withStubbedExec(JSON.stringify({ enabled: 0 }), (isProjectDisabled) => {
    assert.equal(isProjectDisabled('clawket-bin', ''), false);
    assert.equal(isProjectDisabled('clawket-bin', undefined), false);
  });
});

test('isProjectDisabled: missing enabled field → false (cannot prove disabled)', () => {
  withStubbedExec(JSON.stringify({ id: 'PROJ-X', name: 'foo' }), (isProjectDisabled) => {
    assert.equal(isProjectDisabled('clawket-bin', '/tmp/x'), false);
  });
});
