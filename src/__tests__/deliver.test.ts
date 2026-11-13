/**
 * /deliver — switch the streaming delivery mode from Telegram.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { deliverMode } from "../forward";
import { handleDeliver } from "../commands";

const original = process.env.PI_TELEGRAM_DELIVER_AS;
const originalFile = process.env.PI_TELEGRAM_ENV_FILE;

beforeEach(() => {
	delete process.env.PI_TELEGRAM_DELIVER_AS;
	delete process.env.PI_TELEGRAM_ENV_FILE;
});

afterEach(() => {
	if (original === undefined) delete process.env.PI_TELEGRAM_DELIVER_AS;
	else process.env.PI_TELEGRAM_DELIVER_AS = original;
	if (originalFile === undefined) delete process.env.PI_TELEGRAM_ENV_FILE;
	else process.env.PI_TELEGRAM_ENV_FILE = originalFile;
});

describe("/deliver", () => {
	it("shows the current mode when called with no argument", async () => {
		const reply = await handleDeliver("");
		expect(reply).toContain("followUp");
		expect(reply).toContain("/deliver steer");
	});

	it("switches to steer immediately", async () => {
		const reply = await handleDeliver("steer");
		expect(deliverMode()).toBe("steer");
		expect(reply).toContain("steer");
		expect(reply).toContain("questa sessione");
	});

	it("accepts follow-up spellings", async () => {
		for (const spelling of ["followUp", "follow-up", "FOLLOW_UP", "queue"]) {
			process.env.PI_TELEGRAM_DELIVER_AS = "steer";
			const reply = await handleDeliver(spelling);
			expect(deliverMode()).toBe("followUp");
			expect(reply).toContain("followUp");
		}
	});

	it("rejects unknown values and keeps the current mode", async () => {
		process.env.PI_TELEGRAM_DELIVER_AS = "steer";
		const reply = await handleDeliver("turbo");
		expect(deliverMode()).toBe("steer");
		expect(reply).toContain("steer");
		expect(reply).toContain("followUp");
	});

	it("persists the choice when the env file is known", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "deliver-"));
		const file = path.join(dir, "bridge.env");
		await writeFile(file, "TELEGRAM_CHAT_ID=1\nPI_TELEGRAM_DELIVER_AS=followUp\n", "utf8");
		process.env.PI_TELEGRAM_ENV_FILE = file;

		const reply = await handleDeliver("steer");
		expect(reply).toContain("salvata");
		const text = await readFile(file, "utf8");
		expect(text).toContain("PI_TELEGRAM_DELIVER_AS=steer");
		expect(text).toContain("TELEGRAM_CHAT_ID=1");
	});

	it("appends the line when the env file has none", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "deliver-"));
		const file = path.join(dir, "bridge.env");
		await writeFile(file, "TELEGRAM_CHAT_ID=1\n", "utf8");
		process.env.PI_TELEGRAM_ENV_FILE = file;

		await handleDeliver("steer");
		const text = await readFile(file, "utf8");
		expect(text.trim().endsWith("PI_TELEGRAM_DELIVER_AS=steer")).toBe(true);
	});
});
