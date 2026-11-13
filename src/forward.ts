/**
 * Forwarding a Telegram message into the pi session, even while the agent works.
 *
 * `pi.sendUserMessage()` fails with "Agent is already processing. Specify
 * streamingBehavior ('steer' or 'followUp')" when a run is in progress. The
 * message is not lost silently: it is rejected, and the caller has to pick a
 * delivery mode. This wrapper does it for every entry point (text, photo,
 * voice, slash commands):
 *
 *   - idle        → plain send, the message starts a run immediately
 *   - busy        → retry with `deliverAs`, so the message is queued:
 *       followUp (default) → runs right after the current turn, nothing is interrupted
 *       steer              → injected into the running turn (PI_TELEGRAM_DELIVER_AS=steer)
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

const BUSY_ERROR = /already processing|streamingBehavior/i;

type Messenger = Pick<ExtensionAPI, "sendUserMessage">;

/**
 * Send a user message into the session. Returns "sent" when it started a run,
 * "queued" when the agent was busy and the message was delivered as
 * steer/followUp. Any other error is rethrown: this wrapper absorbs exactly one
 * failure mode, the one caused by concurrency.
 */
export async function forwardToAgent(
	pi: Messenger,
	text: string,
	env: NodeJS.ProcessEnv = process.env,
): Promise<"sent" | "queued"> {
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
