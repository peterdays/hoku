# Overseer

Hoku's overseer is the first thing on screen. It answers "what needs me right now" across Grok Bots, Cursor cloud agents, GitHub, and a future Hermes Agent bot. The session galaxy is still there, one rail button away.

## Why it lives in this app

The constellation, the local-only window, and the Linux and macOS shell already exist. A second app would split the place Pedro opens. The overseer is a new read-only layer beside the session index. It does not write `hub.sqlite`, and it does not touch `~/.claude`, `~/.codex`, or Claude Desktop.

Network calls are new, and they are off while **Demo data** is on (the default). Turning demo data off is the opt-in. Each source can also be switched off on its own. Tokens are not committed. They are stored in `overseer.json` inside Hoku's data folder (mode `0600`) or read from the environment: `CURSOR_API_KEY`, `GITHUB_TOKEN` or `GH_TOKEN`, `HERMES_API_KEY` or `API_SERVER_KEY`. The webview is never given the token back. The content security policy is unchanged: the webview does not call these hosts. Rust does, and only the hosts in the allowlist (`api.cursor.com`, `api.github.com`, and `http://127.0.0.1` / `http://localhost`).

## Data model

A **front** is one thing happening on one project:

| Field | Meaning |
|---|---|
| `project` | The star system it orbits |
| `kind` | `grok-bot`, `cloud-agent`, `github-pr`, `github-issue`, `hermes` |
| `state` | `needs-you`, `working`, `blocked`, `done`, `idle` |
| `reason` | Why it needs you, or a short status line |
| `updatedAt` | When the source last moved |
| `url` | The jump link. Empty when the source did not give one Hoku will open |
| `detail` | At most 160 characters. Never a transcript |

Needs-you is ranked with the longest wait first. Other states are newest first. Hoku does not invent a needs-you the source did not signal.

The map keeps the constellation reading: a project is a star, fronts orbit it (bots inside, then cloud agents, Hermes, pull requests, issues), and the halo is the state. Amber is only needs-you.

## Adapters

| Source | Live | Fixture | When it is missing |
|---|---|---|---|
| Cursor cloud agents | `GET https://api.cursor.com/v1/agents` and the latest run (`/v1/agents/{id}/runs/{runId}`), Basic or Bearer, key from settings or `CURSOR_API_KEY`. Run status `CREATING`/`RUNNING` is working, `FINISHED` is done, `ERROR` is blocked, `CANCELLED`/`EXPIRED` is idle. Cursor does not report a waiting-on-you state, so a cloud agent is never needs-you from this API alone. | Demo fronts | "No Cursor API key" or the HTTP error. No invented agents |
| GitHub | Five search calls for open PRs where you are asked to review, where you were asked for changes, where checks fail, PRs you authored, and issues assigned to you. Token from settings or `GITHUB_TOKEN` | Demo fronts | "No GitHub token" or the HTTP error |
| Hermes | `GET http://127.0.0.1:9119/api/status` and `/api/sessions`. If the session list is unauthorized and an API key is set, `GET http://127.0.0.1:8642/api/sessions`. Needs-you only when a session says `waiting_for_approval`, `waiting_for_clarify`, `pending_approval`, or `pending_clarify`. Hoku does not call the approval or clarify endpoints | Demo fronts, including one clarification so the inbox is visible | "Hermes is not running", or a sentence that the dashboard wants a login Hoku will not perform |
| Grok bots | No public list API was found. The adapter reads a local JSON or JSONL feed and nothing else | Invented feed entries, labelled demo | "The Grok feed file is not there yet." No invented bots |

Existing coding-CLI boards (Omnara, PeckBoard, Builderz Mission Control, agent-deck, Conductor, Devin Command Center) watch terminals and tasks. None of them treat a persistent bot as a first-class node. That is the gap this view is for.

## Grok feed

Default path: `grok-bots.jsonl` in Hoku's data folder (`~/Library/Application Support/com.hoku.app/` on macOS, `$XDG_DATA_HOME/com.hoku.app/` on Linux). Settings can point at another absolute path. Hoku only reads the file.

A file is either a JSON array or one JSON object per line. Bad lines are skipped and counted.

```json
{"id":"release-notes","name":"Release notes","project":"Northwind","state":"needs-you","reason":"Which version should ship?","updatedAt":"2026-10-15T18:00:00Z","url":"https://grok.com/chat/demo-release-notes","detail":"Waiting on a version choice"}
```

`id` matches `[A-Za-z0-9][A-Za-z0-9_-]{0,127}`. `state` is one of `needs-you`, `working`, `blocked`, `done`, `idle`. `needs-you` requires `reason`. `url`, when present, must start with `https://grok.com/` or the jump link is dropped. `detail` is clipped to 160 characters and `name` to 64.

A bot or a small routine writes this file. Hoku does not write it.
