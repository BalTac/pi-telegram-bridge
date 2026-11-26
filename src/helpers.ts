/**
 * pi-telegram-bridge — Telegram API Helpers
 */
const BASE_URL = "https://api.telegram.org/bot";

// ── Config ──────────────────────────────────────────────────────────

export function getToken(): string {
	const tok = process.env.TELEGRAM_BOT_TOKEN;
	if (!tok) throw new Error("TELEGRAM_BOT_TOKEN not set");
	return tok;
}

export function getChatId(): string {
	const id = process.env.TELEGRAM_CHAT_ID;
	if (!id) throw new Error("TELEGRAM_CHAT_ID not set");
	return id;
}

// ── API ─────────────────────────────────────────────────────────────

export async function telegramApi(
	method: string,
	body: Record<string, unknown>,
): Promise<unknown> {
	const url = `${BASE_URL}${getToken()}/${method}`;
	const res = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		throw new Error(`Telegram API ${res.status}: ${await res.text()}`);
	}
	return res.json();
}

// ── Formattazione ───────────────────────────────────────────────────

const TAG_RE =
	/<\/?(?:b|strong|i|em|u|ins|s|strike|del|code|pre|a|blockquote|tg-spoiler|span)\b[^>]*>/i;

/** Il testo usa tag che Telegram conosce? Se sì, va mandato con parse_mode HTML. */
export function looksLikeHtml(text: string): boolean {
	return TAG_RE.test(text);
}

/**
 * Lascia i tag veri e trasforma in entità i `<` e le `&` che non lo sono: così un
 * messaggio con dentro "a < b" non fa fallire la consegna, e i tag renderizzati
 * non finiscono a schermo come testo.
 */
export function sanitizeHtml(text: string): string {
	return text
		.replace(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g, "&amp;")
		.replace(/<(?![a-zA-Z/!])/g, "&lt;");
}

// ── Messaging ───────────────────────────────────────────────────────

export async function sendMsg(
	text: string,
	replyMarkup?: object,
	parseMode: "Markdown" | "HTML" | undefined = undefined,
): Promise<number> {
	// Interprete flessibile: se il testo contiene tag HTML e nessuno ha chiesto un
	// parse_mode esplicito, si manda in HTML. Se Telegram lo rifiuta, si riprova
	// in testo puro senza perdere il messaggio.
	const mode = parseMode ?? (looksLikeHtml(text) ? "HTML" : undefined);
	const body: Record<string, unknown> = {
		chat_id: getChatId(),
		text: mode === "HTML" ? sanitizeHtml(text) : text,
	};
	if (mode) body.parse_mode = mode;
	if (replyMarkup) body.reply_markup = JSON.stringify(replyMarkup);
	try {
		const r = (await telegramApi("sendMessage", body)) as {
			ok: boolean;
			result: { message_id: number };
		};
		return r.result.message_id;
	} catch (e: unknown) {
		// Retry senza parse_mode se la formattazione ha causato un 400
		const msg = e instanceof Error ? e.message : String(e);
		if (mode && msg.includes("400") && (msg.includes("parse") || msg.includes("entity"))) {
			delete body.parse_mode;
			body.text = text;
			const r2 = (await telegramApi("sendMessage", body)) as {
				ok: boolean;
				result: { message_id: number };
			};
			return r2.result.message_id;
		}
		throw e;
	}}

// ── Photo / File Support ────────────────────────────────────────────

/**
 * Get a Telegram file URL for downloading.
 * Returns { file_path } from the getFile API.
 */
export async function getFileUrl(fileId: string): Promise<string | null> {
	const token = getToken();
	try {
		const res = await fetch(
			`${BASE_URL}${token}/getFile`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ file_id: fileId }),
			},
		);
		if (!res.ok) return null;
		const data = (await res.json()) as {
			ok: boolean;
			result: { file_path: string };
		};
		if (!data.ok || !data.result?.file_path) return null;
		return `https://api.telegram.org/file/bot${token}/${data.result.file_path}`;
	} catch {
		return null;
	}
}

/**
 * Download a Telegram file to a local path.
 * Returns the file path on success, null on failure.
 * Creates parent directories automatically.
 */
export async function downloadFile(fileId: string, destPath: string): Promise<string | null> {
	try {
		const fileUrl = await getFileUrl(fileId);
		if (!fileUrl) return null;
		const res = await fetch(fileUrl);
		if (!res.ok) return null;
		const buffer = Buffer.from(await res.arrayBuffer());
		const path = await import("node:path");
		const fsPromises = await import("node:fs/promises");
		const dir = path.dirname(destPath);
		await fsPromises.mkdir(dir, { recursive: true });
		await fsPromises.writeFile(destPath, buffer);
		return destPath;
	} catch {
		return null;
	}
}

/**
 * Send a photo to the Telegram chat.
 * Supports sending from a local file path or a remote URL.
 */
export async function sendPhoto(
	photoPath: string,
	caption?: string,
): Promise<number> {
	const fs = await import("node:fs/promises");
	let fileData: Buffer;
	let filename: string;

	// Check if it's a URL
	if (photoPath.startsWith("http://") || photoPath.startsWith("https://")) {
		filename = "photo.jpg";
		const res = await fetch(photoPath);
		if (!res.ok) throw new Error(`Failed to fetch photo: ${res.status}`);
		fileData = Buffer.from(await res.arrayBuffer());
	} else {
		filename = photoPath;
		fileData = await fs.readFile(photoPath);
	}

	const token = getToken();
	const formData = new FormData();
	formData.set("chat_id", getChatId());
	const blob = new Blob([fileData] as any);
	formData.set("photo", blob, filename);
	if (caption) {
		formData.set("caption", caption);
		formData.set("parse_mode", "HTML");
	}

	const url = `${BASE_URL}${token}/sendPhoto`;
	const res = await fetch(url, {
		method: "POST",
		body: formData,
	});

	if (!res.ok) {
		const errText = await res.text();
		// Retry without caption if parse_mode caused a 400
		if (caption && res.status === 400 && (errText.includes("parse") || errText.includes("entity"))) {
			return sendPhoto(photoPath);
		}
		throw new Error(`sendPhoto failed: ${res.status} ${errText}`);
	}

	const data = (await res.json()) as {
		ok: boolean;
		result: { message_id: number };
	};
	return data.result.message_id;
}

/**
 * Send any file as a Telegram document. Local paths only: the point is shipping a
 * file that is already on disk (plans, logs, reports), not proxying the web.
 * Bot API caps documents at 50 MB — say so instead of failing with a 413.
 */
export async function sendFile(filePath: string, caption?: string): Promise<number> {
	const fs = await import("node:fs/promises");
	const path = await import("node:path");
	const stat = await fs.stat(filePath).catch(() => null);
	if (!stat || !stat.isFile()) throw new Error(`not a file: ${filePath}`);
	if (stat.size > 50 * 1024 * 1024) {
		throw new Error(`file too large for Telegram (${Math.round(stat.size / 1048576)} MB, max 50)`);
	}

	const formData = new FormData();
	formData.set("chat_id", getChatId());
	formData.set(
		"document",
		new Blob([await fs.readFile(filePath)] as any),
		path.basename(filePath),
	);
	if (caption) {
		formData.set("caption", caption);
		formData.set("parse_mode", "HTML");
	}

	const token = getToken();
	const res = await fetch(`${BASE_URL}${token}/sendDocument`, { method: "POST", body: formData });
	if (!res.ok) {
		const errText = await res.text();
		// Un parse_mode sbagliato non deve impedire la consegna del file.
		if (caption && res.status === 400 && (errText.includes("parse") || errText.includes("entity"))) {
			return sendFile(filePath);
		}
		throw new Error(`sendFile failed: ${res.status} ${errText}`);
	}

	const data = (await res.json()) as { ok: boolean; result: { message_id: number } };
	return data.result.message_id;
}

// ── Polling ─────────────────────────────────────────────────────────

export async function pollReply(
	sentId: number,
	chatId: string,
	timeoutMs: number,
): Promise<string | null> {
	const token = getToken();
	const deadline = Date.now() + timeoutMs;

	// Drain pending updates to start fresh
	let lastId = 0;
	try {
		const drain = await fetch(`${BASE_URL}${token}/getUpdates`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ timeout: 0 }),
		});
		if (drain.ok) {
			const d = (await drain.json()) as {
				ok: boolean;
				result: Array<{ update_id: number }>;
			};
			if (d.ok && d.result.length > 0) {
				lastId = d.result[d.result.length - 1].update_id;
			}
		}
	} catch {
		/* ignore drain errors */
	}

	while (Date.now() < deadline) {
		const res = await fetch(`${BASE_URL}${token}/getUpdates`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ offset: lastId + 1, timeout: 5 }),
		});
		if (!res.ok) {
			await new Promise((r) => setTimeout(r, 3000));
			continue;
		}
		const data = (await res.json()) as {
			ok: boolean;
			result: Array<{
				update_id: number;
				message?: {
					message_id: number;
					chat: { id: number };
					text?: string;
				};
				callback_query?: {
					id: string;
					message: { message_id: number; chat: { id: number } };
					data: string;
				};
			}>;
		};
		if (!data.ok) {
			await new Promise((r) => setTimeout(r, 2000));
			continue;
		}
		for (const u of data.result) {
			lastId = u.update_id;
			// Check for text reply
			if (
				u.message &&
				u.message.chat.id === Number(chatId) &&
				u.message.message_id > sentId &&
				u.message.text
			) {
				return u.message.text;
			}
			// Check for callback query (inline button)
			if (
				u.callback_query &&
				u.callback_query.message.chat.id === Number(chatId)
			) {
				await telegramApi("answerCallbackQuery", {
					callback_query_id: u.callback_query.id,
				});
				return u.callback_query.data;
			}
		}
		await new Promise((r) => setTimeout(r, 2000));
	}
	return null; // timeout
}

// ── Listener State ──────────────────────────────────────────────────

export async function getBotId(): Promise<number | null> {
	try {
		const r = (await telegramApi("getMe", {})) as { result: { id: number } };
		return r.result.id;
	} catch {
		return null;
	}
}

export async function seedLastUpdateId(
	lastUpdateId: number,
	signal?: AbortSignal,
): Promise<number> {
	if (lastUpdateId !== 0) return lastUpdateId;
	const token = getToken();
	try {
		const res = await fetch(`${BASE_URL}${token}/getUpdates`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ timeout: 0 }),
			signal,
		});
		if (res.ok) {
			const d = (await res.json()) as {
				ok: boolean;
				result: Array<{ update_id: number }>;
			};
			if (d.ok && d.result.length > 0) {
				return d.result[d.result.length - 1].update_id;
			}
		}
	} catch {
		/* ignore */
	}
	return lastUpdateId;
}

/**
 * The message the human replied to, on Telegram, with the keyboard quote feature.
 * Kept as data: the caller decides what to download and how to describe it.
 */
export interface QuotedMessage {
	/** Message id in the chat, useful to mention it back. */
	messageId: number;
	/** Display name of who wrote the quoted message. */
	from?: string;
	kind: "text" | "photo" | "voice" | "audio" | "video" | "video_note" | "document" | "other";
	/** Text body, or the caption for media. */
	text?: string;
	/** Media to download, when the quote is not text. */
	fileId?: string;
	/** Duration in seconds for voice/audio/video notes. */
	duration?: number;
	/** Original file name, when Telegram sends one (documents). */
	fileName?: string;
}

/** Minimal shape of a Telegram message we care about. */
type TgMessage = {
	message_id: number;
	chat: { id: number };
	from?: { id: number; is_bot?: boolean; first_name?: string; username?: string };
	text?: string;
	caption?: string;
	photo?: Array<{ file_id: string }>;
	voice?: { file_id: string; duration: number };
	audio?: { file_id: string; duration: number; file_name?: string };
	video?: { file_id: string; duration: number; file_name?: string };
	video_note?: { file_id: string; duration: number };
	document?: { file_id: string; file_name?: string };
	reply_to_message?: TgMessage;
};

function displayName(msg: TgMessage | undefined): string | undefined {
	if (!msg?.from) return undefined;
	return msg.from.first_name || msg.from.username || String(msg.from.id);
}

/**
 * Turn `reply_to_message` into a plain object. Pure: no network, no disk.
 * Returns null when the message is not a reply.
 */
export function extractQuote(msg: TgMessage | undefined): QuotedMessage | null {
	const q = msg?.reply_to_message;
	if (!q) return null;
	const base = { messageId: q.message_id, from: displayName(q), text: q.text || q.caption };
	if (q.text) return { ...base, kind: "text" };
	const largest = q.photo?.[q.photo.length - 1];
	if (largest) return { ...base, kind: "photo", fileId: largest.file_id };
	if (q.voice) return { ...base, kind: "voice", fileId: q.voice.file_id, duration: q.voice.duration };
	if (q.audio) return { ...base, kind: "audio", fileId: q.audio.file_id, duration: q.audio.duration, fileName: q.audio.file_name };
	if (q.video) return { ...base, kind: "video", fileId: q.video.file_id, duration: q.video.duration, fileName: q.video.file_name };
	if (q.video_note) return { ...base, kind: "video_note", fileId: q.video_note.file_id, duration: q.video_note.duration };
	if (q.document) return { ...base, kind: "document", fileId: q.document.file_id, fileName: q.document.file_name };
	return { ...base, kind: "other" };
}

export async function pollUpdates(
	token: string,
	chatId: string,
	botId: number | null,
	lastUpdateId: number,
	signal: AbortSignal,
	onMessage: (text: string, quote?: QuotedMessage) => void,
	onPhoto: (photoId: string, caption?: string, quote?: QuotedMessage) => void,
	onVoice: (fileId: string, duration?: number, quote?: QuotedMessage) => void,
	onUpdateId: (id: number) => void,
): Promise<void> {
	while (!signal.aborted) {
		try {
			const res = await fetch(`${BASE_URL}${token}/getUpdates`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ offset: lastUpdateId + 1, timeout: 10 }),
				signal,
			});
			if (!res.ok) {
				await new Promise((r) => setTimeout(r, 3000));
				continue;
			}
			const data = (await res.json()) as {
				ok: boolean;
				result: Array<{
					update_id: number;
					message?: TgMessage;
					callback_query?: unknown;
				}>;
			};
			if (!data.ok) {
				await new Promise((r) => setTimeout(r, 2000));
				continue;
			}
			for (const u of data.result) {
				lastUpdateId = u.update_id;
				onUpdateId(lastUpdateId);
				// Skip callback queries (handled by telegram_ask)
				if (u.callback_query) continue;
				// Process messages from the configured chat, not from our bot
				if (
					u.message &&
					String(u.message.chat.id) === chatId
				) {
					if (u.message.from?.is_bot || u.message.from?.id === botId) {
						continue;
					}
					// Voice note: forwarded to onVoice, which transcribes it (see stt.ts)
					if (u.message.voice) {
						const q = extractQuote(u.message);
						if (q) onVoice(u.message.voice.file_id, u.message.voice.duration, q);
						else onVoice(u.message.voice.file_id, u.message.voice.duration);
						continue;
					}
					// Photo message
					if (u.message.photo && u.message.photo.length > 0) {
						const largest = u.message.photo[u.message.photo.length - 1];
						const q = extractQuote(u.message);
						if (q) onPhoto(largest.file_id, u.message.caption, q);
						else onPhoto(largest.file_id, u.message.caption);
						continue;
					}
					// Text message
					if (u.message.text) {
						const q = extractQuote(u.message);
						if (q) onMessage(u.message.text, q);
						else onMessage(u.message.text);
					}
				}
			}
		} catch (e: unknown) {
			if (e instanceof Error && e.name === "AbortError") break;
			await new Promise((r) => setTimeout(r, 3000));
		}
		await new Promise((r) => setTimeout(r, 5000));
	}
}
