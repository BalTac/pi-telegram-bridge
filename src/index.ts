/**
 * pi-telegram-bridge — Telegram Bot Bridge
 *
 * Tools: telegram_listen, telegram_send, telegram_ask, telegram_override, telegram_status
 * Config: TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID environment variables
 *
 * Starts a background listener on session start that polls for incoming
 * messages and forwards them to the agent as user messages.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	getToken,
	getChatId,
	telegramApi,
	sendMsg,
	sendPhoto,
	sendFile,
	getFileUrl,
	downloadFile,
	pollReply,
	getBotId,
	seedLastUpdateId,
	pollUpdates,
} from "./helpers";
import type { QuotedMessage } from "./helpers";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import {
	listenSchema,
	sendSchema,
	askSchema,
	statusSchema,
	overrideSchema,
	notifySchema,
	sendPhotoSchema,
	sendFileSchema,
	voiceTriggerSchema,
} from "./tools/telegram";
import { commandMenu, handleCommand, isPossibleCommand } from "./commands";
import { transcribe } from "./stt";
import { forwardToAgent, setIdleProbe } from "./forward";
import {
	DEFAULT_PHRASES,
	decideVoiceIntent,
	describeDecision,
	loadPhraseStore,
	loadVoiceConfig,
	phraseStorePath,
	savePhraseStore,
	voiceDirective,
	describeStore,
} from "./voiceIntent";

/** Prepended to forwarded user messages so the agent knows who is talking. */
const ORIGIN_PREFIX = () => process.env.PI_TELEGRAM_ORIGIN_PREFIX ?? "[telegram]";

export default function telegramBridge(pi: ExtensionAPI) {
	let botId: number | null = null;
	let listenerAbort: AbortController | null = null;
	let lastUpdateId = 0;

	// Segnale di avvio: dice quale codice è vivo. Senza, l'unico modo per sapere se
	// una patch è entrata è indovinare — successo il 27/11: processo delle 04:20,
	// correzione delle 05:15, e i tag continuavano ad arrivare a schermo.
	try {
		const logDir = path.join(process.cwd(), "state", "logs");
		fs.mkdirSync(logDir, { recursive: true });
		fs.appendFileSync(
			path.join(logDir, "bridge.log"),
			`[${new Date().toISOString()}] avvio · formattazione automatica · tool senza parse_mode
`,
		);
	} catch {
		// un segnale di avvio non deve mai impedire al ponte di partire
	}

	/**
	 * Voice gate (tiers: phrases → gliclass base/large sidecar). Returns the text to
	 * forward (directive appended) or just the directive, never throws, leaves slash
	 * commands alone.
	 */
	async function voiceSuffix(text: string): Promise<string> {
		if (!text || text.startsWith("/")) return "";
		try {
			const cfg = loadVoiceConfig();
			if (cfg.mode === "off") return "";
			const decision = await decideVoiceIntent(text, cfg);
			return voiceDirective(cfg, decision);
		} catch {
			return "";
		}
	}

	async function withVoiceIntent(text: string): Promise<string> {
		return text + (await voiceSuffix(text));
	}

	/**
	 * The quoted message, resolved. Telegram sends only the reference, so without this
	 * the agent reads the new text and knows nothing about what it answers to.
	 *
	 * Text goes inline; photos, videos and documents are downloaded to the same temp
	 * folder as normal attachments; voice notes are transcribed with the same chain.
	 */
	async function quoteBlock(quote?: QuotedMessage): Promise<string> {
		if (!quote) return "";
		const who = quote.from ? ` di ${quote.from}` : "";
		const head = `↩️ In risposta a${who} (msg ${quote.messageId})`;
		if (quote.kind === "text") {
			const body = (quote.text ?? "").trim();
			const short = body.length > 2000 ? `${body.slice(0, 2000)}…` : body;
			return `${head}:\n${short}\n———\n`;
		}
		if (!quote.fileId) return `${head}: [${quote.kind}]\n———\n`;
		const ext = quote.fileName
			? path.extname(quote.fileName) || ".bin"
			: quote.kind === "photo"
				? ".jpg"
				: quote.kind === "voice"
					? ".ogg"
					: quote.kind === "audio"
						? ".mp3"
						: ".mp4";
		const dir = path.join(os.tmpdir(), "telegram-photos");
		const dest = path.join(dir, `quoted_${quote.messageId}_${Date.now()}${ext}`);
		const got = await downloadFile(quote.fileId, dest);
		if (!got) return `${head}: [${quote.kind} non scaricato]\n———\n`;
		const secs = quote.duration === undefined ? "" : ` ${quote.duration}s`;
		if (quote.kind === "voice" || quote.kind === "audio" || quote.kind === "video_note") {
			const stt = await transcribe(got);
			const words = stt.text
				? `Trascrizione: ${stt.text}`
				: `Trascrizione assente (${stt.error ?? "STT non configurato"}): ascolta il file.`;
			return `${head} — ${quote.kind}${secs}\n${words}\nPath: ${got}\n———\n`;
		}
		const caption = quote.text ? `\nDidascalia: ${quote.text}` : "";
		return `${head} — ${quote.kind}${secs}${caption}\nPath: ${got}\n———\n`;
	}

	// ── Session lifecycle ───────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		// The agent tells us when it is busy; forward.ts needs it before sending,
		// because sendUserMessage() is fire-and-forget and cannot report the busy error.
		setIdleProbe(() => ctx.isIdle());
		// Ensure photo download directory exists
		const { mkdir } = await import("node:fs/promises");
		const photoDir = path.join(os.tmpdir(), "telegram-photos");
		await mkdir(photoDir, { recursive: true }).catch(() => {});
		// Restore lastUpdateId from session state
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "custom" && entry.customType === "tg-last-update") {
				lastUpdateId = (entry.data as { update_id: number }).update_id;
			}
		}
		// Publish the slash-command menu for this bot, so Telegram autocompletes
		// the commands the bridge actually implements. Disable with PI_TELEGRAM_SYNC_MENU=0.
		if (process.env.PI_TELEGRAM_SYNC_MENU !== "0") {
			telegramApi("setMyCommands", { commands: commandMenu() })
				.then(() => console.log(`[telegram] command menu synced (${commandMenu().length})`))
				.catch((e: unknown) =>
					console.warn(`[telegram] command menu sync failed: ${e instanceof Error ? e.message : e}`),
				);
		}
		// Start background listener
		startListener();
	});

	pi.on("session_shutdown", () => {
		listenerAbort?.abort();
		listenerAbort = null;
	});

	// ── Background listener ─────────────────────────────────────────

	async function startListener() {
		if (listenerAbort) return; // already running
		listenerAbort = new AbortController();
		const signal = listenerAbort.signal;
		const token = getToken();
		const chatId = getChatId();

		// Get bot's own ID once to filter out self-messages
		if (!botId) {
			botId = await getBotId();
		}

		// Seed lastUpdateId
		lastUpdateId = await seedLastUpdateId(lastUpdateId, signal);

		// Create photo download directory
		const fsPromises = await import("node:fs/promises");
		const photoDir = path.join(os.tmpdir(), "telegram-photos");
		await fsPromises.mkdir(photoDir, { recursive: true }).catch(() => {});

		// Fire and forget — poll in background
		pollUpdates(
			token,
			chatId,
			botId,
			lastUpdateId,
			signal,
			// onMessage: check for slash commands first, otherwise forward to pi
			async (text: string, quote?: QuotedMessage) => {
				if (isPossibleCommand(text)) {
					const result = await handleCommand(text, pi, true);
					if (result.handled) return; // bridge or agent handled it
					// Unknown command — fall through to forward as regular message
				}
				const quoted = await quoteBlock(quote);
				// ponytail: un prefisso, niente API. Unico modo per far sapere all'agente l'origine.
				await forwardToAgent(
					pi,
					`${ORIGIN_PREFIX()} ${quoted}${await withVoiceIntent(text)}`,
				);
				await sendMsg(
					`👂 Got it! Working on: _${text.slice(0, 100)}_`,
					undefined,
					"Markdown",
				);
			},
			// onPhoto: download and forward photo + caption to pi
			async (photoId: string, caption?: string, quote?: QuotedMessage) => {
				const timestamp = Date.now();
				const filename = `photo_${timestamp}.jpg`;
				const destPath = path.join(photoDir, filename);
				const quoted = await quoteBlock(quote);
				const result = await downloadFile(photoId, destPath);
				if (result) {
					const captionText = caption ? `\n\n📝 Caption: ${caption}` : "";
					await forwardToAgent(
						pi,
						`${quoted}📸 Photo received from Telegram\nPath: ${result}${captionText}\n\nUse read("${result}") to view the image.`,
					);
					await sendMsg("📸 Photo received! Processing...");
				} else {
					await forwardToAgent(
						pi,
						`${quoted}📸 Photo received from Telegram but could not be downloaded.`,
					);
					await sendMsg(
						"⚠️ Could not download your photo. Please check the bot configuration.",
					);
				}
			},
			// onVoice: download the voice note, transcribe it with the configured chain,
			// and forward transcript + path. Providers: see src/stt.ts.
			async (fileId: string, duration?: number, quote?: QuotedMessage) => {
				const timestamp = Date.now();
				const destPath = path.join(photoDir, `voice_${timestamp}.ogg`);
				const quoted = await quoteBlock(quote);
				const result = await downloadFile(fileId, destPath);
				if (!result) {
					await forwardToAgent(pi, `${quoted}🎙️ Voice received but could not be downloaded.`);
					return;
				}
				const stt = await transcribe(result);
				const seconds = duration ?? "?";
				// Il gate voce vale anche qui: una vocale che dice "rispondimi a voce" deve
				// portarsi dietro la direttiva, altrimenti la richiesta resta implicita.
				const intent = stt.text ? await voiceSuffix(stt.text) : "";
				const body = stt.text
					? `🎙️ Voice from Telegram (${seconds}s, transcript via ${stt.provider})\nTranscript: ${stt.text}\nPath: ${result}${intent}`
					: `🎙️ Voice from Telegram (${seconds}s)\nPath: ${result}\n(no transcript: ${stt.error ?? "STT not configured"}. Transcribe the file yourself if you need the words.)`;
				await forwardToAgent(pi, `${ORIGIN_PREFIX()} ${quoted}${body}`);
				await sendMsg(
					stt.text
						? `🎙️ Heard: _${stt.text.slice(0, 120)}_`
						: "🎙️ Voice received (no transcript)",
					undefined,
					"Markdown",
				);
			},
			// onUpdateId: persist offset
			(id: number) => {
				lastUpdateId = id;
				pi.appendEntry("tg-last-update", { update_id: id });
			},
		);
	}

	// ── Tools ───────────────────────────────────────────────────────

	// telegram_listen
	pi.registerTool({
		name: "telegram_listen",
		label: "Telegram Listen",
		description:
			"Check Telegram for any new inbound messages from the human. Returns the latest message text, or indicates no new messages.",
		parameters: listenSchema,
		async execute() {
			try {
				const token = getToken();
				const chatId = getChatId();
				if (!botId) botId = await getBotId();

				const res = await fetch(
					`https://api.telegram.org/bot${token}/getUpdates`,
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ offset: lastUpdateId + 1, timeout: 5 }),
					},
				);
				if (!res.ok)
					return {
						content: [{ type: "text", text: "Could not reach Telegram." }],
						details: { message: "" },
						isError: true,
					};

				const data = (await res.json()) as {
					ok: boolean;
					result: Array<{
						update_id: number;
						message?: {
							message_id: number;
							chat: { id: number };
							from?: { id: number; is_bot?: boolean };
							text?: string;
						};
						callback_query?: unknown;
					}>;
				};
				if (!data.ok)
					return {
						content: [{ type: "text", text: "Telegram API error." }],
						details: { message: "" },
						isError: true,
					};

				for (const u of data.result) {
					lastUpdateId = u.update_id;
					pi.appendEntry("tg-last-update", { update_id: lastUpdateId });
					if (u.callback_query) continue;
					if (u.message && String(u.message.chat.id) === chatId) {
						if (u.message.from?.is_bot || u.message.from?.id === botId)
							continue;
						// Photo message
						if (u.message.photo && u.message.photo.length > 0) {
							const photoId =
								u.message.photo[u.message.photo.length - 1].file_id;
							const caption = u.message.caption || "";
							const timestamp = Date.now();
							const fsPromises = await import("node:fs/promises");
							const photoDirLocal = path.join(os.tmpdir(), "telegram-photos");
							await fsPromises
								.mkdir(photoDirLocal, { recursive: true })
								.catch(() => {});
							const destFile = path.join(
								photoDirLocal,
								`photo_${timestamp}.jpg`,
							);
							const result = await downloadFile(photoId, destFile);
							const captionInfo = caption ? `\nCaption: "${caption}"` : "";
							if (result) {
								return {
									content: [
										{
											type: "text",
											text: `📸 Photo received from Telegram\nPath: ${result}${captionInfo}\n\nUse read("${result}") to view the image.`,
										},
									],
									details: {
										message: caption,
										photoPath: result,
										hasPhoto: true,
									},
								};
							}
							return {
								content: [
									{
										type: "text",
										text: `📸 Photo received from Telegram but could not be downloaded.${captionInfo}`,
									},
								],
								details: {
									message: caption,
									hasPhoto: true,
									downloadFailed: true,
								},
							};
						}
						// Text message
						if (u.message.text) {
							const text = u.message.text;
							// Check for slash commands
							if (isPossibleCommand(text)) {
								const result = await handleCommand(text, pi, false);
								if (result.handled) {
									const label =
										result.type === "bridge"
											? "(handled by bridge)"
											: "(injected to agent)";
									return {
										content: [
											{
												type: "text",
												text: `🔧 Command processed: "${text}" ${label}`,
											},
										],
										details: {
											message: text,
											command: true,
											commandType: result.type,
										},
									};
								}
								// Unknown command — fall through to return as regular message
							}
							return {
								content: [
									{
										type: "text",
										text: `📩 New message: "${text}"${await voiceSuffix(text)}`,
									},
								],
								details: { message: text },
							};
						}
					}
				}
				return {
					content: [{ type: "text", text: "No new messages." }],
					details: { message: "" },
				};
			} catch (e: unknown) {
				return {
					content: [
						{
							type: "text",
							text: `Failed: ${e instanceof Error ? e.message : e}`,
						},
					],
					details: { message: "" },
					isError: true,
				};
			}
		},
	});

	// telegram_send
	pi.registerTool({
		name: "telegram_send",
		label: "Telegram Send",
		description: "Send a one-way message to Telegram. Use for status updates.",
		parameters: sendSchema,
		async execute(_id: string, params: { message: string }) {
			try {
				// Interprete flessibile: sendMsg decide da sé (HTML se ci sono tag,
				// altrimenti testo puro). Forzare "Markdown" qui faceva arrivare i
				// tag HTML a schermo come caratteri.
				const mid = await sendMsg(params.message);
				return {
					content: [{ type: "text", text: `Sent (id:${mid})` }],
					details: {},
				};
			} catch (e: unknown) {
				return {
					content: [
						{
							type: "text",
							text: `Failed: ${e instanceof Error ? e.message : e}`,
						},
					],
					details: {},
					isError: true,
				};
			}
		},
	});

	// telegram_ask
	pi.registerTool({
		name: "telegram_ask",
		label: "Telegram Ask",
		description:
			"Ask a question on Telegram and WAIT for a human reply. BLOCKS until you answer. Use when you need human input.",
		parameters: askSchema,
		async execute(
			_id: string,
			params: {
				question: string;
				options?: string[];
				timeoutMinutes?: number;
			},
		) {
			try {
				const chatId = getChatId();
				const opts = params.options ?? ["Yes", "No", "Explain"];
				const kb = opts.map((o: string) => [{ text: o, callback_data: o }]);
				const timeoutMs = (params.timeoutMinutes ?? 30) * 60000;
				const mid = await sendMsg(
					`❓ *${params.question}*`,
					{
						inline_keyboard: kb,
					},
					"Markdown",
				);
				const reply = await pollReply(mid, chatId, timeoutMs);
				if (!reply) {
					await sendMsg("⏰ No reply. Proceeding autonomously.");
					return {
						content: [
							{ type: "text", text: "Timeout — proceeding autonomously" },
						],
						details: { timedOut: true, answer: "" },
					};
				}
				return {
					content: [{ type: "text", text: `Reply: "${reply}"` }],
					details: { timedOut: false, answer: reply },
				};
			} catch (e: unknown) {
				return {
					content: [
						{
							type: "text",
							text: `Failed: ${e instanceof Error ? e.message : e}`,
						},
					],
					details: { timedOut: false, answer: "" },
					isError: true,
				};
			}
		},
	});

	// telegram_override
	pi.registerTool({
		name: "telegram_override",
		label: "Telegram Override",
		description:
			"Ask a human on Telegram to approve or reject a blocked action. " +
			"Use when the supervisor blocks a dangerous command (force push, " +
			"destructive git ops, file deletion, etc.) and you need human approval. " +
			"Returns the human's choice so you can call supervisor_override or abort.",
		parameters: overrideSchema,
		async execute(
			_id: string,
			params: {
				command: string;
				reason: string;
				context?: string;
				options?: string[];
				timeoutMinutes?: number;
			},
		) {
			try {
				const chatId = getChatId();
				const opts = params.options ?? [
					"Yes, proceed",
					"No, cancel",
					"Explain more",
				];
				const timeoutMs = (params.timeoutMinutes ?? 30) * 60000;

				let message = `🛑 <b>Supervisor blocked an action</b>\n\n`;
				message += `<b>Command:</b> <code>${params.command.slice(0, 200)}</code>\n`;
				message += `<b>Reason:</b> ${params.reason.slice(0, 300)}\n`;
				if (params.context) {
					message += `<b>Context:</b> ${params.context.slice(0, 300)}\n`;
				}
				message += `\n<i>What should I do?</i>`;

				const kb = opts.map((o: string) => [{ text: o, callback_data: o }]);
				const mid = await sendMsg(message, { inline_keyboard: kb }, "HTML");
				const reply = await pollReply(mid, chatId, timeoutMs);

				if (!reply) {
					await sendMsg("⏰ No reply to override request. Aborting action.");
					return {
						content: [
							{
								type: "text",
								text: "Timeout — no human response. Action aborted.",
							},
						],
						details: {
							timedOut: true,
							action: "abort",
							command: params.command,
							choice: "",
						},
					};
				}

				// Map the reply to an action
				const choice = reply.trim();
				let action: string;
				if (choice === opts[0]) {
					action = "proceed";
				} else if (choice === opts[1]) {
					action = "abort";
				} else {
					action = "explain";
				}

				await sendMsg(
					`✅ Choice received: <i>${choice}</i>`,
					undefined,
					"HTML",
				);

				return {
					content: [
						{
							type: "text",
							text: `Human chose: "${choice}" → action: ${action}`,
						},
					],
					details: {
						choice,
						action,
						command: params.command,
						timedOut: false,
					},
				};
			} catch (e: unknown) {
				return {
					content: [
						{
							type: "text",
							text: `Failed: ${e instanceof Error ? e.message : e}`,
						},
					],
					details: {
						timedOut: false,
						action: "",
						command: "",
						choice: "",
					},
					isError: true,
				};
			}
		},
	});

	// telegram_notify — rich formatted notifications
	pi.registerTool({
		name: "telegram_notify",
		label: "Telegram Notify",
		description:
			"Send a rich, well-formatted notification to Telegram. " +
			"Choose a kind: issue, pr, task, pipeline, session, alert, " +
			"factory-job, standup, diff, decision, or ack. " +
			"Fill the matching fields for that kind. " +
			"All other fields are ignored — only provide fields relevant to your chosen kind.",
		parameters: notifySchema,
		async execute(_id: string, params: Record<string, unknown>) {
			try {
				const { buildNotification } = await import("./templates");
				const message = buildNotification(
					params as unknown as import("./templates").NotifyInput,
				);
				const mid = await sendMsg(message, undefined, "HTML");
				return {
					content: [{ type: "text", text: `Notification sent (id:${mid})` }],
					details: {},
				};
			} catch (e: unknown) {
				return {
					content: [
						{
							type: "text",
							text: `Failed: ${e instanceof Error ? e.message : e}`,
						},
					],
					details: {},
					isError: true,
				};
			}
		},
	});

	// telegram_send_photo
	pi.registerTool({
		name: "telegram_send_photo",
		label: "Send Photo",
		description:
			"Send a photo to the Telegram chat. Supports local file paths and remote URLs.",
		parameters: sendPhotoSchema,
		async execute(
			_id: string,
			params: { photoPath: string; caption?: string },
		) {
			try {
				const mid = await sendPhoto(params.photoPath, params.caption);
				return {
					content: [{ type: "text", text: `Photo sent (id:${mid})` }],
					details: { messageId: mid },
				};
			} catch (e: unknown) {
				return {
					content: [
						{
							type: "text",
							text: `Failed to send photo: ${e instanceof Error ? e.message : e}`,
						},
					],
					details: {},
					isError: true,
				};
			}
		},
	});

	// telegram_send_file
	pi.registerTool({
		name: "telegram_send_file",
		label: "Send File",
		description:
			"Send a local file to the Telegram chat as a document (plans, logs, reports). Max 50 MB.",
		parameters: sendFileSchema,
		async execute(_id: string, params: { path: string; caption?: string }) {
			try {
				const mid = await sendFile(params.path, params.caption);
				return {
					content: [{ type: "text", text: `File sent (id:${mid})` }],
					details: { messageId: mid },
				};
			} catch (e: unknown) {
				return {
					content: [
						{
							type: "text",
							text: `Failed to send file: ${e instanceof Error ? e.message : e}`,
						},
					],
					details: {},
					isError: true,
				};
			}
		},
	});

	// telegram_status
	pi.registerTool({
		name: "telegram_status",
		label: "Telegram Status",
		description: "Check if the Telegram bridge is configured and running.",
		parameters: statusSchema,
		async execute() {
			if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
				return {
					content: [
						{
							type: "text",
							text: "Not configured. Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID.",
						},
					],
					details: {},
				};
			}
			try {
				const r = (await telegramApi("getMe", {})) as {
					result: { username: string };
				};
				return {
					content: [
						{
							type: "text",
							text: `Active. Bot: @${r.result.username} (listener: ${listenerAbort ? "🟢 running" : "🔴 stopped"})`,
						},
					],
					details: {},
				};
			} catch {
				return {
					content: [{ type: "text", text: "Token set but unreachable." }],
					details: {},
				};
			}
		},
	});

	// voice_trigger — the agent manages the deterministic phrase list
	pi.registerTool({
		name: "voice_trigger",
		label: "Voice Trigger",
		description:
			"Manage the phrases that make the bridge answer with a voice message. Actions: status (mode, thresholds, sidecar), list/ add/ remove (deterministic phrase list, persisted to disk), test (classify a string and say which tier decided).",
		parameters: voiceTriggerSchema,
		async execute(_toolCallId, params) {
			const action = params.action;
			const cfg = loadVoiceConfig();
			const storePath = phraseStorePath();
			if (action === "add" || action === "remove") {
				const list = (params.phrases ?? []).map((p) => p.trim()).filter(Boolean);
				if (list.length === 0) {
					return {
						content: [{ type: "text", text: "Nessuna frase passata: usa il campo phrases." }],
						details: {},
					};
				}
				const store = loadPhraseStore(storePath);
				if (action === "add") {
					store.extra = [...store.extra, ...list];
					store.disabled = store.disabled.filter(
						(d) => !list.some((p) => p.toLowerCase() === d.toLowerCase()),
					);
				} else {
					const removing = new Set(list.map((p) => p.toLowerCase()));
					const isDefault = (p: string) =>
						DEFAULT_PHRASES.some((d) => d.toLowerCase() === p.toLowerCase());
					store.extra = store.extra.filter((p) => !removing.has(p.toLowerCase()));
					store.disabled = [
						...new Set([
							...store.disabled,
							...list.filter(isDefault),
						]),
					];
				}
				savePhraseStore(store, storePath);
				return {
					content: [
						{
							type: "text",
							text: `${action === "add" ? "Aggiunte" : "Rimosse"}: ${list.join(", ")}\n${describeStore(loadPhraseStore(storePath))}`,
						},
					],
					details: { store: loadPhraseStore(storePath) },
				};
			}
			if (action === "test") {
				const sample = (params.text ?? "").trim();
				if (!sample) {
					return {
						content: [{ type: "text", text: "Serve il campo text." }],
						details: {},
					};
				}
				const decision = await decideVoiceIntent(sample, cfg);
				return {
					content: [
						{ type: "text", text: `"${sample}" → ${describeDecision(decision)}` },
					],
					details: decision,
				};
			}
			if (action === "list") {
				return {
					content: [
						{
							type: "text",
							text: `${cfg.phrases.length} frasi attive (${DEFAULT_PHRASES.length} di default):\n- ${cfg.phrases.join("\n- ")}\n${describeStore(loadPhraseStore(storePath))}`,
						},
					],
					details: { count: cfg.phrases.length, store: loadPhraseStore(storePath) },
				};
			}
			const health = cfg.mode === "off" ? "gate spento" : cfg.url || "senza sidecar (solo frasi)";
			return {
				content: [
					{
						type: "text",
						text: `modalità: ${cfg.mode} · sidecar: ${health} · soglie ${cfg.low}-${cfg.high} · ${cfg.phrases.length} frasi${cfg.mode === "off" ? " (PI_TELEGRAM_VOICE_MODE=off)" : ""}`,
					},
				],
				details: { mode: cfg.mode, url: cfg.url, low: cfg.low, high: cfg.high },
			};
		},
	});
}
