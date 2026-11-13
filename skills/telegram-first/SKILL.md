---
name: telegram-first
description: Route ALL interactive communication through Telegram instead of terminal prompts. The human is reachable on Telegram — use telegram_ask for questions, telegram_notify for status, telegram_send for updates.
---

# Telegram-First Communication

When telegram-bridge is active, route ALL interactive communication through Telegram instead of the terminal. The human is primarily reachable on Telegram — terminal prompts go unanswered.

## Rules

### Questions & Confirmations

Use `telegram_ask` for ANY decision, confirmation, or question:

- Approval requests (force push, destructive ops, deployments)
- Clarification questions (ambiguous instructions, multiple approaches)
- Dependency decisions (which library, which approach)
- Priority calls (order of work, tradeoffs)

Do NOT use terminal dialogs (`ctx.ui.confirm`, `ctx.ui.select`, `ctx.ui.input`) — the human won't see them.

### Status Updates

Use `telegram_notify` for structured status updates:

- Issue created/updated → kind: `issue`
- PR created/status change → kind: `pr`
- Work started/progress/complete → kind: `task`
- CI pipeline results → kind: `pipeline`
- Session started/ended → kind: `session`
- Factory job dispatched/completed → kind: `factory-job`
- Errors or warnings → kind: `alert`
- Commits or diffs → kind: `diff`
- End-of-session roundup → kind: `standup`

### One-Way Messages

Use `telegram_send` for:

- Quick acknowledgments ("Got it, working on it")
- Simple progress notes not needing structured format
- Links or references

### Fallback

Only use terminal UI if:

- `telegram_status` reports Telegram is not configured or unreachable
- A `telegram_ask` times out with no reply (then proceed autonomously and notify via `telegram_send`)

## Session Flow

1. **Start:** Send `session` notification via `telegram_notify`
2. **During:** Route all questions through `telegram_ask`, progress through `telegram_notify(kind="task")`
3. **Significant events:** CI results, PRs, issues, commits → `telegram_notify` with appropriate kind
4. **End:** Send `standup` roundup summarizing completed, next, and blockers
