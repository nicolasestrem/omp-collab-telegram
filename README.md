# omp-collab-telegram

Send your [omp](https://omp.sh) session's Collab link to Telegram on startup, so you can join and control it from your phone.

## What it does

When an interactive session starts, the extension:

1. Finds the session's own Collab host.
2. Mints its join link at the access level the host publishes (`control` when `collab.autoStart: control`).
3. Sends the link to a Telegram chat via your bot.

Print-mode runs (`omp -p`) and subagents are skipped. Failures never block the session.

## Install

1. Copy `telegram-collab-link.ts` into your extensions folder:

   `~/.omp/agent/extensions/telegram-collab-link.ts`

2. Create `~/.omp/agent/telegram-collab.env` (see `telegram-collab.env.example`):

   ```
   OMP_TELEGRAM_BOT_TOKEN=123456789:AA...
   OMP_TELEGRAM_CHAT_ID=123456789
   ```

3. (Optional, recommended) Set `collab.autoStart: control` in `~/.omp/agent/config.yml` so every interactive session hosts itself.

## Configuration

| Key | Description |
| --- | --- |
| `OMP_TELEGRAM_BOT_TOKEN` | Bot token from [@BotFather](https://t.me/BotFather) |
| `OMP_TELEGRAM_CHAT_ID` | Chat to notify — get yours from [@userinfobot](https://t.me/userinfobot) |

## How it works

- Subscribes to `session_start`, filters to TUI + main agent, and returns immediately — startup is never blocked.
- Polls `omp collab list --json` for its own host (matching pid + session id) for up to ~3 minutes, covering slow Collab starts.
- Mints the link with `omp collab link`, then sends a single Telegram message. Ambiguous delivery failures are not retried, to avoid duplicates.

## Security

- Credentials live only in the local env file — never in code or git.
- Control links grant full session control; only send them to your own chat.
- Logs never include the bot token or the full join URL.

## License

[MIT](LICENSE)
