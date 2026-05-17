// Locks in the canonical asset naming contract used by GitHub Releases for
// clawket/cli and clawket/daemon since v3.0:
//   <bin>-<version>-<canonical-target>.tar.gz
//   where canonical-target ∈ {darwin-arm64, darwin-x64, linux-arm64, linux-x64}
//
// Pre-v3.0 the install gate used Rust target triples (aarch64-apple-darwin,
// x86_64-unknown-linux-gnu, ...) which no longer exist in v3.0+ release
// assets. A regression here means every fresh install 404s on download.

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const { __test__ } = require('../adapters/shared/claude-hooks.cjs');
const { detectCliTarget, parseSha256Sums } = __test__;

test('detectCliTarget returns canonical short names (no Rust target triples)', () => {
  const target = detectCliTarget();
  assert.match(
    target,
    /^(darwin|linux)-(arm64|x64)$/,
    `target must be canonical short name; got: ${target}`
  );
  assert.doesNotMatch(target, /apple-darwin|unknown-linux|pc-windows-msvc/,
    `target must not use Rust triple: ${target}`);
});

test('detectCliTarget matches current host', () => {
  const target = detectCliTarget();
  const platform = os.platform();
  const arch = os.arch();
  const expectedPlatform = platform === 'darwin' ? 'darwin' : 'linux';
  const expectedArch = arch === 'arm64' ? 'arm64' : 'x64';
  assert.equal(target, `${expectedPlatform}-${expectedArch}`);
});

test('parseSha256Sums extracts hash by basename match', () => {
  const content = [
    '718c23924ec12593571e5b62c4edbd6d13367b8abfc27264e218247e9a70d40e  clawket-web-v3.0.0.tar.gz',
    'd966e5edbf07cda1aeae5dff7fea0e60556b4443ccd16c6d2fd0f321d3027863  clawket-v3.0.1-darwin-arm64.tar.gz',
  ].join('\n');

  const webHash = parseSha256Sums(content, 'clawket-web-v3.0.0.tar.gz');
  assert.equal(webHash, '718c23924ec12593571e5b62c4edbd6d13367b8abfc27264e218247e9a70d40e');

  const cliHash = parseSha256Sums(content, '/tmp/somewhere/clawket-v3.0.1-darwin-arm64.tar.gz');
  assert.equal(cliHash, 'd966e5edbf07cda1aeae5dff7fea0e60556b4443ccd16c6d2fd0f321d3027863');

  assert.equal(parseSha256Sums(content, 'nonexistent.tar.gz'), null);
  assert.equal(parseSha256Sums(null, 'anything.tar.gz'), null);
});
