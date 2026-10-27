# Changelog

All notable changes to this project are documented here.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased — 2026-10-27

Reliability and diagnostics fixes for Telegram delivery of the Collab join
link, motivated by two observed failure classes in real session logs — a
transient connect-time send failure on 2026-10-27 whose only clue was an
undiagnosable `{"status":"network","ok":false,"code":null}` line, and three
token-rejection `401` delivery failures on 2026-10-24 that logged no cause —
plus lifecycle defects found during a dedicated review (stale polls outliving
the session, a 30 s dedupe window that could replay a control link, and a
"time after 180s" message whose true worst case was measured in tens of
minutes).

### Fixed

- Duplicate delivery hardening: a session delivered once stays delivered for the life of the process, and a `session_start` replay or concurrent claim is ignored. Previously delivery was blocked only inside a 30 s window, after which a replayed `session_start` (e.g. a late extension re-bind) could send a second control link.
- Stale-pending cancellation: pending deliveries are cancelled synchronously on session transitions (`session_switch` for new/resume/fork, `session_branch` for branch/fork) and on `session_shutdown`, aborting the child `omp` processes and the pending HTTP send. Previously a queued run could spawn `omp` CLI processes for many minutes after its room was withdrawn and toast a failure into a session that no longer exists.
- Accurate deadline: host polling is bounded by a 180 s wall-clock budget regardless of how long individual `omp` calls take, with no new poll step started after the deadline (a step already in flight may finish a few seconds later), and the poll-exhaustion warn reports actual elapsed time and structured facts about what it observed. Previously the attempt-count budget let a degraded CLI stretch the same stage to ~33 minutes while the message claimed "after 180s".
- Accurate access labeling: the join message names the access level returned by the link command's own response (`view-only` for view access, otherwise `control`) instead of always claiming "control". The response access now also wins over the registry snapshot.
- Profile/config root support: the credentials file is resolved from `PI_CODING_AGENT_DIR` when set (exported automatically under profiles) with a fallback of `~/$PI_CONFIG_DIR/agent` instead of a hardcoded `~/.omp/agent`.
- Diagnostic visibility: CLI failures are logged with the subcommand, exit code, killed flag, and a bounded first stderr line; send failures log the cause class, HTTP status, Telegram error code, elapsed time, and attempt count; poll exhaustion logs whether the list call succeeded, how many hosts were seen, whether the matching host was found, and the bounded minting error, if any. Cancellation events are debug-level only and produce no notification.

### Changed

- Bounded, safe retry policy: only an explicit Telegram `429` rejection is retried, because it is the one case where Telegram confirms nothing was delivered. Up to 3 attempts total, honoring `parameters.retry_after` with the wait capped at 5 s. Network errors, send timeouts, and every other HTTP status (including 5xx) are deliberately never retried, since delivery may already have occurred and a duplicate control link is worse than a missing one.
- Actionable failure notices: the delivery-failure toast names the cause (`rate limited (429); retries exhausted`, `telegram HTTP <code>`, `send timed out`, or `network error (<ErrorName>)`) instead of pointing at a cause-free log entry.
- Secret hygiene extended to all new diagnostics: no token, join URL, chat id (only its last four digits on success), or raw exception text ever reaches logs — only error names, structured fields, and a bounded stderr line (CLI stderr carries no URL or token content).

### Known behavior (unchanged, now documented)

- `session_start` fires once per process startup. After an in-process `/new`, `/resume`, `/fork`, or branch, the replacement session hosts a new Collab room but no new link is sent; stale runs for prior rooms are cancelled instead of warning at timeout. This gap predates these fixes and is preserved rather than silently narrowed.
- Delivery state is per-process: resuming a session in a new process can send for that session id again.
- A `retry_after` above 5 s is capped, so a retry may hit the rate limit again; after 3 attempts the send is abandoned for that session.
