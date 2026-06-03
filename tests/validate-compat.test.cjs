'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validate, ALLOWED_KEYS, satisfies } = require('../scripts/validate-compat.cjs');

const goodCompat = {
  '@clawket/cli': '>=0.2.0 <1.0.0',
  '@clawket/daemon': '>=0.2.0 <1.0.0',
  '@clawket/web': '>=0.1.0 <2.0.0',
  '@clawket/desktop': '>=3.0.0 <4.0.0',
};

const goodComponents = {
  daemon: 'v0.3.5',
  cli: 'v0.5.1',
  web: 'v1.0.3',
  desktop: null,
};

test('allowed keys whitelist matches manifest', () => {
  assert.deepEqual(
    [...ALLOWED_KEYS].sort(),
    ['@clawket/cli', '@clawket/daemon', '@clawket/desktop', '@clawket/web']
  );
});

test('accepts the canonical compat object', () => {
  assert.deepEqual(validate(goodCompat), []);
});

test('rejects missing compat', () => {
  const errs = validate(undefined);
  assert.equal(errs.length, 1);
  assert.match(errs[0], /compat\.json is missing or empty/);
});

test('rejects non-object compat', () => {
  assert.equal(validate('string').length, 1);
  assert.equal(validate(['array']).length, 1);
  assert.equal(validate(null).length, 1);
});

test('rejects unknown key', () => {
  const compat = { ...goodCompat, '@clawket/typo': '>=0.1.0' };
  const errs = validate(compat);
  assert.ok(errs.some((e) => /unknown compat key/.test(e)));
});

test('rejects missing required key', () => {
  const { '@clawket/desktop': _drop, ...partial } = goodCompat;
  const errs = validate(partial);
  assert.ok(errs.some((e) => /missing compat key: @clawket\/desktop/.test(e)));
});

test('rejects non-string range', () => {
  const errs = validate({ ...goodCompat, '@clawket/cli': 123 });
  assert.ok(errs.some((e) => /must be a string/.test(e)));
});

test('rejects empty range', () => {
  const errs = validate({ ...goodCompat, '@clawket/cli': '   ' });
  assert.ok(errs.some((e) => /is empty/.test(e)));
});

test('rejects garbage range', () => {
  for (const bad of ['bogus', '~1.0.0', '^1.0.0', '>=1', '>=1.0', 'latest', '1.0.0-beta']) {
    const errs = validate({ ...goodCompat, '@clawket/cli': bad });
    assert.ok(
      errs.some((e) => /not a valid SemVer range/.test(e)),
      `expected ${JSON.stringify(bad)} to be rejected`
    );
  }
});

test('accepts valid range shapes used in the project', () => {
  for (const ok of [
    '>=0.2.0 <1.0.0',
    '>=3.0.0 <4.0.0',
    '>=0.1.0',
    '<2.0.0',
    '>=1.0.0 <2.0.0 || >=3.0.0 <4.0.0',
    '=1.2.3',
    '1.2.3',
  ]) {
    const errs = validate({ ...goodCompat, '@clawket/cli': ok });
    assert.deepEqual(
      errs,
      [],
      `expected ${JSON.stringify(ok)} to be accepted (got ${JSON.stringify(errs)})`
    );
  }
});

test('satisfies: comparator semantics', () => {
  assert.equal(satisfies('v0.5.1', '>=0.2.0 <1.0.0'), true);
  assert.equal(satisfies('0.5.1', '>=0.2.0 <1.0.0'), true);
  assert.equal(satisfies('v1.0.0', '>=0.2.0 <1.0.0'), false);
  assert.equal(satisfies('v0.1.9', '>=0.2.0 <1.0.0'), false);
  assert.equal(satisfies('v0.2.0', '>=0.2.0 <1.0.0'), true);
  assert.equal(satisfies('v1.2.3', '=1.2.3'), true);
  assert.equal(satisfies('v1.2.4', '=1.2.3'), false);
  assert.equal(satisfies('v3.5.0', '>=1.0.0 <2.0.0 || >=3.0.0 <4.0.0'), true);
  assert.equal(satisfies('v2.5.0', '>=1.0.0 <2.0.0 || >=3.0.0 <4.0.0'), false);
});

test('accepts canonical components + compat together', () => {
  assert.deepEqual(validate(goodCompat, goodComponents), []);
});

test('rejects pin out of range', () => {
  const errs = validate(goodCompat, { ...goodComponents, cli: 'v1.0.0' });
  assert.ok(
    errs.some((e) => /does not satisfy/.test(e) && /cli/.test(e)),
    `expected drift error, got: ${JSON.stringify(errs)}`
  );
});

test('rejects pin below lower bound', () => {
  const errs = validate(goodCompat, { ...goodComponents, daemon: 'v0.1.0' });
  assert.ok(errs.some((e) => /does not satisfy/.test(e) && /daemon/.test(e)));
});

test('null desktop pin is skipped (sentinel)', () => {
  assert.deepEqual(validate(goodCompat, goodComponents), []);
  assert.deepEqual(
    validate(goodCompat, { ...goodComponents, desktop: null }),
    []
  );
});

test('rejects garbage pin format', () => {
  const errs = validate(goodCompat, { ...goodComponents, web: 'latest' });
  assert.ok(errs.some((e) => /not a SemVer triple/.test(e)));
});

test('rejects non-string pin', () => {
  const errs = validate(goodCompat, { ...goodComponents, cli: 123 });
  assert.ok(errs.some((e) => /must be a string or null/.test(e)));
});

test('rejects missing components key', () => {
  const { web: _drop, ...partial } = goodComponents;
  const errs = validate(goodCompat, partial);
  assert.ok(errs.some((e) => /components.json is missing key: web/.test(e)));
});

test('rejects non-object components', () => {
  assert.ok(
    validate(goodCompat, 'string').some((e) => /must be a plain object/.test(e))
  );
  assert.ok(
    validate(goodCompat, ['arr']).some((e) => /must be a plain object/.test(e))
  );
});

test('skips consistency check when components is undefined', () => {
  assert.deepEqual(validate(goodCompat), []);
  assert.deepEqual(validate(goodCompat, undefined), []);
  assert.deepEqual(validate(goodCompat, null), []);
});
