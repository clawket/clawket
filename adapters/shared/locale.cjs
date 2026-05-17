'use strict';
// locale.cjs — Clawket locale runtime (FIX-PLUGIN-011 + HOOK-081/152)
//
// Resolution chain (first match wins):
//   1. CLAWKET_LOCALE env var (e.g. "ko", "en", "ja")
//   2. LC_ALL env var — strip territory suffix: "ko_KR.UTF-8" → "ko"
//   3. LANG env var — same stripping
//   4. Fallback: "en"
//
// Supported locales: en | ko | ja.
// Unknown locales fall back to "en" with a single stderr warning so users
// notice when the env var is mistyped (instead of silently getting English).
//
// HOOK-081/152 — locale fallback chain. Per-locale fallback order is:
//   ja → ko → en      (Japanese readers prefer Korean over English when ja
//                      catalog has gaps — typographically/semantically closer)
//   ko → en
//   en → en
// `localeChain(locale)` returns the ordered list. `t()` walks it.

const path = require('path');
const fs = require('fs');

const SUPPORTED = ['en', 'ko', 'ja'];
const LOCALE_DIR = path.resolve(__dirname, '..', '..', 'locales');

/** @type {Record<string, Record<string, string>>} */
const _cache = {};

// Track locales we've already warned about so a single hook process does not
// emit duplicate warnings for the same misconfiguration.
const _unsupportedWarned = new Set();

/**
 * Resolve the active locale from the environment.
 * @returns {'en' | 'ko' | 'ja'}
 */
function resolveLocale() {
  const candidates = [
    { source: 'CLAWKET_LOCALE', value: process.env.CLAWKET_LOCALE },
    { source: 'LC_ALL', value: langToLocale(process.env.LC_ALL) },
    { source: 'LANG', value: langToLocale(process.env.LANG) },
  ];
  for (const candidate of candidates) {
    if (!candidate.value) continue;
    if (SUPPORTED.includes(candidate.value)) return candidate.value;
    // Unsupported locale set explicitly — warn once and continue down the chain.
    const key = `${candidate.source}:${candidate.value}`;
    if (!_unsupportedWarned.has(key)) {
      _unsupportedWarned.add(key);
      try {
        process.stderr.write(
          `[clawket][i18n] unsupported locale '${candidate.value}' from ${candidate.source} — falling back to en\n`
        );
      } catch {}
    }
  }
  return 'en';
}

/**
 * Strip territory and encoding suffix from LC_ALL/LANG values.
 * "ko_KR.UTF-8" → "ko", "en_US" → "en", "ja" → "ja"
 * @param {string | undefined} raw
 * @returns {string | null}
 */
function langToLocale(raw) {
  if (!raw) return null;
  return raw.split(/[_\.]/)[0].toLowerCase() || null;
}

/**
 * Load the message catalog for a locale (cached).
 * @param {string} locale
 * @returns {Record<string, string>}
 */
function loadCatalog(locale) {
  if (_cache[locale]) return _cache[locale];
  const file = path.resolve(LOCALE_DIR, `${locale}.json`);
  try {
    _cache[locale] = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    // Missing or malformed catalog — return empty object; t() will return key.
    _cache[locale] = {};
  }
  return _cache[locale];
}

/**
 * Return the ordered fallback chain for a locale. The chain always ends with
 * "en" so callers are guaranteed to find any key present in the canonical
 * catalog. HOOK-081/152: ja → ko → en (not ja → en) so missing Japanese keys
 * surface Korean rather than English when available.
 * @param {string} locale
 * @returns {string[]}
 */
function localeChain(locale) {
  if (locale === 'ja') return ['ja', 'ko', 'en'];
  if (locale === 'ko') return ['ko', 'en'];
  return ['en'];
}

/**
 * Look up a message key by walking the locale fallback chain. The chain ends
 * with "en"; if the key is missing from every catalog the function returns
 * the key itself so callers always get a non-empty string. CLAWKET_DEBUG=1
 * surfaces a single fallback-chain diagnostic per miss.
 * @param {string} key
 * @param {string} [locale]
 * @returns {string}
 */
function t(key, locale) {
  const active = locale || resolveLocale();
  const chain = localeChain(active);
  for (const step of chain) {
    const catalog = loadCatalog(step);
    if (catalog[key] !== undefined) {
      if (step !== active && process.env.CLAWKET_DEBUG === '1') {
        try {
          process.stderr.write(`[clawket][i18n.fallback] key=${key} locale=${active} chain=${chain.join('→')} -> ${step}\n`);
        } catch {}
      }
      return catalog[key];
    }
  }
  return key;
}

/**
 * Verify that a locale catalog has all keys present in `en`. Emits a stderr
 * warning listing missing keys (debug-mode only) so we can spot ja.json gaps
 * without crashing user sessions. No-op when CLAWKET_DEBUG !== '1'.
 * @param {string} locale
 */
function checkCatalogCompleteness(locale) {
  if (process.env.CLAWKET_DEBUG !== '1') return;
  if (!SUPPORTED.includes(locale)) return;
  const en = loadCatalog('en');
  const target = loadCatalog(locale);
  const missing = Object.keys(en).filter((k) => target[k] === undefined);
  if (missing.length > 0) {
    try {
      process.stderr.write(
        `[clawket][i18n] catalog '${locale}' missing ${missing.length} key(s): ${missing.join(', ')}\n`
      );
    } catch {}
  }
}

// Runtime ja.json fallback completeness check (LOCALE-CHAIN-V3): when the
// process boots in CLAWKET_DEBUG=1 we surface ja.json gaps so locale drift
// is visible during development without affecting end-user sessions.
if (process.env.CLAWKET_DEBUG === '1') {
  try {
    checkCatalogCompleteness('ja');
    checkCatalogCompleteness('ko');
  } catch {}
}

module.exports = { resolveLocale, t, SUPPORTED, checkCatalogCompleteness, localeChain };
