# v0 progress

**Rule:** re-read this file just before you edit it, then change only your own step's row and add your lines to the log. Never edit another step's row. Statuses are `not started`, `in progress`, `blocked: <why>`, `review` (built and waiting for Rishi) and `done`. Use the date you change the row, as YYYY-MM-DD.

A step can start once every step it depends on is `done`, or `review` if Rishi has said so.

| Step | Spec | Status | Owner thread | Depends on | Date | Notes |
|---|---|---|---|---|---|---|
| 1 | [Freeze the spec](specs/step-01-freeze-spec.md) | not started | | none | | waiting for Rishi's answers to the open decisions |
| 2 | [Skeleton, link, CI, binary](specs/step-02-skeleton-link.md) | not started | | 1 | | |
| 3 | [Contract and call formats](specs/step-03-contract.md) | not started | | 2 | | |
| 4 | [Worker, tools, permissions](specs/step-04-worker-tools-permissions.md) | not started | | 3 | | |
| 5 | [Model gateway](specs/step-05-gateway.md) | not started | | 2 | | can run alongside 3 and 4 |
| 6 | [Loop, events, run log, `rlmh run`](specs/step-06-loop-runlog-cli.md) | not started | | 4, 5 | | |
| 7 | [Interactive view](specs/step-07-interactive-view.md) | not started | | 6 | | can run alongside 8 |
| 8 | [Parity with training](specs/step-08-parity.md) | not started | | 6 | | script lives in the RLM repo; can run alongside 7 |
| 9 | [Smoke run](specs/step-09-smoke-run.md) | not started | | 7, 8 | | spends Rishi's own API keys; needs 9a and his go-ahead |
| 10 | [One-command install](specs/step-10-install.md) | not started | | 9 | | |

## Log

Newest at the bottom. One line each: `YYYY-MM-DD step N (thread): what happened`. Record here any change you had to make to [architecture.md](architecture.md) or [decisions.md](decisions.md).

- 2026-10-28 docs: documentation/v0 created (README, architecture, decisions, progress, ten specs). Nothing built yet.
- 2026-10-29 docs: all ten specs reviewed against architecture.md. architecture.md gained the names the specs needed (Engine, error constructors, SCHEMA, paths, protocol.ts types, Session.keys/catalog, call.delta reset, LOCAL_PRESETS, catalog layout, RECORD_KEYS, host_traceback, setup and .installed.json). D-42 to D-51 added; D-01, D-14, D-16 and D-33 amended.
