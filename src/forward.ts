/**
 * Forwarding a Telegram message into the pi session, even while the agent works.
 *
 * In pi 1.5.x `sendUserMessage()` returns `void`: it is fire-and-forget, and a
 * failure surfaces as `Extension "<runtime>" error: Agent is already processing`
 * instead of a rejected promise. So catching the error is not enough — we have to
 * know *before* sending whether the agent is busy, and pass the delivery mode.
 *
 * `setIdleProbe()` is wired once from `session_start` (the context exposes
 * `isIdle()`). When the probe says the agent is busy, the message is sent with
 * `deliverAs` straight away:
 *
 *   followUp (default) → queued, runs right after the current turn
 *   steer              → injected into the running turn (PI_TELEGRAM_DELIVER_AS=steer)
 *
 * Versions that do return a promise are still handled by the try/catch fallback.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type DeliverAs = "steer" | "followUp";

/** Delivery mode used when the agent is busy. Default: followUp. */
export function deliverMode(env: NodeJS.ProcessEnv = process.env): DeliverAs {
	const raw = (env.PI_TELEGRAM_DELIVER_AS ?? "").trim().toLowerCase();
	return raw === "steer" ? "steer" : "followUp";
}

/** Change the delivery mode for this process (no restart needed). */
export function setDeliverMode(mode: DeliverAs, env: NodeJS.ProcessEnv = process.env): void {
	env.PI_TELEGRAM_DELIVER_AS = mode;
}

let idleProbe: (() => boolean) | null = null;

/** Register the "is the agent idle?" probe, taken from an ExtensionContext. */
export function setIdleProbe(probe: (() => boolean) | null): void {
	idleProbe = probe;
}

/** True when we know the agent is processing. Unknown counts as idle. */
function agentIsBusy(): boolean {
	try {
		return idleProbe ? !idleProbe() : false;
	} catch {
		return false;
	}
}

const BUSY_ERROR = /already processing|streamingBehavior/i;

type Messenger = Pick<ExtensionAPI, "sendUserMessage">;

/**
 * Send a user message into the session. Returns "sent" when it started a run,
 * "queued" when the agent was busy and the message was delivered as steer or
 * followUp. Any other error is rethrown: this wrapper absorbs exactly one
 * failure mode, the one caused by concurrency.
 */
export async function forwardToAgent(
	pi: Messenger,
	text: string,
	env: NodeJS.ProcessEnv = process.env,
): Promise<"sent" | "queued"> {
	if (agentIsBusy()) {
		const mode = deliverMode(env);
		await pi.sendUserMessage(text, { deliverAs: mode });
		return "queued";
	}
	try {
		await pi.sendUserMessage(text);
		return "sent";
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (!BUSY_ERROR.test(message)) throw error;
		const mode = deliverMode(env);
		await pi.sendUserMessage(text, { deliverAs: mode });
		return "queued";
	}
}
