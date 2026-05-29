#!/usr/bin/env node
'use strict';

// Validate package.json#compat AND components.json pin consistency: the two
// pinning surfaces that release.yml reads at the COMPATIBILITY.md row-generation
// step (.github/workflows/release.yml). Failing here aborts the release before
// any tag / commit / publish happens.
//
// Invariants enforced:
//   1. compat is an object.
//   2. Every key is in the fixed whitelist (@clawket/{cli,daemon,web,desktop}).
//   3. Every key in the whitelist is present (no silent drops).
//   4. Every value is a SemVer-range expression built from comparator clauses
//      (>= / > / <= / < / = optional) joined by spaces ("AND") and/or " || " ("OR").
//      Each clause is a SemVer triple (X.Y.Z, no pre-release / build metadata
//      since clawket compat ranges never use them).
//   5. For every non-null pin in components.json, the pinned version satisfies
//      the corresponding compat range. `desktop: null` sentinel skips check.
//
// Zero runtime deps — keeps the plugin shell `dependencies: {}` invariant
// (CLAUDE.md Stack & 진입점). Uses only Node built-ins + a tiny embedded
// SemVer comparator (cmp + satisfies) for invariant #5.

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

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)$/;
const COMP_RE = /^\s*(>=|<=|>|<|=)?\s*(\d+\.\d+\.\d+)\s*$/;

function parseVersion(s) {
  const m = VERSION_RE.exec(String(s).trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function cmpVer(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

function satisfiesClause(version, clause) {
  const parts = clause.trim().split(/\s+/);
  for (const part of parts) {
    const m = COMP_RE.exec(part);
    if (!m) return false;
    const op = m[1] || '=';
    const target = parseVersion(m[2]);
    if (!target) return false;
    const c = cmpVer(version, target);
    if (op === '>=' && !(c >= 0)) return false;
    if (op === '>' && !(c > 0)) return false;
    if (op === '<=' && !(c <= 0)) return false;
    if (op === '<' && !(c < 0)) return false;
    if (op === '=' && c !== 0) return false;
  }
  return true;
}

function satisfies(versionStr, range) {
  const version = parseVersion(versionStr);
  if (!version) return false;
  const clauses = range.trim().split(/\s*\|\|\s*/);
  return clauses.some((c) => satisfiesClause(version, c));
}

function validate(pkg, components) {
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

  if (components !== undefined && components !== null) {
    if (typeof components !== 'object' || Array.isArray(components)) {
      errors.push('components.json must be a plain object');
      return errors;
    }
    for (const key of ALLOWED_KEYS) {
      const shortKey = key.replace(/^@clawket\//, '');
      if (!(shortKey in components)) {
        errors.push(`components.json is missing key: ${shortKey}`);
        continue;
      }
      const pin = components[shortKey];
      if (pin === null) continue;
      if (typeof pin !== 'string') {
        errors.push(`components.json[${JSON.stringify(shortKey)}] must be a string or null, got ${typeof pin}`);
        continue;
      }
      if (!parseVersion(pin)) {
        errors.push(
          `components.json[${JSON.stringify(shortKey)}] = ${JSON.stringify(pin)} is not a SemVer triple ` +
            `(expected like "v1.2.3" or "1.2.3")`
        );
        continue;
      }
      const range = compat[key];
      if (typeof range !== 'string' || !RANGE_RE.test(range.trim())) continue;
      if (!satisfies(pin, range)) {
        errors.push(
          `components.json[${JSON.stringify(shortKey)}] = ${JSON.stringify(pin)} does not satisfy ` +
            `package.json#compat[${JSON.stringify(key)}] = ${JSON.stringify(range)} ` +
            `(pin/range drift — bump compat range or revert pin)`
        );
      }
    }
  }

  return errors;
}

function main() {
  const pkgPath = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.resolve(__dirname, '..', 'package.json');
  const componentsPath = process.argv[3]
    ? path.resolve(process.argv[3])
    : path.resolve(path.dirname(pkgPath), 'components.json');

  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
  } catch (err) {
    process.stderr.write(`validate-compat: cannot read ${pkgPath}: ${err.message}\n`);
    process.exit(2);
  }

  let components;
  try {
    components = JSON.parse(fs.readFileSync(componentsPath, 'utf-8'));
  } catch (err) {
    if (err.code === 'ENOENT') {
      process.stderr.write(
        `validate-compat: components.json not found at ${componentsPath} — skipping pin/range consistency check\n`
      );
    } else {
      process.stderr.write(`validate-compat: cannot read ${componentsPath}: ${err.message}\n`);
      process.exit(2);
    }
  }

  const errors = validate(pkg, components);
  if (errors.length > 0) {
    process.stderr.write(`validate-compat: ${errors.length} error(s) in ${pkgPath}\n`);
    for (const e of errors) process.stderr.write(`  - ${e}\n`);
    process.exit(1);
  }
  process.stdout.write(`validate-compat: ok (${pkgPath}${components ? ' + ' + componentsPath : ''})\n`);
}

if (require.main === module) {
  main();
}

module.exports = { validate, ALLOWED_KEYS, satisfies };
