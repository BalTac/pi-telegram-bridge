/**
 * Telegram bot command menu (setMyCommands) derived from the command table.
 */
import { describe, expect, it } from "vitest";
import { commandMenu } from "../commands";

describe("commandMenu", () => {
	const menu = commandMenu();

	it("uses valid Telegram command names", () => {
		expect(menu.length).toBeGreaterThan(5);
		for (const entry of menu) {
			expect(entry.command).toMatch(/^[a-z0-9_]{1,32}$/);
		}
	});

	it("keeps descriptions within limits", () => {
		for (const entry of menu) {
			expect(entry.description.length).toBeGreaterThan(0);
			expect(entry.description.length).toBeLessThanOrEqual(256);
		}
	});

	it("lists the commands the bridge implements", () => {
		const names = menu.map((e) => e.command);
		expect(names).toContain("deliver");
		expect(names).toContain("help");
		expect(names).toContain("status");
		expect(names).toContain("stop");
	});
});
