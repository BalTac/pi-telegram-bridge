# pi-telegram-bridge

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](package.json)
[![tests](https://img.shields.io/badge/tests-139%20passing-brightgreen.svg)](#development)
[![pi extension](https://img.shields.io/badge/pi-extension-8b5cf6.svg)](https://github.com/earendil-works/pi)

**Telegram bridge for the [pi coding agent](https://github.com/earendil-works/pi): forward messages from
your phone to the agent, and send voice notes that get transcribed before the agent reads them.**

Send a text, a photo or a **voice message** from Telegram; the bridge downloads it, transcribes it with
a local Whisper model, a cloud API or the agent's own MCP tools, and hands the result to the agent as a
user message. Replies go back to the chat, with Markdown. Five tools let the agent listen, send, ask a
blocking question with buttons, request approval, and report status.

Fork of `@bytesbrains/pi-telegram-bridge` 1.4.1, rebuilt from the published npm tarball (the original
repository is no longer reachable) and maintained here.

**Keywords:** pi coding agent · telegram bot bridge · telegram bot for AI agents · voice notes to text ·
speech-to-text for Telegram · Whisper STT · faster-whisper · whisper.cpp · OpenAI-compatible
transcription · Groq · Mistral Voxtral · MCP tools · TypeScript · Node.js · agent automation ·
remote control of a coding agent from a phone · BYOK speech recognition.

![pi-telegram-bridge](docs/banner.png)

## Contents

- [What it does](#what-it-does)
- [Why people use it](#why-people-use-it)
- [Differences from the original 1.4.1](#differences-from-the-original-141)
- [Install](#install)
- [Configuration](#configuration)
- [Voice notes: three ways to get a transcript](#voice-notes-three-ways-to-get-a-transcript)
- [When the agent is already busy](#when-the-agent-is-already-busy)
- [Slash-command menu](#slash-command-menu)
- [Commands](#commands)
- [Tools exposed to the agent](#tools-exposed-to-the-agent)
- [Skills](#skills)
- [How it works](#how-it-works)
- [FAQ](#faq)
- [Development](#development)
- [License](#license)

## What it does

- **Phone → agent.** Long-polling listener on the Bot API, no webhook, no public address, works behind
  NAT. Messages arrive as user messages, tagged with an origin prefix the agent can read.
- **Voice notes → text.** OGG/Opus voice messages are downloaded and transcribed before the agent sees
  them, with a provider chain you configure: any OpenAI-compatible endpoint, any local CLI, or the
  agent's own tools (MCP).
- **Agent → phone.** `telegram_send` with Markdown, `telegram_ask` that blocks on a human answer with
  inline buttons, `telegram_notify` for structured notifications, `telegram_override` for approvals.
- **Never loses a message.** If the agent is mid-run, the message is queued as `followUp` (default) or
  injected as `steer` instead of failing.
- **Survives restarts.** The Telegram update offset is persisted in the session, so nothing is
  replayed or dropped.

## Why people use it

You are running the pi coding agent on a laptop or a server, and you want to check on it from the
phone: "what did the tests say", "commit that", "here, listen to what I want". Text is slow on a phone
keyboard, and voice is how people actually talk. This bridge makes the phone a first-class remote
control for an agent that keeps working on the machine.

It is not a chatbot framework and it is not a Telegram bot SDK: it is the 400 lines that connect one
agent session to one chat.

## Differences from the original 1.4.1

| | original 1.4.1 | this fork |
|---|---|---|
| voice notes | ignored silently | downloaded, transcribed, forwarded with transcript + path |
| speech-to-text | — | provider chain: OpenAI-compatible HTTP, CLI, or agent-side (MCP) |
| language/model | — | configured by env, no rebuild |
| message while the agent is busy | rejected: `Agent is already processing` | queued as `followUp` (or `steer`), nothing is lost |
| bot slash-command menu | stale, inherited from another binding | published on session start from the real command table |
| replies from the `telegram_send` tool | sent as plain text | sent with Telegram Markdown parse |
| forwarded message prefix | none | configurable, default `[telegram]` (lets the agent tell who is talking) |
| STT failure | — | never blocks the pipeline: the file path still reaches the agent |

Everything else (polling, `telegram_ask` callback buttons, photo download, `/` commands, offset
persistence across sessions, `telegram_override`, `telegram_status`) behaves as upstream.

## Install

As a pi extension, from a local clone:

```bash
git clone https://github.com/BalTac/pi-telegram-bridge.git
pi --extension ./pi-telegram-bridge/src/index.ts --continue
```

or as a dependency of a private project (keeps `node_modules` local, no global install):

```bash
npm install github:BalTac/pi-telegram-bridge#v1.4.1-baltac.5
```

`package.json` exposes the extension and the skills through the `pi` field, and the sources are loaded
as TypeScript, so there is no build step and no `dist/` to trust.

A minimal Windows launcher that loads the env file and starts pi with the extension:

```bat
set "ENVFILE=%~dp0..\telegram-bridge.env"
for /f "usebackq tokens=1,* delims==" %%a in ("%ENVFILE%") do set "%%a=%%b"
pi --extension "%~dp0..\.pi-bridge\node_modules\pi-telegram-bridge\src\index.ts" %*
```

## Configuration

Everything is environment based. Copy `.env.example`, or export the variables in the shell that
launches pi.

Required:

```bash
TELEGRAM_BOT_TOKEN=123456789:AA...      # from @BotFather
TELEGRAM_CHAT_ID=123456789              # your numeric chat id
```

Optional:

```bash
PI_TELEGRAM_ORIGIN_PREFIX=[telegram]    # tag prepended to forwarded messages
PI_TELEGRAM_DELIVER_AS=followUp         # or steer: how to queue while the agent works
PI_TELEGRAM_STT_CHAIN=http,cmd,agent    # provider order for voice notes
PI_TELEGRAM_STT_URL=https://api.openai.com/v1/audio/transcriptions
PI_TELEGRAM_STT_MODEL=whisper-1
PI_TELEGRAM_STT_LANG=it
PI_TELEGRAM_STT_KEY=sk-...              # bearer token, if the endpoint needs one
PI_TELEGRAM_STT_HEADER=x-api-key: abc   # extra header for providers that want it
PI_TELEGRAM_STT_CMD=whisper-cli -m /models/ggml-base.bin -l it -nt -f {file}
PI_TELEGRAM_STT_TIMEOUT_MS=120000
PI_TELEGRAM_SYNC_MENU=0                 # 0 disables the slash-menu sync
PI_TELEGRAM_ENV_FILE=/path/to/bridge.env # lets /deliver persist the mode
```

A note on `TELEGRAM_CHAT_ID`: the chat id is not the bot id, and a group id is negative. Send `/start`
to the bot, then read `message.chat.id` from `getUpdates`.

## Voice notes: three ways to get a transcript

A Telegram voice note is OGG/Opus. The bridge downloads it to the temp directory and then walks
`PI_TELEGRAM_STT_CHAIN`, stopping at the first provider that returns text. If none does, the agent
still receives the file path, plus the reason each stage failed.

### 1. Local model — recommended: works on CPU, no audio leaves the machine

Any server that speaks the OpenAI `/v1/audio/transcriptions` dialect works:

- **whisper.cpp** — the easiest CPU path. Single binary, GGML models from `tiny` (39 MB) to
  `large-v3-turbo` (~1.6 GB):
  ```bash
  whisper-server -m models/ggml-base.bin --host 127.0.0.1 --port 8080 --convert
  export PI_TELEGRAM_STT_URL=http://127.0.0.1:8080/v1/audio/transcriptions
  export PI_TELEGRAM_STT_LANG=it
  ```
  Tune with `-t $(nproc)`; `base` or `small` with 4 threads transcribes a short voice note in a couple
  of seconds. Quantised models (`ggml-base-q5_1.bin`) halve the memory for a small accuracy cost.
- **faster-whisper-server** (CTranslate2, int8 on CPU, CUDA optional) — same endpoint shape:
  `--model large-v3 --compute_type int8`.
- **whisper-asr-webservice** (Docker, includes an OpenAI-compatible route).
- **LocalAI**, **vLLM** with an audio model, or your own worker, as long as it accepts
  `multipart/form-data` with `file` and answers `{"text": "..."}`.
- A GPU box on the LAN running Whisper — the point is that the bridge does not care whose endpoint it is.

### 2. Cloud provider (BYOK)

Same code path, different URL and model. The key stays in your environment:

```bash
export PI_TELEGRAM_STT_URL=https://api.openai.com/v1/audio/transcriptions
export PI_TELEGRAM_STT_MODEL=gpt-4o-transcribe   # or whisper-1
export PI_TELEGRAM_STT_KEY=sk-...
```

Works the same with **Groq** (`https://api.groq.com/openai/v1/audio/transcriptions`,
`whisper-large-v3-turbo`), **Mistral** (`voxtral-mini-latest`), **DeepInfra**, **together.ai**,
**Fireworks**, and anything else that mirrors the OpenAI audio API. Faster and often cheaper than a
large local model, at the cost of sending the audio out.

### 3. CLI or agent-side (MCP)

- **CLI**: set `PI_TELEGRAM_STT_CMD` and any binary can be the transcriber. `{file}` is replaced with
  the audio path; the bridge reads stdout, and if stdout is empty it reads `<file>.txt` (what
  whisper.cpp writes with `-otxt`).
  ```bash
  export PI_TELEGRAM_STT_CMD=whisper-cli -m /models/ggml-small.bin -l it -nt -f {file}
  ```
- **MCP / agent-side**: set `PI_TELEGRAM_STT_CHAIN=agent` and the bridge forwards only the path:
  ```
  🎙️ Voice from Telegram (12s)
  Path: /tmp/telegram-photos/voice_1730000000000.ogg
  ```
  The agent then calls whatever transcription tool it has — an MCP server, a shell command, a function
  in its toolbox. Right choice when the agent already knows how to transcribe, or when the STT service
  lives behind a session-only credential.

Mix them: `PI_TELEGRAM_STT_CHAIN=http,cmd,agent` tries the local server, falls back to a CLI, then
hands the path over. `off` disables transcription entirely.

## When the agent is already busy

pi's `sendUserMessage()` returns `void`: it is fire-and-forget, and a busy agent produces
`Extension "<runtime>" error: Agent is already processing` with no promise to catch. The bridge
therefore asks the session first: the `isIdle()` probe is registered at session start, so when the
agent is working the message is sent with `deliverAs` in the first place.

```
PI_TELEGRAM_DELIVER_AS=followUp   # default: runs right after the current turn
PI_TELEGRAM_DELIVER_AS=steer      # injects into the running turn, interrupts what it is doing
```

Use `steer` when the message changes what the agent should do *now* ("stop, wrong file"); leave
`followUp` when it is an ordinary new request. Anything that is not the busy error is rethrown, so a
real failure stays visible.

From Telegram, without restarting: `/deliver` shows the current mode, `/deliver steer` and
`/deliver followUp` change it live. To make the change survive a reload, expose the launcher env file
with `PI_TELEGRAM_ENV_FILE=/path/to/telegram-bridge.env`: `/deliver` rewrites the
`PI_TELEGRAM_DELIVER_AS` line there. `/status` shows the active mode too.

## Slash-command menu

On session start the bridge publishes its own command list with `setMyCommands`, so Telegram
autocompletes the commands that actually exist (`/deliver`, `/help`, `/status`, `/stop`, …) instead of
a stale menu left by another bot sharing the token. One call, once per session; disable with
`PI_TELEGRAM_SYNC_MENU=0`. `/commands` is accepted as an alias of `/help`.

## Commands

Agent-directed (the bridge sends them to the agent as an instruction):

| command | aliases | what it asks for |
|---|---|---|
| `/stop` | `/s` | pause at the next safe point |
| `/go` | `/g` | proceed with the current plan |
| `/sum` | | 3-bullet summary of the current work |
| `/redo` | `/r` | retry the last failed action |
| `/skip` | | skip the current step |
| `/files` | `/f` | list modified files |
| `/commit` | `/c` | commit as a checkpoint |
| `/push` | `/p` | push the commits |
| `/issue` | `/i` | create an issue from the session context |

Bridge-only (answered immediately, the agent is not involved):

| command | aliases | what it does |
|---|---|---|
| `/deliver` | `/d` | show or set `steer` / `followUp` |
| `/status` | `/st` | session status, including the delivery mode |
| `/help` | `/h`, `/commands` | the command list |

## Tools exposed to the agent

`telegram_listen` · `telegram_send` · `telegram_ask` (blocking, with option buttons) ·
`telegram_override` (human approval for a blocked action) · `telegram_notify` (rich formatted
notifications) · `telegram_status` (shows the resolved STT chain).

## Skills

- `skills/telegram-first` — how to behave when the conversation comes from Telegram (upstream).
- `skills/telegram-voice` — voice-note workflow: transcript handling, when to ask for a re-record,
  how to reply with audio.

## How it works

```
Telegram  ──long poll──▶  helpers.pollUpdates
                             │  text ───────────▶ pi.sendUserMessage (origin prefix)
                             │  photo ──────────▶ download + path
                             └  voice ──────────▶ download
                                                    │
                              stt.ts chain: http → cmd → agent
                                                    │
                                          transcript + path ──▶ pi.sendUserMessage
```

- `src/index.ts` — extension entry: lifecycle, callbacks, tools.
- `src/helpers.ts` — Bot API client, polling loop, file download.
- `src/stt.ts` — transcription provider chain, env driven, never throws.
- `src/forward.ts` — delivery into the session: idle probe, `steer`/`followUp`, env mode.
- `src/commands.ts` — slash commands and the menu published to Telegram.
- `src/tools/telegram.ts` — tool schemas.

## FAQ

**Does it work behind NAT or on a laptop that sleeps?**
Yes. The bridge long-polls the Bot API; there is no webhook and no inbound port.

**Do I need a GPU for voice notes?**
No. whisper.cpp with `ggml-base` or `small`, 4 threads, transcribes short notes in a couple of
seconds on a laptop CPU. A GPU is faster, not required.

**Can I use OpenAI, Groq or Mistral instead of a local model?**
Yes, any OpenAI-compatible `/v1/audio/transcriptions` endpoint. Models seen working: `whisper-1`,
`gpt-4o-transcribe`, `whisper-large-v3-turbo` (Groq), `voxtral-mini-latest` (Mistral).

**Can the agent use its own transcription tool (MCP) instead?**
Yes: `PI_TELEGRAM_STT_CHAIN=agent` forwards only the file path.

**What happens if the agent is busy when a message arrives?**
It is queued, not dropped: `followUp` by default, `steer` if you want it injected mid-run.

**Are the sources TypeScript with no build step?**
Yes, `main` points at `src/index.ts`. Nothing is minified, nothing is compiled before shipping.

**Is this a fork?**
Yes: `@bytesbrains/pi-telegram-bridge` 1.4.1, MIT, rebuilt from the published tarball because the
original repository disappeared. Original copyright preserved.

## Development

```bash
npm install
npm test          # vitest: helpers, commands, tools, forward, stt, menu
```

139 tests, including the polling loop with a mocked Bot API, voice routing, the delivery probe and
the transcription chain. No network and no bot token needed.

## License

MIT. Original work © bytesbrains; fork modifications © BalTac. See [LICENSE](LICENSE).
