# WHOOP weight label and credential follow-up — 2026-09-24

## Result

Pass. The corrected behavior is in `whoop-mcp.service` and in commit `fcef42d4a23d95240b31147a5740679d86348883` on `main`. The remote URL is credential-free; a repository-local Git credential helper reads `/root/.github-token` only when Git requests authentication. An isolated push with global and system Git configuration disabled succeeded through that helper. No OAuth, proxy, other MCP server, connector registration, or token was changed.

## Summary

The `get_today` line retains `- **Weight**: <n> lbs` and now says `(WHOOP profile weight, synced from Apple Health; can lag the scale by about a day; observed since <date>)`. When the same value has been observed for more than 30 days, it adds `unchanged for N days; check the Apple Health to WHOOP sync`. `N` is the whole number of elapsed 24-hour days. The observed-since database value and failure behavior are unchanged. The README describes the FITINDEX scale to Apple Health to WHOOP path and the possible lag. The older `WEIGHT-2026-09-24` report is retained as historical evidence; its manual-entry claim and rotation recommendation are superseded by this follow-up and the owner's ruling.

## Evidence

- `npm run typecheck`, `npm run build`, and `npm test` passed: 1 integration test, 1 pass, 0 failures, 0 skips. The test launches compiled `dist/index.js` with the production Node runtime and user permissions, and now asserts the full label, unchanged-value warning with the day count, persistence after restart, changed value, failure logs, and session recovery.
- `rg` found 0 manual-entry claims in `src`, `README.md`, and `test`; `git diff --check` passed.
- Running `git remote -v` after the change displayed 2 credential-free URLs. The isolated credential-helper check matched its password to `/root/.github-token` without displaying the value. The isolated `git push origin main` succeeded.
- Exact-token scan after the tests: 0 matches in 18 WHOOP working-tree files, 0 in all 170 Git objects (including unreachable objects and commit metadata), 0 in 2 `docs/archive` files, and 0 in `.git/config`. No token value was printed. The original embedded remote credential matched the existing token file before removal.
- Read-only remote audit under `/opt`, excluding `/opt/NSH-LABS` and this repository: `NSH-LABS-CLXII` — no embedded credential; `dreaming-mcp-server` — no embedded credential; `telegram-mcp-server` — embedded credential. Three other repositories were audited; none was modified.
- Live systemd `get_today` returned `- **Weight**: 144.8 lbs (WHOOP profile weight, synced from Apple Health; can lag the scale by about a day; observed since Sep 24, 2026)` both before and after a restart. The observed-since date stayed the same, `/health` reported WHOOP authentication, the old session received HTTP 404, and a new session succeeded. The public health URL returned HTTP 200. The owner's real Claude call through public OAuth had already proven authenticated routing and automatic session re-initialization; this run did not alter that path.
- Relevant paths: `src/index.ts`, `README.md`, `test/weight.integration.test.mjs`, this report, and the repository-local `.git/config` remote and helper entries. The token file was read, not changed.

## Approaches tried

The direct label change and repository-local credential helper both passed their first objective checks. No fallback was needed.

## Decisions made without owner input

- Used the existing token file through a Git credential helper scoped to this repository's GitHub URL. This removes the credential from `git remote -v` while allowing ordinary pushes without writing the token into `.git/config`.
- Left the prior archive report intact as historical evidence and wrote the correction here.
- Kept the current value's observed-since timestamp and the existing 30-day threshold. The warning counts whole elapsed days from that timestamp.
- Did not rotate the token, following the owner's ruling. Did not modify the other repositories found in the read-only audit.

## Blockers

None.

## Open items

- `telegram-mcp-server` has a credential-bearing remote. It was outside this repository's modification scope; a separate authorized task can remove that credential from its remote.
- An unchanged weight can mean either a sync problem or genuinely stable weight. The warning asks for a sync check rather than claiming the sync failed.

## Most unsure about

- Whether WHOOP will always continue receiving scale updates from Apple Health within roughly one day; the owner supplied the observed typical lag.
- Whether a long run of exactly equal values should keep the same first-observed date even when the sync is healthy; the current persistence rule intentionally does so.

## The board, 12-year-old version

The server had said the weight was typed in by hand, but it actually comes from a scale through a health app. It now explains that path and warns when the same number has stayed there for a long time. The date still survives a restart, and the existing connector can reconnect by itself. The code repository no longer stores the secret in its address, while pushes still work. One other repository has the same kind of secret in its address and was left alone for a separate task.
