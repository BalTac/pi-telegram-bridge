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

export interface VoiceConfig {
	/** off: never tag. phrases: only the list. auto: list then sidecar (if configured). */
	mode: VoiceMode;
	/** Sidecar base URL, e.g. http://127.0.0.1:8197. Empty string = no sidecar. */
	url: string;
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
	return {
		mode,
		url,
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

async function askSidecar(
	text: string,
	cfg: VoiceConfig,
	fetchImpl: FetchLike,
): Promise<{ score: number } | { error: string }> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
	try {
		const res = await fetchImpl(`${cfg.url.replace(/\/+$/, "")}/classify`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ text }),
			signal: controller.signal,
		});
		if (!res.ok) return { error: `HTTP ${res.status}` };
		const body = (await res.json()) as { voice?: unknown; score?: unknown };
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
	const result = await askSidecar(text, cfg, fetchImpl);
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
