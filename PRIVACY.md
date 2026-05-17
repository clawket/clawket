# Privacy Policy

**Clawket** is a fully local Claude Code plugin. This document describes how Clawket handles your data.

## Data Collection

Clawket does **not** collect, transmit, or share any data with external servers. There is no telemetry, analytics, or cloud communication of any kind.

## Data Storage

All data is stored locally on your machine:

- **Database**: `~/.local/share/clawket/db.sqlite` (or `$CLAWKET_DATA_DIR`)
- **Cache**: `~/.cache/clawket/` (or `$CLAWKET_CACHE_DIR`)
- **Configuration**: `~/.config/clawket/` (or `$CLAWKET_CONFIG_DIR`)
- **Logs**: `~/.local/state/clawket/` (or `$CLAWKET_STATE_DIR`)

Paths follow the [XDG Base Directory Specification](https://specifications.freedesktop.org/basedir-spec/latest/) and can be overridden via environment variables.

## Network Access

The Clawket daemon (`clawketd`) listens only on:

- `localhost:19400` — HTTP server for the web dashboard
- Unix domain socket — CLI-to-daemon communication

No outbound network requests are made.

## Embedding Model

When knowledge search is used, Clawket runs a local embedding model (`paraphrase-multilingual-MiniLM-L12-v2` via `candle-core`) entirely on your machine. No data is sent to any external API.

## Third-Party Services

Clawket does not integrate with or send data to any third-party services.

## Data Deletion

To remove all Clawket data, delete the following directories:

```bash
rm -rf ~/.local/share/clawket
rm -rf ~/.cache/clawket
rm -rf ~/.config/clawket
rm -rf ~/.local/state/clawket
```

## Contact

For privacy-related questions, open an issue at [github.com/clawket/clawket](https://github.com/clawket/clawket/issues).

---

*Last updated: 2026-05-14*
