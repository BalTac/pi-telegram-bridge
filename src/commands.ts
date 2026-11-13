/**
 * pi-telegram-bridge — Slash Command Handler
 *
 * Detects slash-prefixed messages and either:
 *   - Handles directly (bridge-only commands: /help, /status)
 *   - Injects structured instruction to agent (control commands)
 *   - Falls through for unknown commands (could be paths)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { sendMsg, getChatId } from "./helpers";
import * as cp from "node:child_process";
import * as util from "node:util";
const execAsync = util.promisify(cp.exec);

// ── Command Definitions ─────────────────────────────────────────────

interface CommandDef {
	name: string;
	aliases: string[];
	type: "bridge" | "agent";
	description: string;
	/** For agent-type commands: structured instruction injected to the agent */
	inject?: string;
	/** Acknowledgment sent back to Telegram */
	ack: string;
}

const COMMANDS: CommandDef[] = [
	{
		name: "/stop",
		aliases: ["/s"],
		type: "agent",
		description: "Pause current action at next safe point",
		ack: "⏹ Stopping at next safe point...",
		inject:
			"[COMMAND: /stop]\n" +
			"⚠️ Human requested you pause your current action. Stop at the next safe point and wait for further instructions.",
	},
	{
		name: "/go",
		aliases: ["/g"],
		type: "agent",
		description: "Proceed with current plan",
		ack: "▶️ Proceeding...",
		inject:
			"[COMMAND: /go]\n" +
			"✅ Human confirmed — proceed with your current plan.",
	},
	{
		name: "/sum",
		aliases: [],
		type: "agent",
		description: "Give a 3-bullet summary of current work",
		ack: "📋 Summarizing...",
		inject:
			"[COMMAND: /sum]\n" +
			"📋 SUMMARIZE: Give a quick 3-bullet summary of what you're doing right now — current task, progress, next step.",
	},
	{
		name: "/redo",
		aliases: ["/r"],
		type: "agent",
		description: "Retry last failed action",
		ack: "🔄 Retrying last failed action...",
		inject: "[COMMAND: /redo]\n" + "🔄 REDO: Retry your last failed action.",
	},
	{
		name: "/commit",
		aliases: ["/c"],
		type: "agent",
		description: "Commit current changes (checkpoint)",
		ack: "📦 Committing changes...",
		inject:
			"[COMMAND: /commit]\n" +
			"📦 COMMIT: This is a good checkpoint — commit your current staged/working changes now via contrib_propose.",
	},
	{
		name: "/push",
		aliases: ["/p"],
		type: "agent",
		description: "Push commits",
		ack: "🚀 Pushing...",
		inject: "[COMMAND: /push]\n" + "🚀 PUSH: Push your commits now.",
	},
	{
		name: "/skip",
		aliases: [],
		type: "agent",
		description: "Skip current step, move to next",
		ack: "⏭ Skipping current step...",
		inject:
			"[COMMAND: /skip]\n" +
			"⏭ SKIP: Skip the current step and move on to what's next.",
	},
	{
		name: "/files",
		aliases: ["/f"],
		type: "agent",
		description: "List modified files",
		ack: "📁 Listing modified files...",
		inject:
			"[COMMAND: /files]\n" +
			"📁 FILES: List what files you've modified so far in this session.",
	},
	{
		name: "/issue",
		aliases: ["/i"],
		type: "agent",
		description: "Create an issue from session context",
		ack: "🎫 Creating issue from session context...",
		inject:
			"[COMMAND: /issue]\n" +
			"🎫 Create a well-structured issue from the current session context. Follow this workflow:\n" +
			"\n" +
			"1. READ the session context — review conversation history, current branch, modified files.\n" +
			"2. RESEARCH the project — read README, AGENTS.md, check for duplicate issues via project_list_issues.\n" +
			"3. DECIDE if clarification is genuinely needed:\n" +
			"   - YES only if: scope is ambiguous, multiple valid approaches exist, or critical info is missing.\n" +
			"   - NO if: problem is clear from context, you can infer a good title and body.\n" +
			"4. If NO clarification needed: draft the issue with a clear conventional title and structured body, create it via project_create_issue, share the ID and URL.\n" +
			"5. If YES clarification needed: ask 1-2 focused questions via telegram_ask, then create the issue.\n" +
			"6. NOTIFY the human via telegram_notify(kind='issue') with the created issue details.\n" +
			"\n" +
			"CRITICAL: Do NOT ask permission to create — /issue IS permission. Limit clarification to 1 round max. If no context found, say so and ask for a title.",
	},
	{
		name: "/help",
		aliases: ["/h"],
		type: "bridge",
		description: "Show available commands",
		ack: "📖 Sending command list...",
	},
	{
		name: "/status",
		aliases: ["/st"],
		type: "bridge",
		description: "Show session status",
		ack: "📊 Checking session status...",
	},
];

// ── Lookup ──────────────────────────────────────────────────────────

/** Case-insensitive, aliases included. Returns the canonical CommandDef. */
function findCommand(input: string): CommandDef | null {
	const normalized = input.trim().toLowerCase();
	// Exact match on name or any alias
	for (const cmd of COMMANDS) {
		if (normalized === cmd.name || cmd.aliases.includes(normalized)) {
			return cmd;
		}
	}
	// Also match prefix if it starts with the command name followed by space or end
	// e.g. "/stop now please" should match /stop
	const firstWord = normalized.split(/\s+/)[0];
	for (const cmd of COMMANDS) {
		if (firstWord === cmd.name || cmd.aliases.includes(firstWord)) {
			return cmd;
		}
	}
	return null;
}

// ── Bridge-Handled Commands ────────────────────────────────────────

async function handleHelp(): Promise<string> {
	const lines: string[] = ["<b>⌨️ Available Commands</b>\n"];
	lines.push("<b>━━━━━━━━━━━━━━━━━━━━</b>\n");

	lines.push("<b>🎛 Control</b>");
	for (const cmd of COMMANDS.filter((c) => c.type === "agent")) {
		const aliases = cmd.aliases.length > 0 ? cmd.aliases.join(" ") + " " : "";
		lines.push(`  <code>${aliases}${cmd.name}</code> — ${cmd.description}`);
	}

	lines.push("\n<b>ℹ️ Info</b>");
	for (const cmd of COMMANDS.filter((c) => c.type === "bridge")) {
		const aliases = cmd.aliases.length > 0 ? cmd.aliases.join(" ") + " " : "";
		lines.push(`  <code>${aliases}${cmd.name}</code> — ${cmd.description}`);
	}

	return lines.join("\n");
}

async function handleStatus(): Promise<string> {
	let branch = "unknown";
	try {
		const { stdout } = await execAsync("git rev-parse --abbrev-ref HEAD", {
			timeout: 3000,
		});
		branch = stdout.trim();
	} catch {
		/* ignore */
	}

	let nodeVersion = "unknown";
	try {
		nodeVersion = process.version;
	} catch {
		/* ignore */
	}

	const lines: string[] = [];
	lines.push("<b>📊 Session Status</b>");
	lines.push("<b>━━━━━━━━━━━━━━━━━━━━</b>");
	lines.push(`<b>Branch:</b> <code>${escapeHtmlCmd(branch)}</code>`);
	lines.push(`<b>Node:</b> <code>${escapeHtmlCmd(nodeVersion)}</code>`);
	lines.push(`<b>Chat ID:</b> <code>${escapeHtmlCmd(getChatId())}</code>`);

	// Uptime from process
	const uptime = Math.floor(process.uptime());
	const mins = Math.floor(uptime / 60);
	const hrs = Math.floor(mins / 60);
	const uptimeStr =
		hrs > 0 ? `${hrs}h ${mins % 60}m` : `${mins}m ${uptime % 60}s`;
	lines.push(`<b>Process uptime:</b> <code>${uptimeStr}</code>`);

	return lines.join("\n");
}

function escapeHtmlCmd(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ── Main Handler ────────────────────────────────────────────────────

export type CommandResult =
	| { handled: true; type: "bridge" }
	| { handled: true; type: "agent" }
	| { handled: false };

/**
 * Process a slash command from a Telegram message.
 *
 * @param text - The raw message text (e.g., "/stop" or "/status")
 * @param pi - ExtensionAPI for injecting agent messages
 * @param sendAck - Whether to send an acknowledgment to Telegram
 * @returns Result indicating how the command was handled
 */
export async function handleCommand(
	text: string,
	pi: ExtensionAPI,
	sendAck = true,
): Promise<CommandResult> {
	const cmd = findCommand(text);
	if (!cmd) return { handled: false };

	// Send acknowledgment
	if (sendAck) {
		await sendMsg(cmd.ack).catch(() => {});
	}

	if (cmd.type === "bridge") {
		if (cmd.name === "/help") {
			const helpText = await handleHelp();
			await sendMsg(helpText, undefined, "HTML").catch(() => {});
		} else if (cmd.name === "/status") {
			const statusText = await handleStatus();
			await sendMsg(statusText, undefined, "HTML").catch(() => {});
		}
		return { handled: true, type: "bridge" };
	}

	// Agent-directed: inject structured instruction
	if (cmd.inject) {
		pi.sendUserMessage(cmd.inject);
	}
	return { handled: true, type: "agent" };
}

/**
 * Check if a message starts with a slash (potential command).
 * Used as a quick pre-filter before calling handleCommand.
 */
export function isPossibleCommand(text: string): boolean {
	return text.trimStart().startsWith("/");
}

/**
 * Get all command definitions (for /help formatting).
 */
export function getCommands(): CommandDef[] {
	return COMMANDS;
}
