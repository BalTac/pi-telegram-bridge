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

// ── Messaging ───────────────────────────────────────────────────────

export async function sendMsg(
	text: string,
	replyMarkup?: object,
	parseMode: "Markdown" | "HTML" | undefined = undefined,
): Promise<number> {
	const body: Record<string, unknown> = {
		chat_id: getChatId(),
		text,
		parse_mode: parseMode,
	};
	if (replyMarkup) body.reply_markup = JSON.stringify(replyMarkup);
	try {
		const r = (await telegramApi("sendMessage", body)) as {
			ok: boolean;
			result: { message_id: number };
		};
		return r.result.message_id;
	} catch (e: unknown) {
		// Retry without parse_mode if formatting caused a 400 parse error
		const msg = e instanceof Error ? e.message : String(e);
		if (parseMode && msg.includes("400") && (msg.includes("parse") || msg.includes("entity"))) {
			delete body.parse_mode;
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

export async function pollUpdates(
	token: string,
	chatId: string,
	botId: number | null,
	lastUpdateId: number,
	signal: AbortSignal,
	onMessage: (text: string) => void,
	onPhoto: (photoId: string, caption?: string) => void,
	onVoice: (fileId: string, duration?: number) => void,
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
					message?: {
						message_id: number;
						chat: { id: number };
						from?: { id: number; is_bot?: boolean };
						text?: string;
						photo?: Array<{ file_id: string; file_unique_id: string; width: number; height: number }>;
						voice?: { file_id: string; file_unique_id: string; duration: number; mime_type?: string };
						caption?: string;
					};
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
						onVoice(u.message.voice.file_id, u.message.voice.duration);
						continue;
					}
					// Photo message
					if (u.message.photo && u.message.photo.length > 0) {
						const largest = u.message.photo[u.message.photo.length - 1];
						onPhoto(largest.file_id, u.message.caption);
						continue;
					}
					// Text message
					if (u.message.text) {
						onMessage(u.message.text);
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
