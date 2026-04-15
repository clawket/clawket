#!/usr/bin/env node
// Detached server process — spawned by `clawketd start`.
// Also usable directly: `node bin/_serve.js` for foreground debugging.
import { startServer } from '../src/server.js';
startServer();
