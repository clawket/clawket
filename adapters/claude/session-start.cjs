#!/usr/bin/env node
require('../shared/claude-hooks.cjs').runSessionStart().catch((err) => {
  process.stderr.write(`[clawket] SessionStart failed: ${err.message}\n`);
  process.exit(0);
});
