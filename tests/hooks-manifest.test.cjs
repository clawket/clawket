// Plugin hooks/hooks.json manifest regression test.
//
// Run: node --test tests/hooks-manifest.test.cjs
//
// Guards against LM-11014-class mistakes where a Tool name (e.g. ExitPlanMode,
// Edit, Write, Bash) lands at the top-level event-key position. Claude Code
// will silently accept any string there and the hook never fires, so the
// configuration parses fine but the routing is semantically broken.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const MANIFEST_PATH = path.resolve(PLUGIN_ROOT, 'hooks', 'hooks.json');

const EVENT_WHITELIST = new Set([
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'SubagentStart',
  'SubagentStop',
  'Stop',
]);

function loadManifest() {
  const raw = fs.readFileSync(MANIFEST_PATH, 'utf-8');
  return JSON.parse(raw);
}

function validateManifest(manifest) {
  assert.ok(
    manifest && typeof manifest === 'object',
    'manifest must be an object',
  );
  assert.ok(
    manifest.hooks && typeof manifest.hooks === 'object',
    'manifest.hooks must be an object',
  );

  for (const eventKey of Object.keys(manifest.hooks)) {
    assert.ok(
      EVENT_WHITELIST.has(eventKey),
      `manifest.hooks.${eventKey} is not a Claude Code hook event. ` +
        `Expected one of: ${[...EVENT_WHITELIST].join(', ')}. ` +
        `A Tool name (e.g. ExitPlanMode, Edit, Bash) at this position is ` +
        `the LM-11014-class mistake.`,
    );

    const entries = manifest.hooks[eventKey];
    assert.ok(
      Array.isArray(entries),
      `manifest.hooks.${eventKey} must be an array`,
    );
    assert.ok(
      entries.length > 0,
      `manifest.hooks.${eventKey} must have at least one entry`,
    );

    entries.forEach((entry, i) => {
      const ctx = `manifest.hooks.${eventKey}[${i}]`;

      assert.equal(
        typeof entry.matcher,
        'string',
        `${ctx}.matcher must be a string`,
      );

      assert.ok(
        Array.isArray(entry.hooks),
        `${ctx}.hooks must be an array`,
      );
      assert.ok(
        entry.hooks.length > 0,
        `${ctx}.hooks must have at least one handler`,
      );

      entry.hooks.forEach((h, j) => {
        const hctx = `${ctx}.hooks[${j}]`;
        assert.equal(
          h.type,
          'command',
          `${hctx}.type must be 'command'`,
        );
        assert.equal(
          typeof h.command,
          'string',
          `${hctx}.command must be a string`,
        );
        assert.ok(
          h.command.trim().length > 0,
          `${hctx}.command must be non-empty`,
        );
      });
    });
  }
}

test('hooks/hooks.json parses as valid JSON', () => {
  assert.doesNotThrow(loadManifest);
});

test('every top-level event key is in the 7-event Claude Code whitelist', () => {
  const manifest = loadManifest();
  validateManifest(manifest);
});

test('manifest mutation: ExitPlanMode as top-level event key fails validation', () => {
  const manifest = loadManifest();
  const mutated = JSON.parse(JSON.stringify(manifest));
  mutated.hooks.ExitPlanMode = mutated.hooks.PostToolUse;

  assert.throws(
    () => validateManifest(mutated),
    /ExitPlanMode is not a Claude Code hook event/,
    'ExitPlanMode at event-key position must trip the validator',
  );
});

test('manifest mutation: Tool name Edit as top-level event key fails validation', () => {
  const manifest = loadManifest();
  const mutated = JSON.parse(JSON.stringify(manifest));
  mutated.hooks.Edit = mutated.hooks.PostToolUse;

  assert.throws(
    () => validateManifest(mutated),
    /Edit is not a Claude Code hook event/,
  );
});

test('manifest mutation: missing command string fails validation', () => {
  const manifest = loadManifest();
  const mutated = JSON.parse(JSON.stringify(manifest));
  mutated.hooks.PreToolUse[0].hooks[0].command = '';

  assert.throws(
    () => validateManifest(mutated),
    /must be non-empty/,
  );
});

test('manifest mutation: handler with non-command type fails validation', () => {
  const manifest = loadManifest();
  const mutated = JSON.parse(JSON.stringify(manifest));
  mutated.hooks.PreToolUse[0].hooks[0].type = 'script';

  assert.throws(
    () => validateManifest(mutated),
    /type must be 'command'/,
  );
});
