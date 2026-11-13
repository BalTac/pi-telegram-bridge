# Changelog

All notable changes to this fork of `@bytesbrains/pi-telegram-bridge`. The fork starts from upstream
1.4.1, whose history is not available (the original repository is unreachable).

## 1.4.1-baltac.5 — delivery while the agent works, for real

- `sendUserMessage()` is `void` in pi 1.5.x and reports the busy state as a runtime error that cannot
  be caught. The bridge now registers `ctx.isIdle()` at session start and sends with `deliverAs` up
  front, instead of retrying after a failure that never reaches the caller.
- `setIdleProbe()` in `src/forward.ts`; probe failures are treated as idle.
- 4 new tests (busy, steer, idle, probe throwing).

## 1.4.1-baltac.4 — command menu published to Telegram

- `setMyCommands` on session start, built from the real command table: Telegram autocompletes the
  commands the bridge implements, not a stale menu inherited from another binding (`PI_TELEGRAM_SYNC_MENU=0`
  disables it).
- `/commands` accepted as an alias of `/help`.

## 1.4.1-baltac.3 — `/deliver`

- `/deliver` shows the active delivery mode; `/deliver steer` and `/deliver followUp` change it live,
  no restart.
- With `PI_TELEGRAM_ENV_FILE` set, the choice is written back to the env file and survives a reload.
- `/status` shows the active mode.

## 1.4.1-baltac.2 — queue messages during a run

- A Telegram message arriving while the agent is busy is no longer rejected with
  `Agent is already processing`: it is queued as `followUp` (default) or `steer`
  (`PI_TELEGRAM_DELIVER_AS`).
- Applied to text, photos, voice notes and slash commands.

## 1.4.1-baltac.1 — voice notes and pluggable STT

- Voice notes downloaded and transcribed before reaching the agent.
- `src/stt.ts`: provider chain with three stages — `http` (any OpenAI-compatible
  `/v1/audio/transcriptions` endpoint: whisper.cpp server, faster-whisper-server, whisper-asr-webservice,
  LocalAI, OpenAI, Groq, Mistral, DeepInfra, together.ai, Fireworks), `cmd` (any CLI, `{file}`
  placeholder), `agent` (path only, agent uses MCP or its own tool).
- Configurable origin prefix (`PI_TELEGRAM_ORIGIN_PREFIX`, default `[telegram]`).
- `telegram_send` uses Telegram Markdown parse.
- Tests: voice routing added, poll signature updated, suite green.

## 1.4.1 — upstream baseline

Polling listener, photo download, five tools, slash commands, offset persistence. Rebuilt from the
published npm tarball.
