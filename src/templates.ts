/**
 * pi-telegram-bridge — Rich Message Templates
 *
 * Well-designed notification templates for Telegram.
 * Uses HTML parse mode for reliable formatting with special characters.
 * Supports: issue, PR, CI/CD, work progress, agent session, factory, alerts.
 */

// ── Helpers ─────────────────────────────────────────────────────────

const BAR = "━".repeat(20);

/** Escape user text for safe embedding inside HTML tags. */
function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

function bold(s: string) {
	return `<b>${escapeHtml(s)}</b>`;
}
function italic(s: string) {
	return `<i>${escapeHtml(s)}</i>`;
}
function code(s: string) {
	return `<code>${escapeHtml(s)}</code>`;
}
function strike(s: string) {
	return `<s>${escapeHtml(s)}</s>`;
}
function labelValue(label: string, value: string) {
	return `${bold(label + ":")} ${escapeHtml(value)}`;
}
function link(url: string, text: string) {
	return `<a href="${url}">${escapeHtml(text)}</a>`;
}
function progressBar(pct: number, width = 12) {
	const filled = Math.round((pct / 100) * width);
	return `<code>${"█".repeat(filled)}${"░".repeat(width - filled)}</code> ${pct}%`;
}

// ── CI/CD Status Icons ─────────────────────────────────────────────

function jobIcon(status: string): string {
	const map: Record<string, string> = {
		success: "✅",
		failure: "❌",
		cancelled: "⚪",
		skipped: "⏭️",
		running: "🔵",
		queued: "⏳",
		pending: "🟡",
		in_progress: "🔵",
	};
	return map[status] ?? "❓";
}

// ── Issue Tray (compact, swipe-friendly) ───────────────────────────

export interface IssueCard {
	number: number;
	title: string;
	state: "open" | "closed";
	status?: string;
	assignee?: string;
	labels?: string[];
	milestone?: string;
	repo: { owner: string; name: string };
	branch?: string;
	pr?: { number: number; status: string };
	url?: string;
}

export function issueCard(i: IssueCard): string {
	const icon =
		i.state === "closed" ? "✅" : i.status === "blocked" ? "🚫" : "📋";
	const closed = i.state === "closed";

	let msg = `${icon} ${bold(`Issue #${i.number}`)}${closed ? strike("") : ""}: ${closed ? strike(i.title) : bold(i.title)}\n`;
	msg += `${BAR}\n`;

	if (i.status) {
		const statusIcon =
			i.status === "in progress" ? "🔄" : i.status === "blocked" ? "🚫" : "📌";
		msg +=
			labelValue(
				"Status",
				`${closed ? strike(`${statusIcon} ${i.status}`) : `${statusIcon} ${i.status}`}`,
			) + "\n";
	}
	if (i.assignee) msg += labelValue("Assignee", code(i.assignee)) + "\n";
	if (i.labels && i.labels.length > 0) {
		msg += labelValue("Labels", i.labels.map((l) => code(l)).join(" ")) + "\n";
	}
	if (i.milestone) msg += labelValue("Milestone", italic(i.milestone)) + "\n";
	msg += labelValue("Repo", italic(`${i.repo.owner}/${i.repo.name}`)) + "\n";
	msg += `${BAR}\n`;
	if (i.branch) msg += labelValue("Branch", code(i.branch)) + "\n";
	if (i.pr && i.url) {
		msg +=
			labelValue("PR", `${link(i.url, `#${i.pr.number}`)} — ${i.pr.status}`) +
			"\n";
	} else if (i.pr) {
		msg += labelValue("PR", `#${i.pr.number} — ${i.pr.status}`) + "\n";
	}
	if (i.url) msg += `\n${link(i.url, "View on GitHub")}`;
	return msg;
}

// ── PR Status Card ──────────────────────────────────────────────────

export interface PRCard {
	number: number;
	title: string;
	state: "open" | "closed" | "merged" | "draft";
	author: string;
	base: string;
	head: string;
	repo: { owner: string; name: string };
	ci?: { passed: number; failed: number; total: number; status?: string };
	reviews?: { approved: number; requested: number; changesRequested: number };
	files?: { added: number; removed: number; changed: number };
	breaking?: boolean;
	draft?: boolean;
	url?: string;
}

export function prCard(pr: PRCard): string {
	const stateIcon =
		pr.state === "merged"
			? "💜"
			: pr.state === "closed"
				? "⚫"
				: pr.draft
					? "📝"
					: "🔀";
	const stateBadge =
		pr.state === "merged"
			? "💜 Merged"
			: pr.state === "closed"
				? "⚫ Closed"
				: pr.draft
					? "📝 Draft"
					: "🟡 Open";

	let msg = `${stateIcon} ${bold(`PR #${pr.number}`)}: ${italic(pr.title)}\n`;
	msg += `${BAR}\n`;
	msg += labelValue("Status", stateBadge) + "\n";
	msg += labelValue("Author", code(pr.author)) + "\n";
	msg += labelValue("Branch", `${code(pr.base)} ← ${code(pr.head)}`) + "\n";

	if (pr.ci) {
		const icon = pr.ci.status
			? jobIcon(pr.ci.status)
			: pr.ci.failed === 0
				? "✅"
				: "❌";
		msg +=
			labelValue(
				"CI",
				`${icon} ${pr.ci.passed}/${pr.ci.total} checks passed` +
					(pr.ci.failed > 0 ? ` · ${pr.ci.failed} failed` : ""),
			) + "\n";
	}

	if (pr.reviews) {
		const parts: string[] = [];
		if (pr.reviews.approved > 0)
			parts.push(`✅ ${pr.reviews.approved} approved`);
		if (pr.reviews.changesRequested > 0)
			parts.push(`🔴 ${pr.reviews.changesRequested} changes req`);
		if (pr.reviews.requested > 0)
			parts.push(`⏳ ${pr.reviews.requested} pending`);
		msg += labelValue("Reviews", parts.join(" · ")) + "\n";
	}

	if (pr.files) {
		msg +=
			labelValue(
				"Files",
				`${pr.files.changed} files (+${pr.files.added} −${pr.files.removed})`,
			) + "\n";
	}
	if (pr.breaking) msg += labelValue("Breaking", "⚠️ Yes") + "\n";

	msg += `${BAR}\n`;
	if (pr.url) msg += link(pr.url, "View on GitHub");
	return msg;
}

// ── Work / Task Progress ────────────────────────────────────────────

export interface TaskProgress {
	title: string;
	emoji?: string;
	status: "started" | "in-progress" | "paused" | "blocked" | "complete";
	progress?: number;
	elapsed?: string;
	eta?: string;
	details?: string[];
	metrics?: Record<string, string>;
}

export function taskProgress(t: TaskProgress): string {
	const icons: Record<string, string> = {
		started: "🟢",
		"in-progress": "🔵",
		paused: "🟡",
		blocked: "🚫",
		complete: "✅",
	};
	const emoji = t.emoji ?? "🛠️";
	const icon = icons[t.status] ?? "🔵";

	let msg = `${emoji} ${bold(t.title)}\n`;
	msg += `${BAR}\n`;
	msg += labelValue("Status", `${icon} ${t.status}`) + "\n";

	if (t.progress !== undefined) {
		msg += labelValue("Progress", progressBar(t.progress)) + "\n";
	}
	if (t.elapsed) msg += labelValue("Elapsed", code(t.elapsed)) + "\n";
	if (t.eta) msg += labelValue("ETA", code(t.eta)) + "\n";

	if (t.details && t.details.length > 0) {
		msg += `${BAR}\n`;
		for (const d of t.details) {
			msg += `  ${d}\n`;
		}
	}

	if (t.metrics && Object.keys(t.metrics).length > 0) {
		msg += `${BAR}\n`;
		for (const [k, v] of Object.entries(t.metrics)) {
			msg += labelValue(k, code(v)) + "\n";
		}
	}
	return msg;
}

// ── CI Pipeline ─────────────────────────────────────────────────────

export interface CIPipeline {
	workflow: string;
	runNumber: number;
	branch: string;
	event: string;
	jobs: Array<{ name: string; status: string; duration?: string }>;
	triggeredBy?: string;
	url?: string;
}

export function ciPipeline(p: CIPipeline): string {
	let msg = `🔄 ${bold(p.workflow)}\n`;
	msg += `${BAR}\n`;
	msg += labelValue("Run", `#${p.runNumber}`) + "\n";
	msg += labelValue("Branch", code(p.branch)) + "\n";
	msg += labelValue("Trigger", p.event) + "\n";
	if (p.triggeredBy) msg += labelValue("By", code(p.triggeredBy)) + "\n";
	msg += `${BAR}\n`;

	for (const j of p.jobs) {
		const dur = j.duration ? ` (${j.duration})` : "";
		msg += `${jobIcon(j.status)} ${code(j.name)}${dur}\n`;
	}

	if (p.url) msg += `\n${link(p.url, "View Pipeline")}`;
	return msg;
}

// ── Agent Session Card ──────────────────────────────────────────────

export interface SessionCard {
	session: string;
	branch?: string;
	model?: string;
	turns?: number;
	tokens?: { used: number; total: number };
	duration?: string;
	status: "idle" | "streaming" | "tool-exec" | "waiting";
}

export function sessionCard(s: SessionCard): string {
	const statusIcons: Record<string, string> = {
		idle: "⏸️",
		streaming: "💬",
		"tool-exec": "🔧",
		waiting: "⏳",
	};
	const icon = statusIcons[s.status] ?? "🤖";

	let msg = `${icon} ${bold("Agent Session")}\n`;
	msg += `${BAR}\n`;
	msg += labelValue("Session", code(s.session)) + "\n";
	if (s.branch) msg += labelValue("Branch", code(s.branch)) + "\n";
	if (s.model) msg += labelValue("Model", italic(s.model)) + "\n";
	if (s.turns !== undefined) msg += labelValue("Turns", `${s.turns}`) + "\n";
	if (s.tokens) {
		const pct = Math.round((s.tokens.used / s.tokens.total) * 100);
		msg +=
			labelValue(
				"Tokens",
				`${s.tokens.used.toLocaleString()} / ${s.tokens.total.toLocaleString()} (${pct}%)`,
			) + "\n";
	}
	if (s.duration) msg += labelValue("Duration", code(s.duration)) + "\n";
	return msg;
}

// ── Alert / Error ───────────────────────────────────────────────────

export interface AlertCard {
	level: "info" | "warning" | "error" | "critical";
	title: string;
	source?: string;
	detail?: string;
	action?: string;
	stack?: string;
}

export function alertCard(a: AlertCard): string {
	const icons: Record<string, string> = {
		info: "ℹ️",
		warning: "⚠️",
		error: "🚨",
		critical: "🛑",
	};
	const icon = icons[a.level] ?? "📢";

	let msg = `${icon} ${bold(a.title)}\n`;
	msg += `${BAR}\n`;
	if (a.source) msg += labelValue("Source", code(a.source)) + "\n";
	if (a.detail) msg += labelValue("Detail", italic(a.detail)) + "\n";
	if (a.action) msg += labelValue("Action", bold(a.action)) + "\n";
	if (a.stack) {
		msg += `\n${code(a.stack.slice(0, 300))}\n`;
	}
	return msg;
}

// ── Factory / Orchestrator ──────────────────────────────────────────

export interface FactoryJobCard {
	jobId: string;
	mode: "single" | "chain" | "parallel";
	status: "pending" | "running" | "success" | "failure" | "cancelled";
	agent?: string;
	task?: string;
	environment?: string;
	duration?: string;
	worker?: string;
}

export function factoryJobCard(j: FactoryJobCard): string {
	const icons: Record<string, string> = {
		pending: "⏳",
		running: "🔵",
		success: "✅",
		failure: "❌",
		cancelled: "⚪",
	};
	const icon = icons[j.status] ?? "❓";

	let msg = `${icon} ${bold("Factory Job")} ${code(j.jobId)}\n`;
	msg += `${BAR}\n`;
	msg += labelValue("Status", `${icon} ${j.status}`) + "\n";
	msg += labelValue("Mode", code(j.mode)) + "\n";
	if (j.agent) msg += labelValue("Agent", code(j.agent)) + "\n";
	if (j.task) msg += labelValue("Task", italic(j.task.slice(0, 120))) + "\n";
	if (j.environment) msg += labelValue("Env", code(j.environment)) + "\n";
	if (j.worker) msg += labelValue("Worker", code(j.worker)) + "\n";
	if (j.duration) msg += labelValue("Duration", code(j.duration)) + "\n";
	return msg;
}

// ── Multi-Item Summaries ────────────────────────────────────────────

export interface SummaryHeader {
	title: string;
	subtitle?: string;
	items?: Array<{ icon: string; label: string; value: string }>;
}

export function summaryHeader(s: SummaryHeader): string {
	let msg = `${bold(s.title)}\n`;
	if (s.subtitle) msg += `${italic(s.subtitle)}\n`;
	msg += `${BAR}\n`;
	if (s.items) {
		for (const item of s.items) {
			msg += `${item.icon} ${labelValue(item.label, code(item.value))}\n`;
		}
	}
	return msg;
}

// ── Quick Acknowledgment ────────────────────────────────────────────

export function ack(text: string, emoji = "✅"): string {
	return `${emoji} ${italic(text)}`;
}

// ── Decision Card ───────────────────────────────────────────────────

export interface DecisionCard {
	question: string;
	context: string;
	options: string[];
	risk: "low" | "medium" | "high" | "critical";
	command?: string;
	reason?: string;
}

export function decisionCard(d: DecisionCard): string {
	const riskIcons: Record<string, string> = {
		low: "🟢",
		medium: "🟡",
		high: "🟠",
		critical: "🔴",
	};

	let msg = `🛑 ${bold("Decision Required")}\n`;
	msg += `${BAR}\n`;
	msg += labelValue("Risk", `${riskIcons[d.risk]} ${d.risk}`) + "\n";
	msg += labelValue("Context", italic(d.context)) + "\n";
	if (d.command) msg += labelValue("Command", code(d.command)) + "\n";
	if (d.reason) msg += labelValue("Reason", d.reason) + "\n";
	msg += `\n${bold("❓ " + d.question)}\n`;
	msg += `\n${d.options.map((o, i) => `${i + 1}. ${o}`).join("\n")}`;
	return msg;
}

// ── Composite: Daily Standup / Status Roundup ───────────────────────

export interface StandupCard {
	date: string;
	agent: string;
	workedOn: string[];
	nextUp: string[];
	blockers: string[];
	metrics?: Record<string, string>;
}

export function standupCard(s: StandupCard): string {
	let msg = `📊 ${bold("Status Roundup")}\n`;
	msg += `${BAR}\n`;
	msg += labelValue("Date", code(s.date)) + "\n";
	msg += labelValue("Agent", code(s.agent)) + "\n";
	msg += `${BAR}\n`;

	msg += `${bold("✅ Completed")}\n`;
	for (const item of s.workedOn) {
		msg += `  • ${item}\n`;
	}
	msg += `\n${bold("🔄 Next")}\n`;
	for (const item of s.nextUp) {
		msg += `  • ${item}\n`;
	}
	if (s.blockers.length > 0) {
		msg += `\n${bold("🚫 Blockers")}\n`;
		for (const item of s.blockers) {
			msg += `  • ${item}\n`;
		}
	}
	if (s.metrics && Object.keys(s.metrics).length > 0) {
		msg += `${BAR}\n`;
		for (const [k, v] of Object.entries(s.metrics)) {
			msg += labelValue(k, code(v)) + "\n";
		}
	}
	return msg;
}

// ── Diff / Change Summary ───────────────────────────────────────────

export interface DiffSummary {
	title: string;
	stats: { added: number; removed: number; files: number };
	highlights: string[];
	url?: string;
}

export function diffSummary(d: DiffSummary): string {
	let msg = `📝 ${bold(d.title)}\n`;
	msg += `${BAR}\n`;
	msg +=
		labelValue(
			"Changes",
			`+${d.stats.added} −${d.stats.removed} in ${d.stats.files} files`,
		) + "\n";
	if (d.highlights.length > 0) {
		msg += `${BAR}\n`;
		for (const h of d.highlights) {
			msg += `  • ${h}\n`;
		}
	}
	if (d.url) msg += `\n${link(d.url, "View Diff")}`;
	return msg;
}

// ── Quick Pickers (for telegram_ask buttons) ────────────────────────

export function quickActions(label: string, actions: string[]): string {
	return `${bold(label)}\n${actions.map((a, i) => `${i + 1}. ${code(a)}`).join("  \n")}`;
}

export function yesNoExplain(prompt: string): string {
	return `❓ ${bold(prompt)}\n\nPick an option below:`;
}

// ── Build Notification (main dispatch for telegram_notify tool) ────

export interface NotifyInput {
	kind:
		| "issue"
		| "pr"
		| "task"
		| "pipeline"
		| "session"
		| "alert"
		| "factory-job"
		| "standup"
		| "diff"
		| "decision"
		| "ack";
	issueNumber?: number;
	issueTitle?: string;
	issueState?: "open" | "closed";
	issueStatus?: string;
	issueAssignee?: string;
	issueLabels?: string[];
	issueMilestone?: string;
	issueRepoOwner?: string;
	issueRepoName?: string;
	issueBranch?: string;
	issuePRNumber?: number;
	issuePRStatus?: string;
	issueUrl?: string;
	prNumber?: number;
	prTitle?: string;
	prState?: "open" | "closed" | "merged" | "draft";
	prAuthor?: string;
	prBase?: string;
	prHead?: string;
	prRepoOwner?: string;
	prRepoName?: string;
	prCIPassed?: number;
	prCIFailed?: number;
	prCITotal?: number;
	prCIStatus?: string;
	prReviewsApproved?: number;
	prReviewsRequested?: number;
	prReviewsChanges?: number;
	prFilesAdded?: number;
	prFilesRemoved?: number;
	prFilesChanged?: number;
	prBreaking?: boolean;
	prDraft?: boolean;
	prUrl?: string;
	taskTitle?: string;
	taskEmoji?: string;
	taskStatus?: "started" | "in-progress" | "paused" | "blocked" | "complete";
	taskProgress?: number;
	taskElapsed?: string;
	taskEta?: string;
	taskDetails?: string[];
	taskMetrics?: Record<string, string>;
	pipelineWorkflow?: string;
	pipelineRunNumber?: number;
	pipelineBranch?: string;
	pipelineEvent?: string;
	pipelineJobs?: Array<{ name: string; status: string; duration?: string }>;
	pipelineTriggeredBy?: string;
	pipelineUrl?: string;
	sessionName?: string;
	sessionBranch?: string;
	sessionModel?: string;
	sessionTurns?: number;
	sessionTokensUsed?: number;
	sessionTokensTotal?: number;
	sessionDuration?: string;
	sessionStatus?: "idle" | "streaming" | "tool-exec" | "waiting";
	alertLevel?: "info" | "warning" | "error" | "critical";
	alertTitle?: string;
	alertSource?: string;
	alertDetail?: string;
	alertAction?: string;
	alertStack?: string;
	jobId?: string;
	jobMode?: "single" | "chain" | "parallel";
	jobStatus?: "pending" | "running" | "success" | "failure" | "cancelled";
	jobAgent?: string;
	jobTask?: string;
	jobEnvironment?: string;
	jobDuration?: string;
	jobWorker?: string;
	standupDate?: string;
	standupAgent?: string;
	standupWorkedOn?: string[];
	standupNextUp?: string[];
	standupBlockers?: string[];
	standupMetrics?: Record<string, string>;
	diffTitle?: string;
	diffAdded?: number;
	diffRemoved?: number;
	diffFiles?: number;
	diffHighlights?: string[];
	diffUrl?: string;
	decisionQuestion?: string;
	decisionContext?: string;
	decisionOptions?: string[];
	decisionRisk?: "low" | "medium" | "high" | "critical";
	decisionCommand?: string;
	decisionReason?: string;
	ackText?: string;
	ackEmoji?: string;
}

export function buildNotification(input: NotifyInput): string {
	switch (input.kind) {
		case "issue":
			return issueCard({
				number: input.issueNumber ?? 0,
				title: input.issueTitle ?? "Unknown",
				state: input.issueState ?? "open",
				status: input.issueStatus,
				assignee: input.issueAssignee,
				labels: input.issueLabels,
				milestone: input.issueMilestone,
				repo: {
					owner: input.issueRepoOwner ?? "unknown",
					name: input.issueRepoName ?? "unknown",
				},
				branch: input.issueBranch,
				pr: input.issuePRNumber
					? {
							number: input.issuePRNumber,
							status: input.issuePRStatus ?? "unknown",
						}
					: undefined,
				url: input.issueUrl,
			});

		case "pr":
			return prCard({
				number: input.prNumber ?? 0,
				title: input.prTitle ?? "Unknown",
				state: input.prState ?? "open",
				author: input.prAuthor ?? "unknown",
				base: input.prBase ?? "main",
				head: input.prHead ?? "unknown",
				repo: {
					owner: input.prRepoOwner ?? "unknown",
					name: input.prRepoName ?? "unknown",
				},
				ci:
					input.prCITotal !== undefined
						? {
								passed: input.prCIPassed ?? 0,
								failed: input.prCIFailed ?? 0,
								total: input.prCITotal,
								status: input.prCIStatus,
							}
						: undefined,
				reviews:
					input.prReviewsApproved !== undefined ||
					input.prReviewsRequested !== undefined ||
					input.prReviewsChanges !== undefined
						? {
								approved: input.prReviewsApproved ?? 0,
								requested: input.prReviewsRequested ?? 0,
								changesRequested: input.prReviewsChanges ?? 0,
							}
						: undefined,
				files:
					input.prFilesChanged !== undefined
						? {
								added: input.prFilesAdded ?? 0,
								removed: input.prFilesRemoved ?? 0,
								changed: input.prFilesChanged,
							}
						: undefined,
				breaking: input.prBreaking,
				draft: input.prDraft,
				url: input.prUrl,
			});

		case "task":
			return taskProgress({
				title: input.taskTitle ?? "Task",
				emoji: input.taskEmoji,
				status: input.taskStatus ?? "started",
				progress: input.taskProgress,
				elapsed: input.taskElapsed,
				eta: input.taskEta,
				details: input.taskDetails,
				metrics: input.taskMetrics,
			});

		case "pipeline":
			return ciPipeline({
				workflow: input.pipelineWorkflow ?? "CI",
				runNumber: input.pipelineRunNumber ?? 0,
				branch: input.pipelineBranch ?? "unknown",
				event: input.pipelineEvent ?? "push",
				jobs: input.pipelineJobs ?? [],
				triggeredBy: input.pipelineTriggeredBy,
				url: input.pipelineUrl,
			});

		case "session":
			return sessionCard({
				session: input.sessionName ?? "unknown",
				branch: input.sessionBranch,
				model: input.sessionModel,
				turns: input.sessionTurns,
				tokens:
					input.sessionTokensTotal !== undefined
						? {
								used: input.sessionTokensUsed ?? 0,
								total: input.sessionTokensTotal,
							}
						: undefined,
				duration: input.sessionDuration,
				status: input.sessionStatus ?? "idle",
			});

		case "alert":
			return alertCard({
				level: input.alertLevel ?? "info",
				title: input.alertTitle ?? "Alert",
				source: input.alertSource,
				detail: input.alertDetail,
				action: input.alertAction,
				stack: input.alertStack,
			});

		case "factory-job":
			return factoryJobCard({
				jobId: input.jobId ?? "unknown",
				mode: input.jobMode ?? "single",
				status: input.jobStatus ?? "pending",
				agent: input.jobAgent,
				task: input.jobTask,
				environment: input.jobEnvironment,
				duration: input.jobDuration,
				worker: input.jobWorker,
			});

		case "standup":
			return standupCard({
				date: input.standupDate ?? "unknown",
				agent: input.standupAgent ?? "pi",
				workedOn: input.standupWorkedOn ?? [],
				nextUp: input.standupNextUp ?? [],
				blockers: input.standupBlockers ?? [],
				metrics: input.standupMetrics,
			});

		case "diff":
			return diffSummary({
				title: input.diffTitle ?? "Changes",
				stats: {
					added: input.diffAdded ?? 0,
					removed: input.diffRemoved ?? 0,
					files: input.diffFiles ?? 0,
				},
				highlights: input.diffHighlights ?? [],
				url: input.diffUrl,
			});

		case "decision":
			return decisionCard({
				question: input.decisionQuestion ?? "Proceed?",
				context: input.decisionContext ?? "",
				options: input.decisionOptions ?? ["Yes", "No"],
				risk: input.decisionRisk ?? "medium",
				command: input.decisionCommand,
				reason: input.decisionReason,
			});

		case "ack":
			return ack(input.ackText ?? "Done", input.ackEmoji);

		default:
			return "Unknown notification kind";
	}
}
