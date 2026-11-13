---
name: telegram-voice
description: Handle voice notes that arrive from Telegram through the pi-telegram-bridge — read the transcript, deal with a missing one, and answer with audio when that is what the person expects.
---

# Telegram voice notes

Voice notes arrive as a normal user message, prefixed with the origin marker
(`[telegram]` by default) and shaped like this:

```
[telegram] 🎙️ Voice from Telegram (12s, transcript via http)
Transcript: ciao, mi leggi il messaggio che ti ho mandato ieri?
Path: /tmp/telegram-photos/voice_1730000000000.ogg
```

## What to do

1. **Treat the transcript as the message.** It is what the person said; the audio file is evidence,
   not something to read out again.
2. **Never invent words when there is no transcript.** If the text says
   `(no transcript: … )`, transcribe the file yourself if you have a tool for it (an MCP
   transcription server, a local CLI), otherwise say plainly that you did not get the words and ask
   for a repeat or a written message. Do not guess.
3. **Check the confidence signals.** `transcript via agent` means nothing was transcribed by the
   bridge: you are looking at a raw path. `transcript via cmd`/`http` means a real model answered.
   Short notes with names, numbers or addresses are worth confirming.
4. **Answer in the channel the person used.** If they spoke, a voice reply is natural — use the
   audio tool available in the session; otherwise answer in text, briefly, as on any Telegram turn.
5. **Use the path when it matters.** If you need the original audio (prosody, a strange word,
   forwarding it), the file is real and local: `Path:` above.

## Failure modes worth naming out loud

| symptom | cause | what to say |
|---|---|---|
| `no transcript: http: HTTP 401` | STT key wrong or missing | tell the human the transcriber rejected the key, ask them to fix it |
| `no transcript: http: timeout` | model too slow or server down | offer to retry, or transcribe from the path |
| `no transcript: no STT provider configured` | nothing configured | ask for the text, or for STT to be configured |
| transcript in the wrong language | `PI_TELEGRAM_STT_LANG` mismatched | retry with the right language or `auto` |

## Do not

- Do not echo the whole transcript back as a reply: the person already knows what they said.
- Do not treat a missing transcript as an empty message — say it is missing.
- Do not send the audio file back to the person who just recorded it.
