# WHOOP profile weight correction — 2026-09-24

## Result

Pass for the server change and local authenticated live MCP path. The behavior commits are `467bb549ed09cbd70b6abd4b7718b9cdff445555` and `36feeed581f3f5c832b0dfec3ecb6a8a65f44b68` on `main`. The public `/health` route returned HTTP 200; unauthenticated `/mcp` returned HTTP 401, as expected from the existing OAuth proxy. No OAuth proxy configuration or connector registration was changed.

## Summary

`get_today` now identifies weight as WHOOP's manually entered profile value, retains the existing `- **Weight**: <n> lbs` prefix, shows the first observed date in America/New_York, and flags a value unchanged for more than 30 days. The WHOOP API provides no date when the user entered this value. A successful fetch records the exact kilograms value in an additive `weight_observations` SQLite table; repeated identical fetches preserve `first_observed_at`. A changed value creates a new observation. Failed or invalid fetches produce an unavailable line and a stderr log entry. Empty catches in `src` were replaced with logging. Token exchange and refresh failures now report HTTP status without logging WHOOP response bodies. No tool names or schemas, sync behavior, resource URL, OAuth configuration, or date logic for other tools changed.

## Evidence

- `npm run typecheck`: pass.
- `npm run build`: pass.
- `npm test` (compiled `dist/index.js` launched as a child process with the same Node runtime and user permissions as systemd, a temporary SQLite DB, and mocked WHOOP HTTP responses): 1 test, 1 pass, 0 fail, 0 skip. Cases cover the labelled line, repeat fetch, persisted observation after restart, more than 30 days, changed weight, HTTP 503, invalid weight, stderr logging, encrypted token loading, stale-session HTTP 404, token-exchange failure logging, and initial-sync failure logging.
- Empty-catch scan of `src`: 0 matches. `git diff --check`: pass.
- Production `/data/whoop.db`: one weight observation; `first_observed_at=2026-09-25T00:13:46.342Z`, which is Sep 24, 2026 in America/New_York. Live systemd MCP `get_today` returned `- **Weight**: 144.8 lbs (WHOOP profile weight, manually entered; observed since Sep 24, 2026)` both before and after another restart.
- Production `/health` reported `authenticated=true` before and after restart. A previous session received HTTP 404 and a new session completed `get_today` with HTTP 200 after restart. The server reads encrypted WHOOP tokens from SQLite at startup and again for data-tool calls. Public `https://whoop.nealshankar.com/health` returned HTTP 200; unauthenticated public `/mcp` returned HTTP 401.
- Relevant files: `src/database.ts`, `src/index.ts`, `src/whoop-client.ts`, `test/mock-whoop.mjs`, `test/weight.integration.test.mjs`, `package.json`, and `README.md`. This report is under `docs/archive/WEIGHT-2026-09-24/`. The repository has no changelog or existing report directory.

## Approaches tried

The weight implementation and production launch path passed its checks. An added OAuth callback test then failed: a rejected token exchange logged only `Error`, because the client threw the WHOOP response body without an HTTP status and the safe logger deliberately omitted that body. The client now throws the HTTP status for exchange and refresh failures. The expanded test and full suite passed after this change.

## Decisions made without owner input

- The deployed working tree and `origin/main` initially matched exactly, so no preservation commit was necessary.
- The observed date uses America/New_York to avoid a UTC date shift for an evening observation. The stored timestamp remains UTC.
- The table keeps each change as an observation and updates the last-seen timestamp for identical values, preserving the current value's first-seen timestamp across process restarts.
- Existing MCP session behavior remains HTTP 404 for unknown IDs; this prompts client re-initialization without changing OAuth registrations or connector URLs.
- The public OAuth proxy was left untouched, so the authenticated live tool check used the running systemd service on localhost. The public health route and OAuth guard were checked separately.

## Blockers

None for deployment. An authenticated call through the public OAuth proxy was not performed because this run did not access or change the shared OAuth server, registrations, or tokens.

## Open items

- WHOOP does not expose when the profile weight was entered. The observed-since date starts with the server's first successful fetch, not the WHOOP entry date.
- Review the configured GitHub credential: the preexisting credential-bearing remote URL was emitted by an initial `git remote -v` command. The credential value is intentionally omitted here. Rotate it and update the existing push mechanism after this run.

## Most unsure about

- Whether existing clients recover from an HTTP 404 without user action in every Claude and ChatGPT version; the server response and new-session path passed, but external clients were not driven in this run.
- Whether WHOOP can return the same weight after an account change; observations are keyed to the current server database, not a WHOOP account ID.

## The board, 12-year-old version

The server used to show a weight as though WHOOP had just measured it, even though someone typed that number into WHOOP. It now says where the number came from and when this server first saw it. If WHOOP cannot provide the number, the server says so and records the problem. The number and its date survived a restart, and a stale connection was told to start a fresh session. The owner can keep using the existing connector and should rotate the GitHub credential noted above.
