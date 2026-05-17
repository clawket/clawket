// US-CKT-PROMOTE-044 — plugin skills regression test.
//
// Run: node --test tests/skills-integrity.test.cjs
//
// Verifies the 6 PDD skills + clawket skill are present, well-formed, and that
// each RULE.md carries the STABLE label (post v3.0 promotion). This guards
// against a partial release that drops the skills/ tree or reverts a header.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const SKILLS_DIR = path.resolve(PLUGIN_ROOT, 'skills');

const PDD_SKILLS = ['pdd', 'scenario-author', 'qa-batch', 'discover-loop', 'scenario-refine', 'qa-fix'];
const ALL_SKILLS = ['clawket', ...PDD_SKILLS];

test('skills/ directory contains the expected 7 skills', () => {
  for (const s of ALL_SKILLS) {
    assert.ok(fs.existsSync(path.join(SKILLS_DIR, s)), `missing skill dir: ${s}`);
  }
});

test('every PDD skill has both SKILL.md and RULE.md', () => {
  for (const s of PDD_SKILLS) {
    for (const f of ['SKILL.md', 'RULE.md']) {
      const p = path.join(SKILLS_DIR, s, f);
      assert.ok(fs.existsSync(p), `missing ${s}/${f}`);
      const stat = fs.statSync(p);
      assert.ok(stat.size > 100, `${s}/${f} suspiciously small (${stat.size} bytes)`);
    }
  }
});

test('every PDD RULE.md is labelled STABLE — Clawket plugin 정본', () => {
  for (const s of PDD_SKILLS) {
    const body = fs.readFileSync(path.join(SKILLS_DIR, s, 'RULE.md'), 'utf-8');
    assert.match(
      body,
      /상태:\s*STABLE\s*—\s*Clawket plugin 정본/,
      `${s}/RULE.md is missing the STABLE label (must show "상태: STABLE — Clawket plugin 정본")`,
    );
    assert.doesNotMatch(
      body,
      /상태:\s*EXPERIMENTAL/,
      `${s}/RULE.md still has EXPERIMENTAL label`,
    );
  }
});

test('no RULE.md cross-links into ~/.claude/rules or ~/.claude/skills', () => {
  for (const s of PDD_SKILLS) {
    const body = fs.readFileSync(path.join(SKILLS_DIR, s, 'RULE.md'), 'utf-8');
    assert.doesNotMatch(
      body,
      /~\/\.claude\/(rules|skills)\//,
      `${s}/RULE.md references the legacy ~/.claude/{rules,skills}/ path`,
    );
  }
});

test('plugin.json skillsList declares all 7 skills with path + description', () => {
  const manifest = JSON.parse(fs.readFileSync(path.resolve(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf-8'));
  assert.equal(manifest.skillsList.length, ALL_SKILLS.length, 'skillsList must list 7 skills');
  for (const entry of manifest.skillsList) {
    assert.ok(typeof entry === 'object', `skillsList entry must be an object: ${JSON.stringify(entry)}`);
    assert.ok(entry.name, 'each entry needs a name');
    assert.ok(entry.path && /^skills\/[^/]+\/SKILL\.md$/.test(entry.path), `entry path malformed: ${entry.path}`);
    assert.ok(entry.description && entry.description.length > 20, `entry description too short for ${entry.name}`);
  }
});

test('plugin.json commands array exposes the 7 PDD slash commands', () => {
  const manifest = JSON.parse(fs.readFileSync(path.resolve(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf-8'));
  assert.ok(Array.isArray(manifest.commands), 'commands must be an array');
  const names = manifest.commands.map((c) => c.name);
  for (const expected of ['/pdd-plan', '/scenario-author', '/qa-batch', '/discover-loop', '/scenario-refine', '/qa-fix', '/pdd-promote']) {
    assert.ok(names.includes(expected), `commands missing ${expected}`);
  }
});

test('marketplace.json skills array exposes name + description per skill', () => {
  const market = JSON.parse(fs.readFileSync(path.resolve(PLUGIN_ROOT, '.claude-plugin', 'marketplace.json'), 'utf-8'));
  const skills = market.plugins[0].skills;
  assert.equal(skills.length, ALL_SKILLS.length);
  for (const entry of skills) {
    assert.ok(entry.name && entry.description, `marketplace skill entry malformed: ${JSON.stringify(entry)}`);
  }
});
