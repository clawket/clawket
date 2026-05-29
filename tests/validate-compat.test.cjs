'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validate, ALLOWED_KEYS } = require('../scripts/validate-compat.cjs');

const goodCompat = {
  '@clawket/cli': '>=0.2.0 <1.0.0',
  '@clawket/daemon': '>=0.2.0 <1.0.0',
  '@clawket/web': '>=0.1.0 <2.0.0',
  '@clawket/desktop': '>=3.0.0 <4.0.0',
};

test('allowed keys whitelist matches manifest', () => {
  assert.deepEqual(
    [...ALLOWED_KEYS].sort(),
    ['@clawket/cli', '@clawket/daemon', '@clawket/desktop', '@clawket/web']
  );
});

test('accepts the canonical compat object', () => {
  assert.deepEqual(validate({ compat: goodCompat }), []);
});

test('rejects missing compat', () => {
  const errs = validate({});
  assert.equal(errs.length, 1);
  assert.match(errs[0], /missing/);
});

test('rejects non-object compat', () => {
  assert.equal(validate({ compat: 'string' }).length, 1);
  assert.equal(validate({ compat: ['array'] }).length, 1);
  assert.equal(validate({ compat: null }).length, 1);
});

test('rejects unknown key', () => {
  const compat = { ...goodCompat, '@clawket/typo': '>=0.1.0' };
  const errs = validate({ compat });
  assert.ok(errs.some((e) => /unknown compat key/.test(e)));
});

test('rejects missing required key', () => {
  const { '@clawket/desktop': _drop, ...partial } = goodCompat;
  const errs = validate({ compat: partial });
  assert.ok(errs.some((e) => /missing compat key: @clawket\/desktop/.test(e)));
});

test('rejects non-string range', () => {
  const errs = validate({ compat: { ...goodCompat, '@clawket/cli': 123 } });
  assert.ok(errs.some((e) => /must be a string/.test(e)));
});

test('rejects empty range', () => {
  const errs = validate({ compat: { ...goodCompat, '@clawket/cli': '   ' } });
  assert.ok(errs.some((e) => /is empty/.test(e)));
});

test('rejects garbage range', () => {
  for (const bad of ['bogus', '~1.0.0', '^1.0.0', '>=1', '>=1.0', 'latest', '1.0.0-beta']) {
    const errs = validate({ compat: { ...goodCompat, '@clawket/cli': bad } });
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
    const errs = validate({ compat: { ...goodCompat, '@clawket/cli': ok } });
    assert.deepEqual(
      errs,
      [],
      `expected ${JSON.stringify(ok)} to be accepted (got ${JSON.stringify(errs)})`
    );
  }
});
