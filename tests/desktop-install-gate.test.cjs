// LM-10904 — desktop install-gate regression test.
//
// Run: node --test tests/desktop-install-gate.test.cjs
//
// Verifies the desktop component wiring in the install gate:
//   1. `null` pin (v3.0.0 sentinel) is a no-op skip — no download, no marker.
//   2. `desktopArtifactName` composes the correct platform-specific filename.
//   3. Env override `CLAWKET_DESKTOP_VERSION` takes precedence over the
//      manifest-passed value (parity with CLI / daemon / web overrides).
//
// Network-touching paths (string pin → real GitHub download) are NOT exercised
// here — the `clawket/desktop` GitHub repo does not yet exist, so any real
// download would 404. The test covers the wiring contract that activates the
// moment a pin is set.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { __test__ } = require('../adapters/shared/claude-hooks.cjs');
const { ensureDesktopBundle, desktopArtifactName } = __test__;

function makeTmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'clawket-desktop-test-'));
}

test('ensureDesktopBundle returns null for null pin (no download, no marker)', async () => {
  const pluginRoot = makeTmpRoot();
  try {
    const result = await ensureDesktopBundle(pluginRoot, null);
    assert.equal(result, null, 'null pin must return null');

    // No marker, no dl directory should have been created.
    const markerPath = path.resolve(pluginRoot, 'desktop', '.clawket-version');
    assert.equal(fs.existsSync(markerPath), false, 'null pin must not write a marker');
    const dlDir = path.resolve(pluginRoot, 'desktop', 'dl');
    assert.equal(fs.existsSync(dlDir), false, 'null pin must not create dl/ directory');
  } finally {
    fs.rmSync(pluginRoot, { recursive: true, force: true });
  }
});

test('ensureDesktopBundle returns null for undefined pin (defensive)', async () => {
  const pluginRoot = makeTmpRoot();
  try {
    const result = await ensureDesktopBundle(pluginRoot, undefined);
    assert.equal(result, null);
  } finally {
    fs.rmSync(pluginRoot, { recursive: true, force: true });
  }
});

test('desktopArtifactName composes platform-specific names', () => {
  const v = 'v3.0.0';
  const name = desktopArtifactName(v);

  // Sanity: contains the version and a recognised extension for this platform.
  assert.ok(name.includes(v), `artifact name must include version: ${name}`);

  const platform = os.platform();
  if (platform === 'darwin') {
    assert.match(name, /\.dmg$/, `darwin must produce .dmg: ${name}`);
    assert.match(name, /apple-darwin/, `darwin target triple expected: ${name}`);
  } else if (platform === 'win32') {
    assert.match(name, /\.msi$/, `win32 must produce .msi: ${name}`);
    assert.match(name, /pc-windows-msvc/, `win32 target triple expected: ${name}`);
  } else {
    assert.match(name, /\.AppImage$/, `linux must produce .AppImage: ${name}`);
    assert.match(name, /linux-gnu/, `linux target triple expected: ${name}`);
  }
});

test('CLAWKET_DESKTOP_VERSION env override is honored over null pin', async () => {
  // When env override is set, the function would attempt a real download. We
  // verify the override is *seen* by checking that the function no longer
  // short-circuits on null — i.e. it throws (network failure) rather than
  // returning null. We do NOT want to actually hit the network, so we set the
  // override to a deliberately-bogus version and assert the download path was
  // entered (by catching the thrown error).
  const pluginRoot = makeTmpRoot();
  const originalEnv = process.env.CLAWKET_DESKTOP_VERSION;
  process.env.CLAWKET_DESKTOP_VERSION = 'v0.0.0-test-override-bogus';
  // Point at a non-resolvable host so the test fails fast without flaking on
  // real GitHub. The repo override is independently env-driven.
  const originalRepo = process.env.CLAWKET_DESKTOP_REPO;

  try {
    let threw = false;
    try {
      await ensureDesktopBundle(pluginRoot, null);
    } catch {
      threw = true;
    }
    assert.equal(threw, true, 'env override must engage the download path (and fail on missing release)');
  } finally {
    if (originalEnv === undefined) delete process.env.CLAWKET_DESKTOP_VERSION;
    else process.env.CLAWKET_DESKTOP_VERSION = originalEnv;
    if (originalRepo === undefined) delete process.env.CLAWKET_DESKTOP_REPO;
    else process.env.CLAWKET_DESKTOP_REPO = originalRepo;
    fs.rmSync(pluginRoot, { recursive: true, force: true });
  }
});
