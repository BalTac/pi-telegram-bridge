/**
 * Misura il gate completo (lessico + sidecar) sulle 40 frasi di riferimento.
 *
 * Serve a una cosa sola: sapere quanto vale la *composizione*, non i singoli pezzi.
 * Il lessico blocca le trappole prima che il modello le veda, quindi il numero che
 * conta e' questo, non l'accuratezza del classificatore da solo.
 *
 * Uso:  node voice-intent/eval-gate.ts [http://127.0.0.1:8197]
 */
import {
	decideVoiceIntent,
	loadVoiceConfig,
	phraseVerdict,
} from "../src/voiceIntent.ts";

const POS = [
	"rispondi con un vocale", "fai report con un vocale", "rispondi a voce",
	"dimmelo con un vocale", "dimmelo con la voce", "mandami un vocale",
	"rispondi parlando", "answer me with a voice message", "reply with a voice note",
	"antworte mit einer Sprachnachricht", "reponds-moi avec un message vocal",
	"respondeme con un audio", "mandami un messaggio vocale con il riassunto",
	"puoi rispondermi parlando?", "fammi sentire la risposta",
	"gib mir eine Sprachnachricht dazu", "envoie un vocal stp",
	"manda la risposta come audio", "recitami il testo a voce",
	"dimmelo parlando, non scrivere", "send the answer as audio please",
	"hazlo en audio por favor",
];
const NEG = [
	"rispondi con un messaggio scritto", "fai un report scritto",
	"la voce di Gigi Lonfo e' bella", "alza il volume della voce",
	"riassumi questo articolo", "scrivi la risposta in chat", "rispondi in inglese",
	"what did he say about the outage", "mandami un messaggio scritto con il riassunto",
	"puoi rispondermi scrivendo?", "fammi vedere la risposta", "schreib mir die Antwort dazu",
	"envoie par ecrit stp", "manda la risposta come testo", "correggi il testo della voce",
	"dimmelo scrivendo, non parlare", "send the answer as text please",
	"hazlo por escrito por favor",
];

const url = process.argv[2] ?? "http://127.0.0.1:8197";
const cfg = loadVoiceConfig({ ...process.env, PI_TELEGRAM_VOICE_URL: url, PI_TELEGRAM_VOICE_MODE: "auto" } as NodeJS.ProcessEnv, { extra: [], disabled: [] });

let hits = 0;
const errors: string[] = [];
const latencies: number[] = [];
const bySource: Record<string, number> = {};

for (const [kind, items] of [["POS", POS], ["NEG", NEG]] as const) {
	for (const text of items) {
		const t0 = performance.now();
		const decision = await decideVoiceIntent(text, cfg);
		latencies.push(performance.now() - t0);
		bySource[decision.source] = (bySource[decision.source] ?? 0) + 1;
		const ok = decision.voice === (kind === "POS");
		hits += ok ? 1 : 0;
		if (!ok) errors.push(`${kind} ${decision.source} ${decision.score?.toFixed(3) ?? "-"}  ${text}`);
	}
}

latencies.sort((a, b) => a - b);
const median = latencies[Math.floor(latencies.length / 2)];
const total = POS.length + NEG.length;
console.log(`gate completo (${url}): ${hits}/${total} = ${((hits / total) * 100).toFixed(1)}%`);
console.log(`latenza: mediana ${median.toFixed(0)} ms (min ${latencies[0].toFixed(0)}, max ${latencies.at(-1)!.toFixed(0)})`);
console.log(`per fonte: ${JSON.stringify(bySource)}`);
for (const e of errors) console.log("  ERR " + e);
const lyricOnly = POS.concat(NEG).filter((t) => phraseVerdict(t, cfg.phrases) !== "none").length;
console.log(`decise senza modello dal lessico: ${lyricOnly}/${total}`);
process.exit(hits === total ? 0 : 1);
