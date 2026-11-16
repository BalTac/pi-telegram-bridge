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
 * How the backend speaks.
 *
 * `classify` is this repo's own sidecar (`POST {url}/classify` → `{voice: 0.97}`),
 * used on the machine that also runs the audio stack.
 *
 * `systemone` is the SystemOne wire format — the one shared by TypeSafe SystemOne,
 * Julia-1 pipelines and the OpenClaw Hybrid Edge Gateway: a state, a typed choice
 * question with criteria, an optional confidence threshold. That is the standard for
 * system-one decision models, so it is the one a configurable endpoint should speak.
 */
export type VoiceProvider = "classify" | "systemone";

export interface VoiceConfig {
	/** off: never tag. phrases: only the list. auto: list then sidecar (if configured). */
	mode: VoiceMode;
	/** Sidecar base URL, e.g. http://127.0.0.1:8197. Empty string = no sidecar. */
	url: string;
	provider: VoiceProvider;
	/** Bearer token, when the endpoint wants one. */
	key: string;
	/** Question key inside `questions` for the systemone provider. */
	category: string;
	/** Labels for the systemone provider, first one means "voice". */
	labels: [string, string];
	/** Criteria text per label: the wire format wants a description, not just a name. */
	criteria: Record<string, string>;
	/** Instructions for the systemone question. */
	instructions: string;
	/** confidence_threshold sent to the gateway; 0 keeps the fast path only. */
	threshold: number;
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

const DEFAULT_SYSTEMONE_INSTRUCTIONS =
	"Decidi come consegnare la risposta: come messaggio vocale o come testo.";

const DEFAULT_CRITERIA: Record<string, string> = {
	voice_answer: "l'utente chiede che la risposta arrivi come vocale o audio, " +
		"oppure chiede di parlargli invece di scrivergli",
	text_answer: "l'utente vuole la risposta scritta, oppure nomina la voce senza chiederla " +
		"(volume, timbro, 'la voce di X'), oppure parla d'altro",
};

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
	const labels = parseLabels(env.PI_TELEGRAM_VOICE_LABELS);
	return {
		mode,
		url,
		provider,
		key: (env.PI_TELEGRAM_VOICE_KEY ?? "").trim(),
		category: (env.PI_TELEGRAM_VOICE_CATEGORY ?? "decision").trim() || "decision",
		labels,
		criteria: parseCriteria(env.PI_TELEGRAM_VOICE_CRITERIA, labels),
		instructions: env.PI_TELEGRAM_VOICE_INSTRUCTIONS ?? DEFAULT_SYSTEMONE_INSTRUCTIONS,
		threshold: Number.parseFloat((env.PI_TELEGRAM_VOICE_THRESHOLD ?? "0").trim()) || 0,
		high: numberOr(env.PI_TELEGRAM_VOICE_HIGH, 0.7),
		low: numberOr(env.PI_TELEGRAM_VOICE_LOW, 0.3),
		// Un gateway zero-idle-RAM mette 3-5 s ad accendere il worker alla prima
		// richiesta dopo l'inattività: 8 s copre il risveglio, poi risponde in ~270 ms.
		timeoutMs: msOr(env.PI_TELEGRAM_VOICE_TIMEOUT_MS, provider === "systemone" ? 8000 : 4000),
		phrases,
		directive: env.PI_TELEGRAM_VOICE_DIRECTIVE ?? DEFAULT_DIRECTIVE,
	};
}

function numberOr(raw: string | undefined, fallback: number): number {
	const n = Number.parseFloat((raw ?? "").trim());
	return Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback;
}

/**
 * Millisecondi. Separato da numberOr, che accetta solo punteggi 0..1: con la stessa
 * funzione un timeout personalizzato veniva scartato in silenzio.
 */
function msOr(raw: string | undefined, fallback: number): number {
	const n = Number.parseInt((raw ?? "").trim(), 10);
	return Number.isFinite(n) && n >= 200 && n <= 120_000 ? n : fallback;
}

function parseProvider(raw: string | undefined): VoiceProvider {
	return (raw ?? "").trim().toLowerCase() === "systemone" ? "systemone" : "classify";
}

/** First label means voice, second means text. */
function parseLabels(raw: string | undefined): [string, string] {
	const parts = (raw ?? "").split("|").map((p) => p.trim()).filter(Boolean);
	return parts.length >= 2 ? [parts[0], parts[1]] : ["voice_answer", "text_answer"];
}

/** `voce=descrizione|testo=descrizione`, altrimenti le descrizioni di default. */
function parseCriteria(
	raw: string | undefined,
	labels: [string, string],
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const part of (raw ?? "").split("|")) {
		const [name, ...rest] = part.split("=");
		const key = (name ?? "").trim();
		const value = rest.join("=").trim();
		if (key && value) out[key] = value;
	}
	const fallback = (label: string, index: number) =>
		DEFAULT_CRITERIA[label] ?? (index === 0 ? DEFAULT_CRITERIA.voice_answer : DEFAULT_CRITERIA.text_answer);
	return {
		[labels[0]]: out[labels[0]] ?? fallback(labels[0], 0),
		[labels[1]]: out[labels[1]] ?? fallback(labels[1], 1),
	};
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
		const systemone = cfg.provider === "systemone";
		const res = await fetchImpl(systemone ? `${base}/v1/systemone` : `${base}/classify`, {
			method: "POST",
			headers,
			body: JSON.stringify(
				systemone
					? {
							state: text,
							questions: {
								[cfg.category]: {
									type: "choice",
									instructions: cfg.instructions,
									criteria: cfg.criteria,
								},
							},
							confidence_threshold: cfg.threshold,
						}
					: { text },
			),
			signal: controller.signal,
		});
		if (!res.ok) return { error: `HTTP ${res.status}` };
		const body = (await res.json()) as {
			voice?: unknown;
			score?: unknown;
			answers?: Record<string, { choice?: unknown; confidence?: unknown }>;
		};
		if (systemone) {
			const answer = body.answers?.[cfg.category] ?? Object.values(body.answers ?? {})[0];
			const choice = typeof answer?.choice === "string" ? answer.choice : "";
			const confidence = typeof answer?.confidence === "number" ? answer.confidence : 0;
			if (choice === cfg.labels[0]) return { score: Math.min(1, Math.max(0, confidence)) };
			if (choice === cfg.labels[1]) return { score: Math.min(1, Math.max(0, 1 - confidence)) };
			return { error: `scelta sconosciuta: ${choice || "nessuna"}` };
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
