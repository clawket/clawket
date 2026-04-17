# Claude Adapter

Claude integration is implemented as a thin adapter layer over shared Clawket runtime helpers.

- `.claude-plugin/` remains the Claude plugin manifest surface
- `hooks/hooks.json` remains the Claude hook routing surface
- `scripts/*.cjs` are compatibility shims
- `adapters/claude/*.cjs` are the Claude adapter entrypoints
- `adapters/shared/*.cjs` contain shared runtime logic used by Claude now and future adapters later
