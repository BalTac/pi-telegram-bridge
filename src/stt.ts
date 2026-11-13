/**
 * Speech-to-text for Telegram voice messages.
 *
 * A voice note arrives as OGG/Opus. The transcript is what the agent reads, so
 * this module tries a configurable chain of providers and stops at the first
 * one that returns text:
 *
 *   http  → any OpenAI-compatible /v1/audio/transcriptions endpoint
 *           OpenAI, Groq, Mistral, DeepInfra, together.ai, LocalAI,
 *           faster-whisper-server, whisper.cpp server, whisper-asr-webservice,
 *           the local audio server on 127.0.0.1:8123 … all speak this dialect.
 *   cmd   → a command line: whisper.cpp CLI, `whisper`, insanely-fast-whisper,
 *           vosk-transcriber … anything that prints the text or writes <file>.txt
 *   agent → no transcription here: the path is handed to the agent, which can
 *           call its own tools (an MCP transcription server, for instance)
 *   off   → only the path, no transcript attempt
 *
 * Default chain: every stage that is configured, in the order http, cmd, agent.
 * Override with PI_TELEGRAM_STT_CHAIN=http,cmd,agent
 */

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

export interface Transcript {
	/** Recognised text, empty when no provider produced one. */
	text: string;
	/** Stage that answered: http, cmd, agent, off, none. */
	provider: string;
	/** Why the stages that were tried did not answer. */
	error?: string;
}

type Stage = "http" | "cmd" | "agent" | "off";

const TIMEOUT_MS = Number(process.env.PI_TELEGRAM_STT_TIMEOUT_MS ?? 120000);

/** Chain of stages to try, in order. Only configured stages are used by default. */
export function sttChain(): Stage[] {
	const explicit = process.env.PI_TELEGRAM_STT_CHAIN?.trim();
	if (explicit) {
		return explicit
			.split(",")
			.map((s) => s.trim().toLowerCase())
			.filter((s): s is Stage => s === "http" || s === "cmd" || s === "agent" || s === "off");
	}
	const chain: Stage[] = [];
	if (process.env.PI_TELEGRAM_STT_URL) chain.push("http");
	if (process.env.PI_TELEGRAM_STT_CMD) chain.push("cmd");
	chain.push("agent");
	return chain;
}

/** POST the file to an OpenAI-compatible transcription endpoint. */
async function viaHttp(filePath: string): Promise<string> {
	const url = process.env.PI_TELEGRAM_STT_URL?.trim();
	if (!url) throw new Error("PI_TELEGRAM_STT_URL non impostata");

	const bytes = await readFile(filePath);
	const form = new FormData();
	form.append("file", new Blob([bytes], { type: "audio/ogg" }), filePath.split(/[\\/]/).pop() ?? "voice.ogg");
	const model = process.env.PI_TELEGRAM_STT_MODEL?.trim();
	if (model) form.append("model", model);
	const language = process.env.PI_TELEGRAM_STT_LANG?.trim();
	if (language && language !== "auto") form.append("language", language);
	form.append("response_format", "json");

	const headers: Record<string, string> = {};
	const key = process.env.PI_TELEGRAM_STT_KEY?.trim();
	if (key) headers.authorization = `Bearer ${key}`;
	const extraHeader = process.env.PI_TELEGRAM_STT_HEADER?.trim(); // es. "x-api-key: abc"
	if (extraHeader) {
		const idx = extraHeader.indexOf(":");
		if (idx > 0) headers[extraHeader.slice(0, idx).trim()] = extraHeader.slice(idx + 1).trim();
	}

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
	try {
		const res = await fetch(url, { method: "POST", body: form, headers, signal: controller.signal });
		const raw = await res.text();
		if (!res.ok) throw new Error(`HTTP ${res.status} ${raw.slice(0, 160)}`);
		try {
			const data = JSON.parse(raw) as { text?: string; transcript?: string };
			return (data.text ?? data.transcript ?? "").trim();
		} catch {
			return raw.trim(); // some servers answer with plain text
		}
	} finally {
		clearTimeout(timer);
	}
}

/** Run a local command: `{file}` is replaced with the audio path. */
async function viaCmd(filePath: string): Promise<string> {
	const template = process.env.PI_TELEGRAM_STT_CMD?.trim();
	if (!template) throw new Error("PI_TELEGRAM_STT_CMD non impostata");

	const command = template.includes("{file}")
		? template
		: `${template} ${JSON.stringify(filePath)}`;
	const out = await new Promise<string>((resolve, reject) => {
		const child = spawn(command, { shell: true, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`timeout dopo ${TIMEOUT_MS}ms`));
		}, TIMEOUT_MS);
		child.stdout.on("data", (d) => (stdout += String(d)));
		child.stderr.on("data", (d) => (stderr += String(d)));
		child.on("error", (e) => {
			clearTimeout(timer);
			reject(e);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			if (code !== 0) reject(new Error(`exit ${code} ${stderr.slice(0, 160)}`));
			else resolve(stdout);
		});
	});
	const clean = out.trim();
	if (clean) return clean;
	// whisper.cpp -otxt scrive <file>.txt accanto all'audio
	try {
		return (await readFile(`${filePath}.txt`, "utf8")).trim();
	} catch {
		return "";
	}
}

/** Try the configured chain. Never throws: the caller still gets the file path. */
export async function transcribe(filePath: string): Promise<Transcript> {
	const failures: string[] = [];
	for (const stage of sttChain()) {
		if (stage === "off") return { text: "", provider: "off", error: failures.join(" | ") || undefined };
		if (stage === "agent") {
			return { text: "", provider: "agent", error: failures.join(" | ") || undefined };
		}
		try {
			const text = stage === "http" ? await viaHttp(filePath) : await viaCmd(filePath);
			if (text) return { text, provider: stage };
			failures.push(`${stage}: empty response`);
		} catch (e) {
			failures.push(`${stage}: ${e instanceof Error ? e.message : String(e)}`);
		}
	}
	return { text: "", provider: "none", error: failures.join(" | ") || "no STT provider configured" };
}

/** One line describing the current setup, secrets redacted. Used by telegram_status. */
export function sttSummary(): string {
	const chain = sttChain().join(" → ");
	const bits = [`chain=${chain}`];
	if (process.env.PI_TELEGRAM_STT_URL) bits.push(`url=${process.env.PI_TELEGRAM_STT_URL}`);
	if (process.env.PI_TELEGRAM_STT_MODEL) bits.push(`model=${process.env.PI_TELEGRAM_STT_MODEL}`);
	if (process.env.PI_TELEGRAM_STT_KEY) bits.push("key=set");
	if (process.env.PI_TELEGRAM_STT_CMD) bits.push("cmd=set");
	return bits.join(" · ");
}
