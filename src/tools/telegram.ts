/**
 * pi-telegram-bridge — Tool Schemas
 *
 * Tool parameter schemas and metadata. Execute functions are wired in
 * index.ts so they can capture the pi ExtensionAPI via closure.
 */
import { Type } from "typebox";

// ── Rich Notification Kind ─────────────────────────────────────────
// Agent picks a "kind" and fills the matching fields.
// The telegram_notify tool formats it with templates.ts and sends.

export const notifySchema = Type.Object({
	kind: Type.Union([
		Type.Literal("issue"),
		Type.Literal("pr"),
		Type.Literal("task"),
		Type.Literal("pipeline"),
		Type.Literal("session"),
		Type.Literal("alert"),
		Type.Literal("factory-job"),
		Type.Literal("standup"),
		Type.Literal("diff"),
		Type.Literal("decision"),
		Type.Literal("ack"),
	]),

	// ── Issue fields ─────────────────────────────────────
	issueNumber: Type.Optional(Type.Number()),
	issueTitle: Type.Optional(Type.String()),
	issueState: Type.Optional(
		Type.Union([Type.Literal("open"), Type.Literal("closed")]),
	),
	issueStatus: Type.Optional(Type.String()),
	issueAssignee: Type.Optional(Type.String()),
	issueLabels: Type.Optional(Type.Array(Type.String())),
	issueMilestone: Type.Optional(Type.String()),
	issueRepoOwner: Type.Optional(Type.String()),
	issueRepoName: Type.Optional(Type.String()),
	issueBranch: Type.Optional(Type.String()),
	issuePRNumber: Type.Optional(Type.Number()),
	issuePRStatus: Type.Optional(Type.String()),
	issueUrl: Type.Optional(Type.String()),

	// ── PR fields ────────────────────────────────────────
	prNumber: Type.Optional(Type.Number()),
	prTitle: Type.Optional(Type.String()),
	prState: Type.Optional(
		Type.Union([
			Type.Literal("open"),
			Type.Literal("closed"),
			Type.Literal("merged"),
			Type.Literal("draft"),
		]),
	),
	prAuthor: Type.Optional(Type.String()),
	prBase: Type.Optional(Type.String()),
	prHead: Type.Optional(Type.String()),
	prRepoOwner: Type.Optional(Type.String()),
	prRepoName: Type.Optional(Type.String()),
	prCIPassed: Type.Optional(Type.Number()),
	prCIFailed: Type.Optional(Type.Number()),
	prCITotal: Type.Optional(Type.Number()),
	prCIStatus: Type.Optional(Type.String()),
	prReviewsApproved: Type.Optional(Type.Number()),
	prReviewsRequested: Type.Optional(Type.Number()),
	prReviewsChanges: Type.Optional(Type.Number()),
	prFilesAdded: Type.Optional(Type.Number()),
	prFilesRemoved: Type.Optional(Type.Number()),
	prFilesChanged: Type.Optional(Type.Number()),
	prBreaking: Type.Optional(Type.Boolean()),
	prDraft: Type.Optional(Type.Boolean()),
	prUrl: Type.Optional(Type.String()),

	// ── Task fields ──────────────────────────────────────
	taskTitle: Type.Optional(Type.String()),
	taskEmoji: Type.Optional(Type.String()),
	taskStatus: Type.Optional(
		Type.Union([
			Type.Literal("started"),
			Type.Literal("in-progress"),
			Type.Literal("paused"),
			Type.Literal("blocked"),
			Type.Literal("complete"),
		]),
	),
	taskProgress: Type.Optional(Type.Number()),
	taskElapsed: Type.Optional(Type.String()),
	taskEta: Type.Optional(Type.String()),
	taskDetails: Type.Optional(Type.Array(Type.String())),
	taskMetrics: Type.Optional(Type.Record(Type.String(), Type.String())),

	// ── Pipeline fields ──────────────────────────────────
	pipelineWorkflow: Type.Optional(Type.String()),
	pipelineRunNumber: Type.Optional(Type.Number()),
	pipelineBranch: Type.Optional(Type.String()),
	pipelineEvent: Type.Optional(Type.String()),
	pipelineJobs: Type.Optional(
		Type.Array(
			Type.Object({
				name: Type.String(),
				status: Type.String(),
				duration: Type.Optional(Type.String()),
			}),
		),
	),
	pipelineTriggeredBy: Type.Optional(Type.String()),
	pipelineUrl: Type.Optional(Type.String()),

	// ── Session fields ───────────────────────────────────
	sessionName: Type.Optional(Type.String()),
	sessionBranch: Type.Optional(Type.String()),
	sessionModel: Type.Optional(Type.String()),
	sessionTurns: Type.Optional(Type.Number()),
	sessionTokensUsed: Type.Optional(Type.Number()),
	sessionTokensTotal: Type.Optional(Type.Number()),
	sessionDuration: Type.Optional(Type.String()),
	sessionStatus: Type.Optional(
		Type.Union([
			Type.Literal("idle"),
			Type.Literal("streaming"),
			Type.Literal("tool-exec"),
			Type.Literal("waiting"),
		]),
	),

	// ── Alert fields ─────────────────────────────────────
	alertLevel: Type.Optional(
		Type.Union([
			Type.Literal("info"),
			Type.Literal("warning"),
			Type.Literal("error"),
			Type.Literal("critical"),
		]),
	),
	alertTitle: Type.Optional(Type.String()),
	alertSource: Type.Optional(Type.String()),
	alertDetail: Type.Optional(Type.String()),
	alertAction: Type.Optional(Type.String()),
	alertStack: Type.Optional(Type.String()),

	// ── Factory job fields ───────────────────────────────
	jobId: Type.Optional(Type.String()),
	jobMode: Type.Optional(
		Type.Union([
			Type.Literal("single"),
			Type.Literal("chain"),
			Type.Literal("parallel"),
		]),
	),
	jobStatus: Type.Optional(
		Type.Union([
			Type.Literal("pending"),
			Type.Literal("running"),
			Type.Literal("success"),
			Type.Literal("failure"),
			Type.Literal("cancelled"),
		]),
	),
	jobAgent: Type.Optional(Type.String()),
	jobTask: Type.Optional(Type.String()),
	jobEnvironment: Type.Optional(Type.String()),
	jobDuration: Type.Optional(Type.String()),
	jobWorker: Type.Optional(Type.String()),

	// ── Standup fields ───────────────────────────────────
	standupDate: Type.Optional(Type.String()),
	standupAgent: Type.Optional(Type.String()),
	standupWorkedOn: Type.Optional(Type.Array(Type.String())),
	standupNextUp: Type.Optional(Type.Array(Type.String())),
	standupBlockers: Type.Optional(Type.Array(Type.String())),
	standupMetrics: Type.Optional(Type.Record(Type.String(), Type.String())),

	// ── Diff fields ──────────────────────────────────────
	diffTitle: Type.Optional(Type.String()),
	diffAdded: Type.Optional(Type.Number()),
	diffRemoved: Type.Optional(Type.Number()),
	diffFiles: Type.Optional(Type.Number()),
	diffHighlights: Type.Optional(Type.Array(Type.String())),
	diffUrl: Type.Optional(Type.String()),

	// ── Decision fields ──────────────────────────────────
	decisionQuestion: Type.Optional(Type.String()),
	decisionContext: Type.Optional(Type.String()),
	decisionOptions: Type.Optional(Type.Array(Type.String())),
	decisionRisk: Type.Optional(
		Type.Union([
			Type.Literal("low"),
			Type.Literal("medium"),
			Type.Literal("high"),
			Type.Literal("critical"),
		]),
	),
	decisionCommand: Type.Optional(Type.String()),
	decisionReason: Type.Optional(Type.String()),

	// ── Ack fields ───────────────────────────────────────
	ackText: Type.Optional(Type.String()),
	ackEmoji: Type.Optional(Type.String()),
});

export const sendPhotoSchema = Type.Object({
	photoPath: Type.String({ description: "Local file path or remote URL of the photo to send" }),
	caption: Type.Optional(Type.String({ description: "Optional caption text (HTML formatting supported)" })),
});

export const listenSchema = Type.Object({});

export const sendSchema = Type.Object({ message: Type.String() });

export const askSchema = Type.Object({
	question: Type.String(),
	options: Type.Optional(Type.Array(Type.String())),
	timeoutMinutes: Type.Optional(Type.Number()),
});

export const statusSchema = Type.Object({});

export const overrideSchema = Type.Object({
	command: Type.String(),
	reason: Type.String(),
	context: Type.Optional(Type.String()),
	options: Type.Optional(Type.Array(Type.String())),
	timeoutMinutes: Type.Optional(Type.Number()),
});
