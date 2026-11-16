/**
 * pi-telegram-bridge — Voice intent gate
 *
 * Decides whether an inbound message asks for a spoken answer. Three tiers, from
 * the cheapest to the heaviest, so the same code runs on a Pi 4 and on a laptop
 * with a GPU:
 *
 *   1. deterministic  — user-managed phrase list (the agent saves phrases on request)
 *   2. gliclass-base  — sidecar on the same machine (Pi 5 territory)
 *   3. gliclass-large — sidecar on a stronger box
 *
 * Tiers 2 and 3 are the same HTTP contract (`POST {url}/classify`), so the only
 * difference is which model the sidecar loaded. If the sidecar is missing, slow
 * or down, we degrade to tier 1 — a gate must never block a message.
 *
 * Conservative by design: when in doubt, no voice. A text answer that should
 * have been a voice is a small annoyance; a voice that should have been text
 * interrupts whatever the human is doing.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ── Config ──────────────────────────────────────────────────────────

export type VoiceMode = "off" | "phrases" | "auto";

/**
 * How the backend speaks. `classify` is this repo's sidecar contract
 * (`POST {url}/classify` → `{voice: 0.97}`); `openai` is the standard
 * `/v1/chat/completions` shape, for a system-one model in the cloud or on the LAN
 * (llama.cpp, vLLM, LM Studio, a gateway with a prompt in front); `decision` is the
 * typed-decision contract of the OpenClaw Hybrid Edge Gateway
 * (`POST {url}/v1/decision` → `{winner, confidence, tier, escalated}`).
 */
export type VoiceProvider = "classify" | "openai";

export interface VoiceConfig {
	/** off: never tag. phrases: only the list. auto: list then sidecar (if configured). */
	mode: VoiceMode;
	/** Sidecar base URL, e.g. http://127.0.0.1:8197. Empty string = no sidecar. */
	url: string;
	provider: VoiceProvider;
	/** Model name for the openai provider. */
	model: string;
	/** Bearer token, when the endpoint wants one. */
	key: string;
	/** Path appended to url for the openai provider. */
	path: string;
	/** System prompt for the openai provider: must answer VOICE or TEXT. */
	prompt: string;
	/** Score at or above this means "voice". */
	high: number;
	/** Score at or below this means "text". Between low and high = unsure = text. */
	low: number;
	timeoutMs: number;
	/** Extra phrases from the environment, merged with the store. */
	phrases: string[];
	/** Shown to the agent when a voice answer was requested. */
	directive: string;
}

export interface PhraseStore {
	/** Phrases added by the agent/user. */
	extra: string[];
	/** Defaults switched off by the user. */
	disabled: string[];
	updated?: string;
}

const DEFAULT_DIRECTIVE =
	"\n\n[voce] L'utente chiede la risposta come vocale: sintetizza e invia l'audio, non il testo.";

const DEFAULT_PROMPT =
	"Decidi se il messaggio chiede una risposta audio. Rispondi con una sola parola: " +
	"VOICE se chiede un vocale o un audio, TEXT in ogni altro caso, incluse le frasi " +
	"che nominano la voce senza chiederla (volume, timbro, 'la voce di X'). Nessuna spiegazione.";

const DEFAULT_DECISION_INSTRUCTIONS =
	"Decidi se l'utente chiede che la risposta gli arrivi come messaggio vocale o audio. " +
	"Esempi di voice_answer: 'rispondi a voce', 'mandami un audio', 'leggimi la risposta', " +
	"'dimmelo parlando'. Esempi di text_answer: 'scrivi in chat', 'la voce di X e' bella', " +
	"'alza il volume', 'correggi il testo'. Se il messaggio non chiede esplicitamente un " +
	"audio, scegli text_answer.";

/**
 * Canonical phrases, kept deliberately short and channel-specific: "voce" alone
 * is too ambiguous (volume, timbre, "la voce di X"), so every entry names the
 * act of answering.
 */
export const DEFAULT_PHRASES: readonly string[] = [
	// italiano
	"rispondi con un vocale",
	"rispondi a voce",
	"dimmelo con un vocale",
	"dimmelo con la voce",
	"mandami un vocale",
	"mandami un audio",
	"fai report con un vocale",
	"rispondi parlando",
	"fammi sentire la risposta",
	"leggimi la risposta ad alta voce",
	// inglese
	"answer with a voice message",
	"reply with a voice note",
	"send me a voice clip",
	"reply in audio",
	// tedesco
	"antworte mit einer sprachnachricht",
	"sag es mir als sprachnachricht",
	// francese
	"reponds-moi avec un message vocal",
	"dis-le moi en vocal",
	// spagnolo
	"respondeme con un audio",
	"mandame una nota de voz",
];

/**
 * Words that look like a voice request but are not one. Checked after the
 * positives: a negative always wins, because a wrong voice is worse than a
 * missing one.
 */
export const DEFAULT_NEGATIVES: readonly string[] = [
	"volume",
	"la voce di",
	"timbro",
	"per iscritto",
	"messaggio scritto",
	"risposta scritta",
	"come testo",
	"scrivendo",
	"scrivilo",
	"in inglese",
	"increase the volume",
	"as text",
	"in writing",
];

export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
	return env.PI_TELEGRAM_STATE_DIR ?? path.join(os.homedir(), ".pi-telegram-bridge");
}

export function phraseStorePath(env: NodeJS.ProcessEnv = process.env): string {
	return path.join(stateDir(env), "voice-phrases.json");
}

export function loadPhraseStore(file: string = phraseStorePath()): PhraseStore {
	try {
		const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<PhraseStore>;
		return {
			extra: Array.isArray(raw.extra) ? raw.extra.filter((p) => typeof p === "string") : [],
			disabled: Array.isArray(raw.disabled)
				? raw.disabled.filter((p) => typeof p === "string")
				: [],
			updated: raw.updated,
		};
	} catch {
		return { extra: [], disabled: [] };
	}
}

export function savePhraseStore(store: PhraseStore, file: string = phraseStorePath()): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const payload: PhraseStore = {
		extra: [...new Set(store.extra.map((p) => p.trim()).filter(Boolean))],
		disabled: [...new Set(store.disabled.map((p) => p.trim()).filter(Boolean))],
		updated: new Date().toISOString(),
	};
	fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

export function loadVoiceConfig(
	env: NodeJS.ProcessEnv = process.env,
	store: PhraseStore = loadPhraseStore(phraseStorePath(env)),
): VoiceConfig {
	const url = (env.PI_TELEGRAM_VOICE_URL ?? "").trim();
	const rawMode = (env.PI_TELEGRAM_VOICE_MODE ?? "").trim().toLowerCase();
	const mode: VoiceMode =
		rawMode === "off" || rawMode === "phrases" || rawMode === "auto"
			? rawMode
			: url
				? "auto"
				: "off";
	const envPhrases = (env.PI_TELEGRAM_VOICE_PHRASES ?? "")
		.split("|")
		.map((p) => p.trim())
		.filter(Boolean);
	const disabled = new Set(store.disabled.map(normalizeText));
	const phrases = [...DEFAULT_PHRASES, ...store.extra, ...envPhrases].filter(
		(p) => !disabled.has(normalizeText(p)),
	);
	const provider = parseProvider(env.PI_TELEGRAM_VOICE_PROVIDER);
	return {
		mode,
		url,
		provider,
		model: (env.PI_TELEGRAM_VOICE_MODEL ?? "default").trim() || "default",
		key: (env.PI_TELEGRAM_VOICE_KEY ?? "").trim(),
		path: (env.PI_TELEGRAM_VOICE_PATH ?? "/v1/chat/completions").trim(),
		prompt: env.PI_TELEGRAM_VOICE_PROMPT ??
			(provider === "decision" ? DEFAULT_DECISION_INSTRUCTIONS : DEFAULT_PROMPT),
		labels: parseLabels(env.PI_TELEGRAM_VOICE_LABELS),
		threshold: Number.parseFloat((env.PI_TELEGRAM_VOICE_THRESHOLD ?? "0").trim()) || 0,
		high: numberOr(env.PI_TELEGRAM_VOICE_HIGH, 0.7),
		low: numberOr(env.PI_TELEGRAM_VOICE_LOW, 0.3),
		timeoutMs: numberOr(env.PI_TELEGRAM_VOICE_TIMEOUT_MS, 4000),
		phrases,
		directive: env.PI_TELEGRAM_VOICE_DIRECTIVE ?? DEFAULT_DIRECTIVE,
	};
}

function numberOr(raw: string | undefined, fallback: number): number {
	const n = Number.parseFloat((raw ?? "").trim());
	return Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback;
}

function parseProvider(raw: string | undefined): VoiceProvider {
	const value = (raw ?? "").trim().toLowerCase();
	if (value === "openai" || value === "decision") return value;
	return "classify";
}

/** First label means voice, second means text. */
function parseLabels(raw: string | undefined): [string, string] {
	const parts = (raw ?? "").split("|").map((p) => p.trim()).filter(Boolean);
	return parts.length >= 2 ? [parts[0], parts[1]] : ["voice_answer", "text_answer"];
}

// ── Matching ────────────────────────────────────────────────────────

/** Lowercase, strip diacritics and punctuation, collapse whitespace. */
export function normalizeText(text: string): string {
	return text
		.normalize("NFD")
		.replace(/\p{Diacritic}/gu, "")
		.toLowerCase()
		.replace(/[^\p{Letter}\p{Number}]+/gu, " ")
		.trim();
}

/** Whole-phrase containment: "voce" must not fire on "vocale" or "voci". */
export function containsPhrase(haystack: string, needle: string): boolean {
	const h = ` ${haystack} `;
	const n = ` ${needle} `;
	return n.trim().length > 0 && h.includes(n);
}

export type PhraseVerdict = "voice" | "text" | "none";

/** Tier 1: phrase list.
 *
 * A negative always wins, and it also blocks the model: "alza il volume della voce"
 * is exactly the sentence the classifier scored 0.96 (a false voice), so the guard
 * has to answer even when no positive phrase matches.
 */
export function phraseVerdict(
	text: string,
	phrases: readonly string[],
	negatives: readonly string[] = DEFAULT_NEGATIVES,
): PhraseVerdict {
	const norm = normalizeText(text);
	if (!norm) return "none";
	const blocked = negatives.some((p) => containsPhrase(norm, normalizeText(p)));
	if (blocked) return "text";
	const hit = phrases.some((p) => containsPhrase(norm, normalizeText(p)));
	return hit ? "voice" : "none";
}

// ── Sidecar (tiers 2 and 3) ─────────────────────────────────────────

export interface VoiceDecision {
	voice: boolean;
	/** Which tier answered, for logs and for the agent's own awareness. */
	source: "off" | "phrase" | "phrase-negative" | "no-backend" | "model" | "unsure" | "backend-error";
	score?: number;
	detail?: string;
}

type FetchLike = typeof fetch;

/** Backend health, module-level: the sidecar is per-process, not per message. */
const health = { failures: 0, quietUntil: 0 };
const FAILURE_LIMIT = 3;
const QUIET_MS = 60_000;

export function resetVoiceIntentState(): void {
	health.failures = 0;
	health.quietUntil = 0;
}

export function backendHealth(): { failures: number; quietForMs: number } {
	return { failures: health.failures, quietForMs: Math.max(0, health.quietUntil - Date.now()) };
}

async function askBackend(
	text: string,
	cfg: VoiceConfig,
	fetchImpl: FetchLike,
): Promise<{ score: number } | { error: string }> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
	const base = cfg.url.replace(/\/+$/, "");
	try {
		const headers: Record<string, string> = { "Content-Type": "application/json" };
		if (cfg.key) headers.Authorization = `Bearer ${cfg.key}`;
		const openai = cfg.provider === "openai";
		const decision = cfg.provider === "decision";
		const endpoint = openai
			? `${base}${cfg.path}`
			: decision
				? `${base}/v1/decision`
				: `${base}/classify`;
		const res = await fetchImpl(endpoint, {
			method: "POST",
			headers,
			body: JSON.stringify(
				openai
					? {
							model: cfg.model,
							temperature: 0,
							max_tokens: 4,
							stream: false,
							messages: [
								{ role: "system", content: cfg.prompt },
								{ role: "user", content: text },
							],
						}
					: decision
						? {
								text,
								labels: cfg.labels,
								instructions: cfg.prompt,
								confidence_threshold: cfg.threshold,
								category: "Voice Intent",
							}
						: { text },
			),
			signal: controller.signal,
		});
		if (!res.ok) return { error: `HTTP ${res.status}` };
		const body = (await res.json()) as {
			voice?: unknown;
			score?: unknown;
			winner?: unknown;
			confidence?: unknown;
			choices?: { message?: { content?: unknown } }[];
		};
		if (decision) {
			const winner = typeof body.winner === "string" ? body.winner : "";
			const confidence = typeof body.confidence === "number" ? body.confidence : 0;
			if (winner === cfg.labels[0]) return { score: Math.min(1, Math.max(0, confidence)) };
			if (winner === cfg.labels[1]) return { score: Math.min(1, Math.max(0, 1 - confidence)) };
			return { error: `vincitore sconosciuto: ${winner || "nessuno"}` };
		}
		if (openai) {
			const content = body.choices?.[0]?.message?.content;
			const word = typeof content === "string" ? content.trim().toLowerCase() : "";
			if (/^voice\b/.test(word)) return { score: 1 };
			if (/^text\b/.test(word)) return { score: 0 };
			return { error: `risposta non riconosciuta: ${word.slice(0, 20) || "vuota"}` };
		}
		const raw = typeof body.voice === "number" ? body.voice : body.score;
		if (typeof raw !== "number" || !Number.isFinite(raw)) return { error: "no score" };
		return { score: Math.min(1, Math.max(0, raw)) };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	} finally {
		clearTimeout(timer);
	}
}

/**
 * The full gate. Never throws: any failure degrades to "no voice".
 * Logs nothing itself — the caller decides what to do with `source`.
 */
export async function decideVoiceIntent(
	text: string,
	cfg: VoiceConfig,
	fetchImpl: FetchLike = fetch,
): Promise<VoiceDecision> {
	if (cfg.mode === "off") return { voice: false, source: "off" };
	const verdict = phraseVerdict(text, cfg.phrases);
	if (verdict === "voice") return { voice: true, source: "phrase" };
	if (verdict === "text") return { voice: false, source: "phrase-negative" };
	if (cfg.mode !== "auto" || !cfg.url) return { voice: false, source: "no-backend" };
	if (Date.now() < health.quietUntil) {
		return { voice: false, source: "backend-error", detail: "sidecar in pausa" };
	}
	const result = await askBackend(text, cfg, fetchImpl);
	if ("error" in result) {
		health.failures += 1;
		if (health.failures >= FAILURE_LIMIT) health.quietUntil = Date.now() + QUIET_MS;
		return { voice: false, source: "backend-error", detail: result.error };
	}
	health.failures = 0;
	if (result.score >= cfg.high) return { voice: true, source: "model", score: result.score };
	if (result.score <= cfg.low) return { voice: false, source: "model", score: result.score };
	return { voice: false, source: "unsure", score: result.score };
}

// ── Wiring helpers ──────────────────────────────────────────────────

/** Text to append to a forwarded message. Empty when no voice was requested. */
export function voiceDirective(cfg: VoiceConfig, decision: VoiceDecision): string {
	return decision.voice ? cfg.directive : "";
}

/** One line for status output and for logs. */
export function describeDecision(decision: VoiceDecision): string {
	const score = decision.score === undefined ? "" : ` ${decision.score.toFixed(3)}`;
	const detail = decision.detail ? ` (${decision.detail})` : "";
	return `${decision.voice ? "voce" : "testo"} via ${decision.source}${score}${detail}`;
}

/** Human summary of what the agent has saved, shown by the voice_trigger tool. */
export function describeStore(store: PhraseStore): string {
	const extra = store.extra.length ? `aggiunte: ${store.extra.join(", ")}` : "nessuna frase aggiunta";
	const off = store.disabled.length ? ` · disattivate: ${store.disabled.join(", ")}` : "";
	const when = store.updated ? ` (aggiornato ${store.updated.slice(0, 19)})` : "";
	return extra + off + when;
}
