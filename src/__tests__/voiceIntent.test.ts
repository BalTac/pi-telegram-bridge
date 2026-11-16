import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	DEFAULT_NEGATIVES,
	DEFAULT_PHRASES,
	backendHealth,
	decideVoiceIntent,
	describeDecision,
	loadPhraseStore,
	loadVoiceConfig,
	normalizeText,
	phraseVerdict,
	resetVoiceIntentState,
	savePhraseStore,
	voiceDirective,
} from "../voiceIntent";

function createTempStore(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "voice-intent-"));
}

const CANONICAL = [
	"rispondi con un vocale",
	"fai report con un vocale",
	"rispondi a voce",
	"dimmelo con un vocale",
	"dimmelo con la voce",
];

function cfg(overrides: Partial<Parameters<typeof loadVoiceConfig>[0]> = {}) {
	return loadVoiceConfig(
		{
			PI_TELEGRAM_VOICE_MODE: "auto",
			PI_TELEGRAM_VOICE_URL: "http://127.0.0.1:8197",
			PI_TELEGRAM_STATE_DIR: createTempStore(),
			...overrides,
		} as NodeJS.ProcessEnv,
		{ extra: [], disabled: [] },
	);
}

function fakeFetch(score: number | "boom") {
	return (async () => {
		if (score === "boom") throw new Error("ECONNREFUSED");
		return new Response(JSON.stringify({ voice: score }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	}) as unknown as typeof fetch;
}

afterEach(() => resetVoiceIntentState());

describe("normalizeText", () => {
	it("toglie accenti, maiuscole e punteggiatura", () => {
		expect(normalizeText("Rispondi con un VOCALE!")).toBe("rispondi con un vocale");
		expect(normalizeText("RTÉ, però")).toBe("rte pero");
		expect(normalizeText("  Sprachnachricht  ")).toBe("sprachnachricht");
	});
});

describe("phraseVerdict", () => {
	it("riconosce le frasi canoniche dell'utente", () => {
		for (const phrase of CANONICAL) {
			expect(phraseVerdict(phrase, DEFAULT_PHRASES)).toBe("voice");
		}
	});

	it("riconosce le altre lingue di default", () => {
		expect(phraseVerdict("answer with a voice message", DEFAULT_PHRASES)).toBe("voice");
		expect(phraseVerdict("antworte mit einer Sprachnachricht", DEFAULT_PHRASES)).toBe("voice");
		expect(phraseVerdict("réponds-moi avec un message vocal", DEFAULT_PHRASES)).toBe("voice");
	});

	it("le trappole vincono sul positivo", () => {
		expect(phraseVerdict("alza il volume della voce", DEFAULT_PHRASES)).toBe("text");
		expect(phraseVerdict("rispondi con un vocale e alza il volume", DEFAULT_PHRASES)).toBe("text");
		expect(phraseVerdict("dimmelo per iscritto con la voce", DEFAULT_PHRASES)).toBe("text");
	});

	it("non spara su messaggi normali", () => {
		expect(phraseVerdict("riassumi questo articolo", DEFAULT_PHRASES)).toBe("none");
		expect(phraseVerdict("scrivi la risposta in chat", DEFAULT_PHRASES)).toBe("none");
		expect(phraseVerdict("", DEFAULT_PHRASES)).toBe("none");
	});

	it("rispetta le frasi disattivate", () => {
		const phrases = DEFAULT_PHRASES.filter((p) => p !== "rispondi a voce");
		expect(phraseVerdict("rispondi a voce", phrases)).toBe("none");
	});

	it("non confonde voce con vocale", () => {
		expect(phraseVerdict("il vocale del telefono", DEFAULT_PHRASES)).toBe("none");
		expect(DEFAULT_NEGATIVES.some((n) => normalizeText(n) === "volume")).toBe(true);
	});
});

describe("config", () => {
	it("auto quando c'è la URL, off altrimenti", () => {
		expect(cfg().mode).toBe("auto");
		const none = loadVoiceConfig({ PI_TELEGRAM_STATE_DIR: createTempStore() } as NodeJS.ProcessEnv, {
			extra: [],
			disabled: [],
		});
		expect(none.mode).toBe("off");
	});

	it("unisce frasi da ambiente e da store, toglie le disattivate", () => {
		const dir = createTempStore();
		savePhraseStore({ extra: ["parlami tu"], disabled: ["rispondi a voce"] }, path.join(dir, "voice-phrases.json"));
		const c = loadVoiceConfig(
			{ PI_TELEGRAM_VOICE_MODE: "phrases", PI_TELEGRAM_VOICE_PHRASES: "dimmi tutto|per esteso", PI_TELEGRAM_STATE_DIR: dir } as NodeJS.ProcessEnv,
		);
		expect(c.phrases).toContain("parlami tu");
		expect(c.phrases).toContain("dimmi tutto");
		expect(c.phrases).not.toContain("rispondi a voce");
	});

	it("soglie fuori range tornano ai default", () => {
		const c = cfg({ PI_TELEGRAM_VOICE_HIGH: "7", PI_TELEGRAM_VOICE_LOW: "x" });
		expect(c.high).toBe(0.7);
		expect(c.low).toBe(0.3);
	});
});

describe("decideVoiceIntent", () => {
	it("off non chiama nessuno", async () => {
		const c = { ...cfg(), mode: "off" as const };
		const d = await decideVoiceIntent("rispondi con un vocale", c, fakeFetch(0.99));
		expect(d).toEqual({ voice: false, source: "off" });
	});

	it("la frase basta anche senza sidecar", async () => {
		const c = { ...cfg(), url: "" };
		const d = await decideVoiceIntent("rispondi con un vocale", c, fakeFetch(0.99));
		expect(d.voice).toBe(true);
		expect(d.source).toBe("phrase");
	});

	it("sopra la soglia alta è voce, sotto la bassa è testo, in mezzo incerto", async () => {
		const c = cfg();
		expect((await decideVoiceIntent("fammi un riassunto", c, fakeFetch(0.92))).source).toBe("model");
		expect((await decideVoiceIntent("fammi un riassunto", c, fakeFetch(0.92))).voice).toBe(true);
		expect((await decideVoiceIntent("fammi un riassunto", c, fakeFetch(0.05))).voice).toBe(false);
		const unsure = await decideVoiceIntent("fammi un riassunto", c, fakeFetch(0.5));
		expect(unsure).toMatchObject({ voice: false, source: "unsure" });
	});

	it("il negativo non viene corretto dal modello", async () => {
		const c = cfg();
		const d = await decideVoiceIntent("alza il volume della voce", c, fakeFetch(0.99));
		expect(d).toMatchObject({ voice: false, source: "phrase-negative" });
	});

	it("sidecar giù: degrada e poi tace per un minuto", async () => {
		const c = cfg();
		for (let i = 0; i < 3; i += 1) {
			const d = await decideVoiceIntent("fammi un riassunto", c, fakeFetch("boom"));
			expect(d).toMatchObject({ voice: false, source: "backend-error" });
		}
		expect(backendHealth().failures).toBe(3);
		expect(backendHealth().quietForMs).toBeGreaterThan(0);
		const paused = await decideVoiceIntent("fammi un riassunto", c, fakeFetch("boom"));
		expect(paused.detail).toBe("sidecar in pausa");
	});

	it("un successo azzera i fallimenti", async () => {
		const c = cfg();
		await decideVoiceIntent("x", c, fakeFetch("boom"));
		await decideVoiceIntent("x", c, fakeFetch(0.9));
		expect(backendHealth().failures).toBe(0);
	});
});

describe("provider openai (sistema uno in cloud o in LAN)", () => {
	function chatFetch(answer: string, capture?: { url?: string; body?: any; auth?: string }) {
		return (async (url: string, init: any) => {
			if (capture) {
				capture.url = String(url);
				capture.body = JSON.parse(String(init.body));
				capture.auth = init.headers?.Authorization;
			}
			return new Response(
				JSON.stringify({ choices: [{ message: { role: "assistant", content: answer } }] }),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as unknown as typeof fetch;
	}

	const openaiCfg = () =>
		loadVoiceConfig(
			{
				PI_TELEGRAM_VOICE_MODE: "auto",
				PI_TELEGRAM_VOICE_URL: "http://192.168.50.180:8092",
				PI_TELEGRAM_VOICE_PROVIDER: "openai",
				PI_TELEGRAM_VOICE_MODEL: "gliclass-base",
				PI_TELEGRAM_VOICE_KEY: "k-123",
				PI_TELEGRAM_STATE_DIR: createTempStore(),
			} as NodeJS.ProcessEnv,
			{ extra: [], disabled: [] },
		);

	it("chiama /v1/chat/completions con il prompt e la chiave", async () => {
		const capture: { url?: string; body?: any; auth?: string } = {};
		const c = openaiCfg();
		const d = await decideVoiceIntent("fammi un riassunto", c, chatFetch("VOICE", capture));
		expect(d).toMatchObject({ voice: true, source: "model", score: 1 });
		expect(capture.url).toBe("http://192.168.50.180:8092/v1/chat/completions");
		expect(capture.body.model).toBe("gliclass-base");
		expect(capture.body.temperature).toBe(0);
		expect(capture.body.messages[0].content).toContain("VOICE");
		expect(capture.body.messages[1].content).toBe("fammi un riassunto");
		expect(capture.auth).toBe("Bearer k-123");
	});

	it("TEXT è testo, e la risposta sporca non decide", async () => {
		const c = openaiCfg();
		expect((await decideVoiceIntent("x", c, chatFetch("text"))).voice).toBe(false);
		expect((await decideVoiceIntent("x", c, chatFetch("  VOICE"))).voice).toBe(true);
		const odd = await decideVoiceIntent("x", c, chatFetch("boh"));
		expect(odd).toMatchObject({ voice: false, source: "backend-error" });
	});

	it("il lessico decide prima di chiamare il gateway", async () => {
		const c = openaiCfg();
		let called = false;
		const spy = (async () => {
			called = true;
			return new Response("{}", { status: 200 });
		}) as unknown as typeof fetch;
		const d = await decideVoiceIntent("rispondi con un vocale", c, spy);
		expect(d.source).toBe("phrase");
		expect(called).toBe(false);
	});
});

describe("provider decision (hybrid gateway /v1/decision)", () => {
	function decisionCfg(threshold = "0") {
		return loadVoiceConfig(
			{
				PI_TELEGRAM_VOICE_MODE: "auto",
				PI_TELEGRAM_VOICE_URL: "http://192.168.50.222:8092",
				PI_TELEGRAM_VOICE_PROVIDER: "decision",
				PI_TELEGRAM_VOICE_THRESHOLD: threshold,
				PI_TELEGRAM_STATE_DIR: createTempStore(),
			} as NodeJS.ProcessEnv,
			{ extra: [], disabled: [] },
		);
	}

	function gateFetch(winner: string, confidence: number, capture?: { body?: any; url?: string }) {
		return (async (url: string, init: any) => {
			if (capture) {
				capture.url = String(url);
				capture.body = JSON.parse(String(init.body));
			}
			return new Response(JSON.stringify({ winner, confidence, tier: "System 1", escalated: false }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as unknown as typeof fetch;
	}

	it("manda etichette, istruzioni e soglia a /v1/decision", async () => {
		const capture: { body?: any; url?: string } = {};
		const c = decisionCfg("0.95");
		const d = await decideVoiceIntent("fammi un report", c, gateFetch("voice_answer", 0.998, capture));
		expect(d).toMatchObject({ voice: true, source: "model" });
		expect(capture.url).toBe("http://192.168.50.222:8092/v1/decision");
		expect(capture.body.labels).toEqual(["voice_answer", "text_answer"]);
		expect(capture.body.confidence_threshold).toBe(0.95);
		expect(capture.body.category).toBe("Voice Intent");
		expect(String(capture.body.instructions).toLowerCase()).toContain("vocale");
	});

	it("converte il vincitore in punteggio per le soglie del ponte", async () => {
		const c = decisionCfg();
		const voice = await decideVoiceIntent("x", c, gateFetch("voice_answer", 0.99));
		const text = await decideVoiceIntent("x", c, gateFetch("text_answer", 0.99));
		expect(voice.score).toBeCloseTo(0.99, 2);
		expect(text.score).toBeCloseTo(0.01, 2);
		expect(voice.voice).toBe(true);
		expect(text.voice).toBe(false);
	});

	it("un vincitore sconosciuto non diventa voce", async () => {
		const c = decisionCfg();
		const d = await decideVoiceIntent("x", c, gateFetch("boh", 0.9));
		expect(d).toMatchObject({ voice: false, source: "backend-error" });
	});
});

describe("integrazione con il testo inoltrato", () => {
	it("la direttiva compare solo quando serve", async () => {
		const c = cfg();
		const voice = await decideVoiceIntent("rispondi con un vocale", c, fakeFetch(0.99));
		const text = await decideVoiceIntent("riassumi", c, fakeFetch(0.01));
		expect(voiceDirective(c, voice)).toContain("[voce]");
		expect(voiceDirective(c, text)).toBe("");
	});

	it("describeDecision è leggibile", async () => {
		const c = cfg();
		const d = await decideVoiceIntent("fammi un riassunto", c, fakeFetch(0.83));
		expect(describeDecision(d)).toContain("voce via model 0.830");
	});
});

describe("store", () => {
	it("legge e scrive, deduplica e data", () => {
		const file = path.join(createTempStore(), "store.json");
		savePhraseStore({ extra: ["a", "a", " b "], disabled: [] }, file);
		const back = loadPhraseStore(file);
		expect(back.extra).toEqual(["a", "b"]);
		expect(back.updated).toMatch(/^\d{4}-/);
		expect(fs.existsSync(file)).toBe(true);
	});

	it("store assente o corrotto non esplode", () => {
		const file = path.join(os.tmpdir(), `voice-store-missing-${Date.now()}.json`);
		expect(loadPhraseStore(file)).toEqual({ extra: [], disabled: [] });
		fs.writeFileSync(file, "{ non json", "utf8");
		expect(loadPhraseStore(file).extra).toEqual([]);
	});
});
