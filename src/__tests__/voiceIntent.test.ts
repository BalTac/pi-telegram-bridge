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
