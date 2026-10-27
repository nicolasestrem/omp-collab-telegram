# omp-collab-telegram

Send your [omp](https://omp.sh) session's Collab link to Telegram on startup, so you can join and control it from your phone.

## What it does

When an interactive session starts, the extension:

1. Finds the session's own Collab host.
2. Mints its join link at the access level the host publishes (`control` when `collab.autoStart: control`).
3. Sends the link to a Telegram chat via your bot.

Print-mode runs (`omp -p`) and subagents are skipped. Failures never block the session, and queued work for a session that has ended or changed is cancelled rather than left pointing at rooms that no longer exist.

## Install

1. Copy `telegram-collab-link.ts` into your extensions folder:

   `~/.omp/agent/extensions/telegram-collab-link.ts`

2. Create `~/.omp/agent/telegram-collab.env` (see `telegram-collab.env.example`):

   ```
   OMP_TELEGRAM_BOT_TOKEN=123456789:AA...
   OMP_TELEGRAM_CHAT_ID=123456789
   ```

   Save it as plain UTF-8 `KEY=VALUE` lines without quotes and without an `export ` prefix — quoted values break the request, and quoted/BOM'd files fail to parse.

3. (Optional, recommended) Set `collab.autoStart: control` in `~/.omp/agent/config.yml` so every interactive session hosts itself. Without it, Collab never hosts your session and no link can be sent.

## Configuration

| Key | Description |
| --- | --- |
| `OMP_TELEGRAM_BOT_TOKEN` | Bot token from [@BotFather](https://t.me/BotFather) |
| `OMP_TELEGRAM_CHAT_ID` | Chat to notify — get yours from [@userinfobot](https://t.me/userinfobot) |

Optional environment overrides for where the env file is looked up:

| Variable | Effect |
| --- | --- |
| `PI_CODING_AGENT_DIR` | Credentials are read from `<this dir>/telegram-collab.env`; profiles export this automatically on activation |
| `PI_CONFIG_DIR` | Custom config root name; the fallback path becomes `~/$PI_CONFIG_DIR/agent/telegram-collab.env` instead of `~/.omp/agent/telegram-collab.env` |

## How it works

- Subscribes to `session_start`, filters to TUI + main agent, and returns immediately — startup is never blocked.
- Delivers at most once per session per process: delivered and in-flight guards ignore replayed `session_start` events and concurrent claims.
- Polls `omp collab list --json` for its own host (matching pid + session id) within a 180-second wall-clock budget, covering slow Collab starts and Collab's relaunch backoff. Individual CLI calls time out at 10 s, so the budget is not inflated by slow calls, and no new poll step starts once the budget expires — a step already in flight may finish a few seconds later.
- Mints the link with `omp collab link`, labels it from the link command's own response (`view-only` for view access, otherwise `control`), then sends a single Telegram message.
- A send is retried only for an explicit Telegram `429` rejection — the one case where Telegram confirms nothing was delivered — at most 3 attempts, honoring Telegram's `retry_after` delay capped at 5 s. Network errors, send timeouts, and every other HTTP status (including 5xx) are never retried, because delivery may already have occurred and a duplicate control link is worse than a missing one.
- Pending deliveries are cancelled when the session ends or changes (`session_switch` for new/resume/fork, `session_branch` for branch/fork, and `session_shutdown`): Collab stops and withdraws the old room, so a late link would only point at a dead room. Cancellations are debug-log only.

## Known limitations

- `session_start` fires once per process startup. After an in-process `/new`, `/resume`, `/fork`, or branch, the replacement session hosts a new Collab room, but no new link is sent for it. This gap predates the current fixes and is preserved by design rather than silently narrowed; stale runs for the old room are cancelled.
- Delivery state is per-process: resuming a session in a new process can send for that session id again.
- A Telegram `retry_after` above 5 s is capped, so a retry may hit the rate limit again; after 3 attempts the send is abandoned for that session.

## Troubleshooting

Logs are written to the omp session logs (`~/.omp/logs/omp.<date>.<pid>.log`); filter for `telegram-collab-link`. Entries deliberately contain no bot token, no join URL, no chat id (only its last four digits on success), and no raw exception text or stack traces — only error names, exit codes, elapsed times, and bounded structured fields.

The delivery-failure toast and its paired warn name the cause class directly:

| Log `cause` | Meaning | What to check |
| --- | --- | --- |
| `rate limited (429); retries exhausted` | Telegram throttled the send despite the bounded retries | Wait and retry from a fresh session; Telegram's `retry_after` above 5 s is capped |
| `telegram HTTP 401` | Token rejected | Rotated or revoked bot token, or quoting/extra characters in `telegram-collab.env` |
| `telegram HTTP 400` | Chat rejected | `OMP_TELEGRAM_CHAT_ID` is wrong, or you never started a chat with the bot |
| `telegram HTTP 403` | Bot blocked | The bot is not a member of the chat, or was blocked |
| `telegram HTTP 404` | Token path invalid | Malformed token in the env file |
| `telegram HTTP <other>` | Telegram-side error — not retried on purpose | Check your chat for the message before resending anything |
| `send timed out` | No response within the 10 s send window — not retried | Ambiguous: delivery may have occurred, check the chat first |
| `network error (<ErrorName>)` | The request failed before/around the response (DNS, TLS, proxy, blocked egress) — not retried | Usually transient; check whether general egress works, then check the chat first |

If no link is ever sent, the `no deliveryable collab link` warn reports what the poll actually saw, so you can pin the stage: `listSucceeded` shows whether `omp collab list` works at all (failing means an omp installation/CLI problem), `listedHosts`/`pidMatches` show whether Collab ever hosted this session (never listed points at `collab.autoStart` being off), and `mintNote` carries the bounded CLI error when a host was found but link minting kept being refused.

To recover a link by hand, list the hosts and mint one yourself (the instance id is a random registry key, not a credential):

```
omp collab list --json
omp collab link <instanceId> --json
```

### Observed failure motivating these fixes

Two real classes, from this installation's session logs; both were undiagnosable before the changes because delivery failures logged only `{status, ok, code}` without a cause name, elapsed time, or Telegram's description:

- **2026-10-27 — a transient connect failure lost a link.** A session's send failed about 6 s after process start with `{"status":"network","ok":false,"code":null}`, while the same log shows healthy egress to other services seconds earlier and the identical credentials file delivered successfully from a different session 28 s later. That is an immediate socket/DNS/TLS error on the very first connect — nothing had reached Telegram, but the blanket no-retry policy plus a log line with no error name, elapsed time, or timeout/exception distinction left nothing to act on. The retry policy for this class is unchanged by design (delivery may already have occurred); what changed is that the log now separates `network error (<ErrorName>)` from `send timed out`, reports elapsed time and attempt counts, and distinguishes poll-stage failures from send-stage ones.
- **2026-10-24 — token rejections counted without a cause.** Three sessions ended with `{"status":401,...}` and no description field logged, so the log could not distinguish a rotated/revoked token from a value mangled by quoting in the env file. The log now labels this as `telegram HTTP 401` with structured fields, and the table above covers the two likely causes to check.

## Security

- Credentials live only in the local env file — never in code or git.
- Control links grant full session control; only send them to your own chat.
- Logs never include the bot token, the join URL, the chat id (only its last four digits), or raw error messages and stack traces — diagnostic output is limited to names, codes, and bounded, secret-free fields.

## License

[MIT](LICENSE)
