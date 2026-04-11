#!/usr/bin/env node
// Detached server process — spawned by `latticed start`.
// Also usable directly: `node bin/_serve.js` for foreground debugging.
import { startServer } from '../src/server.js';
startServer();
