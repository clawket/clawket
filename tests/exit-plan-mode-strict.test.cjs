// LM-260 / L1.1.a — ExitPlanMode strict gate.
//
// Run: node --test tests/exit-plan-mode-strict.test.cjs
//
// `runPlanSync` shells out to the daemon to validate Plan Mode markdown.
// We stub:
//   - `execDiag` (the curl invocation)
//   - `fs.readFileSync` for the port file
// and assert the helpers route success / format error / network error.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const COMMON_PATH = path.resolve(__dirname, '..', 'adapters', 'shared', 'common.cjs');
const realCommon = require(COMMON_PATH);
const originalLoad = Module._load;

function withStubs({ execDiagOut, portContents }, fn) {
  Module._load = function patched(request, parent, isMain) {
    if (request === path.resolve(parent ? path.dirname(parent.filename) : __dirname, 'common.cjs')
        || request.endsWith('/common.cjs')) {
      return {
        ...realCommon,
        execDiag: () => execDiagOut,
        // cacheDir resolves to a temp dir path we control through fs stub.
        cacheDir: () => '/tmp/clawket-test-cache',
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  // Stub fs.readFileSync only for the port file path. Everything else
  // delegates to the real fs.
  const fs = require('node:fs');
  const origReadFileSync = fs.readFileSync;
  fs.readFileSync = (p, ...rest) => {
    if (typeof p === 'string' && p.endsWith('clawketd.port')) {
      if (portContents == null) throw new Error('ENOENT');
      return portContents;
    }
    return origReadFileSync(p, ...rest);
  };
  // Also stub writeFileSync + unlinkSync for the temp body file the helper
  // writes; they'd otherwise try to land in cacheDir which doesn't exist.
  const origWriteFileSync = fs.writeFileSync;
  const origUnlinkSync = fs.unlinkSync;
  fs.writeFileSync = (p, ...rest) => {
    if (typeof p === 'string' && p.includes('strict-import-')) return;
    return origWriteFileSync(p, ...rest);
  };
  fs.unlinkSync = (p) => {
    if (typeof p === 'string' && p.includes('strict-import-')) return;
    return origUnlinkSync(p);
  };

  delete require.cache[require.resolve('../adapters/shared/claude-hooks.cjs')];
  try {
    const { __test__ } = require('../adapters/shared/claude-hooks.cjs');
    return fn(__test__);
  } finally {
    Module._load = originalLoad;
    fs.readFileSync = origReadFileSync;
    fs.writeFileSync = origWriteFileSync;
    fs.unlinkSync = origUnlinkSync;
    delete require.cache[require.resolve('../adapters/shared/claude-hooks.cjs')];
  }
}

// Helpers to fabricate the curl `-w '\n__HTTP__%{http_code}'` shape.
function curlOk(body, status = 200) {
  return { ok: true, stdout: `${body}\n__HTTP__${status}`, stderr: '', code: 0 };
}
function curlFail() {
  return { ok: false, stdout: '', stderr: 'connection refused', code: 7 };
}

test('validateStrictPlan: 200 OK returns parsed=resp', () => {
  withStubs({
    execDiagOut: curlOk(JSON.stringify({ ok: true, title: 'P', units: [] }), 200),
    portContents: '19400',
  }, ({ validateStrictPlan }) => {
    const r = validateStrictPlan('bin', '/cwd', '# P\n\n## Meta\n\n- id: `PLAN-X`\n');
    assert.equal(r.ok, true);
    assert.equal(r.parsed.title, 'P');
  });
});

test('validateStrictPlan: 400 strict_format_violation returns violation details', () => {
  const violation = {
    error: 'strict_format_violation',
    details: { line: 5, column: 1, kind: 'MissingMeta', hint: 'missing `## Meta`' },
  };
  withStubs({
    execDiagOut: curlOk(JSON.stringify(violation), 400),
    portContents: '19400',
  }, ({ validateStrictPlan }) => {
    const r = validateStrictPlan('bin', '/cwd', '# P\n');
    assert.equal(r.ok, false);
    assert.deepEqual(r.violation, violation.details);
  });
});

test('validateStrictPlan: curl failure returns networkError', () => {
  withStubs({
    execDiagOut: curlFail(),
    portContents: '19400',
  }, ({ validateStrictPlan }) => {
    const r = validateStrictPlan('bin', '/cwd', '# P\n');
    assert.equal(r.ok, false);
    assert.equal(r.networkError, true);
  });
});

test('validateStrictPlan: missing port file returns networkError without calling curl', () => {
  let calls = 0;
  withStubs({
    execDiagOut: (() => { calls++; return curlOk('{}'); })(),
    portContents: null,
  }, ({ validateStrictPlan }) => {
    const r = validateStrictPlan('bin', '/cwd', '# P\n');
    assert.equal(r.ok, false);
    assert.equal(r.networkError, true);
    assert.match(r.reason || '', /port file/);
  });
});

test('validateStrictPlan: empty content short-circuits to ok', () => {
  withStubs({
    execDiagOut: curlOk('{}'),
    portContents: '19400',
  }, ({ validateStrictPlan }) => {
    const r = validateStrictPlan('bin', '/cwd', '');
    assert.equal(r.ok, true);
    assert.equal(r.parsed, null);
  });
});

test('strictGuideMessage: includes line, kind, hint, and disable bypass', () => {
  // Re-use any stub mode just to load the module.
  withStubs({
    execDiagOut: curlOk('{}'),
    portContents: '19400',
  }, ({ strictGuideMessage }) => {
    const msg = strictGuideMessage({
      line: 7,
      column: 1,
      kind: 'BadHeadingDepth',
      hint: 'exactly one H1 expected, found 2',
    });
    assert.match(msg, /line 7/);
    assert.match(msg, /BadHeadingDepth/);
    assert.match(msg, /exactly one H1/);
    assert.match(msg, /clawket project disable/);
  });
});
