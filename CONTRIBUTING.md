# Contributing

Small project, short rules.

## Before opening a pull request

```bash
npm install
npm test          # must be green, 139+ tests, no network needed
```

The suite mocks the Bot API, so tests never touch Telegram and never need a token. If you add a
feature that talks to the network, mock it the same way.

## What is easy to accept

- A new STT provider that speaks an existing dialect: add it to `src/stt.ts` only if it is not
  OpenAI-compatible; otherwise it needs no code, just env values in the README.
- Fixes to the polling loop, retries, offset persistence.
- New slash commands: add them to `COMMANDS` in `src/commands.ts`. The Telegram menu is derived from
  that table, so nothing else needs updating. Keep `name` lowercase, one alias maximum.
- Documentation, examples, translations of the README.

## What needs a discussion first

- Changing the shape of forwarded messages (`[telegram]` prefix, transcript block) — agents and skills
  depend on it.
- Adding dependencies. This package has zero runtime dependencies on purpose: it must stay a
  drop-in file loaded by pi.
- Anything that makes a transcription failure block the message. The rule is: the agent always gets
  the message; the transcript is a bonus.

## Style

- TypeScript, tabs, no build step, `main` stays `./src/index.ts`.
- Comments explain *why*, not *what*.
- Error messages say what the operator should check.

## Reporting a bug

Include: pi version (`pi --version`), the STT chain in use, whether `PI_TELEGRAM_SYNC_MENU` or
`PI_TELEGRAM_ENV_FILE` are set, and the line from `src/stt.ts`'s summary printed by `telegram_status`.
Never paste your bot token.
