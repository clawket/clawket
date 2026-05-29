#!/usr/bin/env node
'use strict';

// Validate package.json#compat: the internal pinning surface that release.yml
// reads at the COMPATIBILITY.md row-generation step (.github/workflows/release.yml).
// Failing here aborts the release before any tag / commit / publish happens.
//
// Invariants enforced:
//   1. compat is an object.
//   2. Every key is in the fixed whitelist (@clawket/{cli,daemon,web,desktop}).
//   3. Every key in the whitelist is present (no silent drops).
//   4. Every value is a SemVer-range expression built from comparator clauses
//      (>= / > / <= / < / = optional) joined by spaces ("AND") and/or " || " ("OR").
//      Each clause is a SemVer triple (X.Y.Z, no pre-release / build metadata
//      since clawket compat ranges never use them).
//
// Zero runtime deps — keeps the plugin shell `dependencies: {}` invariant
// (CLAUDE.md Stack & 진입점). Uses only Node built-ins.

const fs = require('fs');
const path = require('path');

const ALLOWED_KEYS = Object.freeze([
  '@clawket/cli',
  '@clawket/daemon',
  '@clawket/web',
  '@clawket/desktop',
]);

const VERSION = '\\d+\\.\\d+\\.\\d+';
const COMPARATOR = `(?:>=|<=|>|<|=)?\\s*${VERSION}`;
const CLAUSE = `${COMPARATOR}(?:\\s+${COMPARATOR})*`;
const RANGE_RE = new RegExp(`^${CLAUSE}(?:\\s*\\|\\|\\s*${CLAUSE})*$`);

function validate(pkg) {
  const errors = [];
  const compat = pkg.compat;
  if (compat === undefined || compat === null) {
    errors.push('package.json#compat is missing');
    return errors;
  }
  if (typeof compat !== 'object' || Array.isArray(compat)) {
    errors.push('package.json#compat must be a plain object');
    return errors;
  }

  const keys = Object.keys(compat);
  const allowed = new Set(ALLOWED_KEYS);
  for (const key of keys) {
    if (!allowed.has(key)) {
      errors.push(`unknown compat key: ${JSON.stringify(key)} (allowed: ${ALLOWED_KEYS.join(', ')})`);
    }
  }
  for (const required of ALLOWED_KEYS) {
    if (!(required in compat)) {
      errors.push(`missing compat key: ${required}`);
    }
  }

  for (const [key, value] of Object.entries(compat)) {
    if (!allowed.has(key)) continue;
    if (typeof value !== 'string') {
      errors.push(`compat[${JSON.stringify(key)}] must be a string, got ${typeof value}`);
      continue;
    }
    if (value.trim() === '') {
      errors.push(`compat[${JSON.stringify(key)}] is empty`);
      continue;
    }
    if (!RANGE_RE.test(value.trim())) {
      errors.push(
        `compat[${JSON.stringify(key)}] = ${JSON.stringify(value)} is not a valid SemVer range ` +
          `(expected comparators like ">=0.2.0 <1.0.0", saw "${value}")`
      );
    }
  }

  return errors;
}

function main() {
  const pkgPath = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.resolve(__dirname, '..', 'package.json');

  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
  } catch (err) {
    process.stderr.write(`validate-compat: cannot read ${pkgPath}: ${err.message}\n`);
    process.exit(2);
  }

  const errors = validate(pkg);
  if (errors.length > 0) {
    process.stderr.write(`validate-compat: ${errors.length} error(s) in ${pkgPath}\n`);
    for (const e of errors) process.stderr.write(`  - ${e}\n`);
    process.exit(1);
  }
  process.stdout.write(`validate-compat: ok (${pkgPath})\n`);
}

if (require.main === module) {
  main();
}

module.exports = { validate, ALLOWED_KEYS };
