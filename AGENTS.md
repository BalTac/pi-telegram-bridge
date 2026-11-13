# Telegram Bridge — Agent Usage Guide

> You are an AI agent. Use telegram-bridge tools to communicate with humans via Telegram.
> Ask questions, send status updates, and check for incoming messages.

## Quickstart

```bash
telegram_status()                                                  # Check if bridge is configured
telegram_send(message="Hello! I'm working on the task.")           # Send a status message
telegram_listen()                                                  # Check for new messages
telegram_ask(question="Should I proceed?", options=["Yes","No"])   # Ask and wait for reply
telegram_override(command="git push --force", reason="Force push detected")   # Override blocked action
```

## Tools

### telegram_listen

Check for any new inbound messages from the human in the configured chat. Returns the latest message text, or indicates no new messages. The background listener automatically forwards messages, so this is for explicit polling.

```bash
telegram_listen()
```

### telegram_send

Send a one-way message. Use for:
- Status updates ("Build started", "Tests passed")
- Progress reports ("Step 3/5 complete")
- Notifications ("Deployment finished")
- Errors or alerts

```bash
telegram_send(message="✅ All tests passed. Ready to deploy.")
telegram_send(message="⚠️ Found 3 linting issues. Fixing now...")
```

### telegram_ask

Ask a question and **WAIT** for a human reply. This tool **blocks** until the human responds or the timeout is reached. Use when you genuinely need human input — don't overuse it.

**Parameters:**
- `question` (required) — The question to ask
- `options` (optional) — Array of button options (default: `["Yes", "No", "Explain"]`)
- `timeoutMinutes` (optional) — How long to wait (default: 30 minutes)

```bash
# Simple yes/no
telegram_ask(question="Deploy v2.1.0 to production?")

# Custom options
telegram_ask(
  question="Which environment should I target?",
  options=["production", "staging", "development"]
)

# Short timeout
telegram_ask(
  question="Approve this database migration?",
  options=["Approve", "Reject"],
  timeoutMinutes=5
)
```

**Returns:**
- On reply: `Reply: "Yes"` with `details.answer = "Yes"`
- On timeout: `Timeout — proceeding autonomously` with `details.timedOut = true`

### telegram_override

Ask a human to approve or reject a **blocked action**. Use this when the supervisor blocks a dangerous operation (force push, destructive git ops, file deletion outside project boundary, etc.). This tool sends a structured message with the blocked command, reason, and context, then waits for the human to choose an action.

**Parameters:**
| Param | Required | Default | Description |
|-------|----------|---------|-------------|
| `command` | ✅ | — | The blocked command exactly as the supervisor reported it |
| `reason` | ✅ | — | Why the supervisor blocked it |
| `context` | ❌ | — | Additional context (what the user originally asked for) |
| `options` | ❌ | `["Yes, proceed", "No, cancel", "Explain more"]` | Custom button labels — 1st = proceed, 2nd = cancel, rest = explain |
| `timeoutMinutes` | ❌ | `30` | How long to wait for a response |

```bash
# Force push override
telegram_override(
  command="git push gitea feat/add-check --force",
  reason="Force push can overwrite remote history"
)

# Destructive operation with extra context
telegram_override(
  command="rm -rf node_modules",
  reason="Recursive deletion outside project boundary",
  context="User requested a clean reinstall of dependencies"
)

# Custom options
telegram_override(
  command="chmod -R 777 /var/www",
  reason="Broad permission changes detected",
  options=["Yes, it's safe", "No, cancel", "Use 755 instead", "Explain more"],
  timeoutMinutes=10
)
```

**Returns `details`:**
| Field | Type | Description |
|-------|------|-------------|
| `choice` | `string` | The exact button label the human clicked |
| `action` | `"proceed"` \| `"abort"` \| `"explain"` | Mapped action based on which button was clicked |
| `command` | `string` | The original blocked command (echoed back) |
| `timedOut` | `boolean` | `true` if no response within timeout |

**Mandatory workflow when blocked:**
1. Supervisor blocks your command → you see the reason and blocked command
2. Call `telegram_override(command, reason, context)` to ask the human
3. Check `details.action`:
   - **`"proceed"`** → call `supervisor_override(reason="<human approved>", command="<blocked command>")` then re-run
   - **`"abort"`** → tell the user the action was cancelled: `telegram_send(message="Action cancelled as requested.")`
   - **`"explain"`** → send more context via `telegram_send()`, then call `telegram_ask()` for follow-up
4. If **`details.timedOut === true`** → abort the action and tell the user: `telegram_send(message="No response received. Action aborted.")`

**On timeout:** Sends "⏰ No reply to override request. Aborting action." to Telegram and returns `details.timedOut = true`.

**Behavior on timeout:** The agent proceeds without human input. A "No reply" message is sent to Telegram.

### telegram_status

Check if the bridge is configured and the background listener is running.

```bash
telegram_status()
```

**Possible responses:**
- `Not configured. Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID.` — Missing env vars
- `Active. Bot: @mybot (listener: 🟢 running)` — Fully operational
- `Token set but unreachable.` — Network or auth issue

## Background Listener

A background listener starts automatically on session start and runs throughout the session. It:
- Polls Telegram every 5 seconds for new messages
- Forwards any non-bot text messages from the configured chat to the agent
- Sends a confirmation (`👂 Got it! Working on: ...`) to acknowledge receipt
- Stops cleanly on session shutdown

The listener ignores:
- Messages from bots (including itself)
- Messages from other chats
- Callback queries (button presses) — these are handled by `telegram_ask`

## Best Practices

1. **Use `telegram_send` for routine updates** — it's non-blocking
2. **Use `telegram_ask` sparingly** — only when you truly need human input
3. **Use `telegram_override` for blocked actions** — always ask before calling `supervisor_override`
4. **Set reasonable timeouts** — don't block the agent indefinitely
5. **Handle timeouts gracefully** — the agent should be able to proceed without human input
6. **Check `telegram_status` first** — verify the bridge is configured before sending messages

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `telegram_status` says not configured | Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` env vars |
| Messages not being delivered | Check that the bot token is valid and the chat ID is correct |
| Bot unreachable | Check network connectivity and Telegram API status |
| Duplicate messages | The bridge tracks update IDs to avoid duplicates. If it persists, restart the session |
| Listener stops unexpectedly | Check logs for errors. The listener auto-recovers from transient failures |
