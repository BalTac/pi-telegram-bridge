# pi-telegram-bridge

![pi-telegram-bridge](docs/banner.png)

Telegram bridge for [pi](https://github.com/bytesbrains/pi-telegram-bridge): a background listener that
forwards Telegram messages (text, photos, **voice notes**) to the agent as user messages, and five
tools to talk back.

This is a maintained fork of `@bytesbrains/pi-telegram-bridge` **1.4.1**. The original repository is no
longer reachable, so the code was rebuilt from the published npm tarball (which ships the TypeScript
sources, `main: ./src/index.ts`) and this fork adds voice-note support with a pluggable
speech-to-text layer. MIT, original copyright preserved in `LICENSE`.

## What is different from the original 1.4.1

| | original 1.4.1 | this fork |
|---|---|---|
| voice notes | ignored silently | downloaded, transcribed, forwarded with transcript + path |
| speech-to-text | — | chain of providers: OpenAI-compatible HTTP, CLI, or agent-side (MCP) |
| language/model | — | configured by env, no rebuild |
| replies from the `telegram_send` tool | sent as plain text | sent with Telegram Markdown parse |
| forwarded message prefix | none | configurable, default `[telegram]` (lets the agent tell who is talking) |
| message while the agent is busy | rejected: `Agent is already processing` | queued as `followUp` (or `steer`), nothing is lost |
| STT failure | — | never blocks the pipeline: the file path still reaches the agent |

Everything else (polling, `telegram_ask` callback buttons, photo download, `/` commands, offset
persistence across sessions, `telegram_override`, `telegram_status`) behaves as upstream.

## Install

As a pi extension, from a local clone:

```bash
git clone https://github.com/BalTac/pi-telegram-bridge.git
pi --extension /path/to/pi-telegram-bridge/src/index.ts
```

or as a package dependency inside a private project (keeps `node_modules` local, no global install):

```bash
npm install github:BalTac/pi-telegram-bridge#v1.4.1-baltac.1
```

`package.json` exposes the extension and the skills through the `pi` field, and the sources are
loaded as TypeScript, so there is no build step.

## Configuration

Everything is environment based. Copy `.env.example`, or export the variables in the shell that
launches pi.

Required:

```
TELEGRAM_BOT_TOKEN=123456789:AA...
TELEGRAM_CHAT_ID=123456789
```

Optional:

```
PI_TELEGRAM_ORIGIN_PREFIX=[telegram]
PI_TELEGRAM_STT_CHAIN=http,cmd,agent
PI_TELEGRAM_STT_URL=http://127.0.0.1:8123/v1/audio/transcriptions
PI_TELEGRAM_STT_MODEL=whisper-large-v3-turbo
PI_TELEGRAM_STT_LANG=it
PI_TELEGRAM_STT_KEY=...
PI_TELEGRAM_STT_HEADER=x-api-key: abc
PI_TELEGRAM_STT_CMD=whisper-cli -m /models/ggml-base.bin -l it -nt -f {file}
PI_TELEGRAM_STT_TIMEOUT_MS=120000
```

## Voice notes: three ways to get a transcript

A Telegram voice note is OGG/Opus. The bridge downloads it to the temp directory and then walks
`PI_TELEGRAM_STT_CHAIN`, stopping at the first provider that returns text. If none does, the agent
still receives the file path, plus the reason each stage failed.

### 1. Local model (recommended: works on CPU, no data leaves the machine)

Any server that speaks the OpenAI `/v1/audio/transcriptions` dialect works:

- **whisper.cpp** — the easiest CPU path. `brew`/`apt` package or a single binary, ggml models from
  `tiny` (39 MB) to `large-v3-turbo` (~1.6 GB). Start the server on a port and point the bridge at it:
  ```bash
  whisper-server -m models/ggml-base.bin --host 127.0.0.1 --port 8080 --convert
  export PI_TELEGRAM_STT_URL=http://127.0.0.1:8080/v1/audio/transcriptions
  export PI_TELEGRAM_STT_LANG=it
  ```
  Tune with `-t $(nproc)`; `base` or `small` with 4 threads transcribes short voice notes in a couple
  of seconds. Quantised models (`ggml-base-q5_1.bin`) halve the memory for a tiny accuracy cost.
- **faster-whisper-server** (CTranslate2, int8 on CPU, GPU optional) — same endpoint shape,
  `--model large-v3 --compute_type int8`.
- **whisper-asr-webservice** (Docker, includes an OpenAI-compatible route).
- **LocalAI**, **vLLM** with an audio model, or your own worker — as long as it accepts
  `multipart/form-data` with `file` and returns `{"text": "..."}`.

### 2. Cloud provider (BYOK)

Same code path, different URL and model. The key stays in your environment:

```bash
export PI_TELEGRAM_STT_URL=https://api.openai.com/v1/audio/transcriptions
export PI_TELEGRAM_STT_MODEL=gpt-4o-transcribe      # or whisper-1
export PI_TELEGRAM_STT_KEY=sk-...
```

Works the same with Groq (`https://api.groq.com/openai/v1/audio/transcriptions`,
`whisper-large-v3-turbo`), Mistral (`voxtral-mini-latest`), DeepInfra, together.ai, Fireworks.
These are usually faster and much cheaper than running a large model locally, at the cost of
sending the audio out.

### 3. CLI or agent-side (MCP)

- **CLI**: set `PI_TELEGRAM_STT_CMD` and any binary can be the transcriber. `{file}` is replaced with
  the audio path; the bridge reads stdout, and if stdout is empty it reads `<file>.txt` (which is what
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
  in its toolbox. This is the right choice when the agent already knows how to transcribe, or when the
  STT service lives behind a session-only credential.

You can mix them: `PI_TELEGRAM_STT_CHAIN=http,cmd,agent` tries the local server, falls back to a CLI,
and finally hands the path over. `off` disables transcription entirely.

## When the agent is already busy

pi rejects `sendUserMessage()` while a run is in progress. The bridge does not drop the message:
`src/forward.ts` retries it with `deliverAs`, so it is queued instead of lost.

```
PI_TELEGRAM_DELIVER_AS=followUp   # default: runs right after the current turn
PI_TELEGRAM_DELIVER_AS=steer      # injects into the running turn, interrupts what it is doing
```

Use `steer` when the message changes what the agent should do *now* ("stop, wrong file"); leave
`followUp` when it is an ordinary new request.

From Telegram, without restarting: `/deliver` shows the current mode, `/deliver steer` and
`/deliver followUp` change it live. To make the change survive a reload, expose the launcher env
file with `PI_TELEGRAM_ENV_FILE=/path/to/telegram-bridge.env`: `/deliver` rewrites the
`PI_TELEGRAM_DELIVER_AS` line there. `/status` shows the active mode too. Anything that is not the busy error is rethrown, so a
real failure is still visible.

## Tools exposed to the agent

`telegram_listen` · `telegram_send` · `telegram_ask` (blocking, with option buttons) ·
`telegram_override` (human approval for a blocked action) · `telegram_notify` (rich formatted
notifications) · `telegram_status` (shows the resolved STT chain).

## Skills

- `skills/telegram-first` — how to behave when the conversation comes from Telegram (upstream).
- `skills/telegram-voice` — voice-note workflow: transcript handling, when to ask for a re-record,
  how to reply with audio.

## Development

```bash
npm install
npm test          # vitest: helpers, commands, tools, index
```

## License

MIT. Original work © bytesbrains; fork modifications © BalTac. See `LICENSE`.
