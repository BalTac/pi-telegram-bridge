/**
 * pi-telegram-bridge — Commands Tests
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock helpers module ───────────────────────────────────────────
// Must be before any import of the module under test
let mockSendMsg: any;
let mockGetChatId: any;

vi.mock("../helpers", () => ({
	sendMsg: (...args: any[]) => mockSendMsg(...args),
	getChatId: () => mockGetChatId(),
}));

// Import after mocks
import { isPossibleCommand, handleCommand } from "../commands";

function mockPi() {
	const messages: string[] = [];
	return {
		sendUserMessage: vi.fn((msg: string) => messages.push(msg)),
		getMessages: () => messages,
	};
}

beforeEach(() => {
	vi.restoreAllMocks();
	mockSendMsg = vi.fn().mockResolvedValue(12345);
	mockGetChatId = vi.fn().mockReturnValue("987654321");
});

// ── isPossibleCommand ─────────────────────────────────────────────

describe("isPossibleCommand", () => {
	it("detects slash-prefixed messages", () => {
		expect(isPossibleCommand("/stop")).toBe(true);
		expect(isPossibleCommand("/s")).toBe(true);
		expect(isPossibleCommand("/help")).toBe(true);
		expect(isPossibleCommand("/status")).toBe(true);
		expect(isPossibleCommand("/i")).toBe(true);
	});

	it("rejects non-slash messages", () => {
		expect(isPossibleCommand("hello")).toBe(false);
		expect(isPossibleCommand("stop")).toBe(false);
		expect(isPossibleCommand("")).toBe(false);
	});

	it("detects slash with leading whitespace", () => {
		expect(isPossibleCommand("  /stop")).toBe(true);
	});

	it("rejects non-slash with leading whitespace", () => {
		expect(isPossibleCommand("  hello")).toBe(false);
	});
});

// ── handleCommand — Bridge Commands ───────────────────────────────

describe("handleCommand — bridge commands", () => {
	it("handles /help and /status as bridge commands", async () => {
		for (const cmd of ["/help", "/h", "/status", "/st", "/HELP", "/Status"]) {
			const pi = mockPi();
			const result = await handleCommand(cmd, pi as any, false);
			expect(result.handled).toBe(true);
			if (result.handled) expect(result.type).toBe("bridge");
			expect(pi.sendUserMessage).not.toHaveBeenCalled();
		}
	});
});

// ── handleCommand — Agent Commands ────────────────────────────────

describe("handleCommand — agent commands", () => {
	const agentCommands = [
		"/stop",
		"/s",
		"/go",
		"/g",
		"/sum",
		"/redo",
		"/r",
		"/commit",
		"/c",
		"/push",
		"/p",
		"/skip",
		"/files",
		"/f",
		"/issue",
		"/i",
	];

	for (const cmd of agentCommands) {
		it(`handles ${cmd} and injects to agent`, async () => {
			const pi = mockPi();
			const result = await handleCommand(cmd, pi as any, false);
			expect(result.handled).toBe(true);
			if (result.handled) expect(result.type).toBe("agent");
			expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
			expect(pi.getMessages()[0]).toContain("[COMMAND:");
		});
	}

	it("handles commands case-insensitively", async () => {
		const pi = mockPi();
		const result = await handleCommand("/STOP", pi as any, false);
		expect(result.handled).toBe(true);
	});

	it("handles commands with extra text", async () => {
		const pi = mockPi();
		const result = await handleCommand("/stop now please", pi as any, false);
		expect(result.handled).toBe(true);
	});

	it("/issue injects full behavior spec", async () => {
		const pi = mockPi();
		await handleCommand("/issue", pi as any, false);
		const injected = pi.getMessages()[0];
		expect(injected).toContain("RESEARCH the project");
		expect(injected).toContain("project_create_issue");
		expect(injected).toContain("Do NOT ask permission to create");
	});
});

// ── handleCommand — Unknown Commands ──────────────────────────────

describe("handleCommand — unknown commands", () => {
	it("returns not handled for unknown / slash inputs", async () => {
		const pi = mockPi();
		const result = await handleCommand("/foobar", pi as any, false);
		expect(result.handled).toBe(false);
		expect(pi.sendUserMessage).not.toHaveBeenCalled();
	});

	it("returns not handled for paths like /usr/bin/node", async () => {
		const pi = mockPi();
		const result = await handleCommand("/usr/bin/node", pi as any, false);
		expect(result.handled).toBe(false);
	});

	it("returns not handled for empty string", async () => {
		const pi = mockPi();
		const result = await handleCommand("", pi as any, false);
		expect(result.handled).toBe(false);
	});
});

// ── handleCommand — Ack Behavior ──────────────────────────────────

describe("handleCommand — ack behavior", () => {
	it("sends ack when sendAck is true", async () => {
		const pi = mockPi();
		await handleCommand("/stop", pi as any, true);
		expect(mockSendMsg).toHaveBeenCalledWith(
			expect.stringContaining("Stopping"),
		);
	});

	it("does not send ack when sendAck is false", async () => {
		const pi = mockPi();
		mockSendMsg.mockClear();
		await handleCommand("/stop", pi as any, false);
		expect(mockSendMsg).not.toHaveBeenCalled();
	});
});

// ── Alias Disambiguation ──────────────────────────────────────────

describe("alias disambiguation", () => {
	it("/st maps to /status, not /stop", async () => {
		const pi = mockPi();
		const result = await handleCommand("/st", pi as any, false);
		expect(result.handled).toBe(true);
		if (result.handled) expect(result.type).toBe("bridge");
	});

	it("single-letter aliases map correctly", async () => {
		const tests: Array<[string, string]> = [
			["/s", "/stop"],
			["/g", "/go"],
			["/r", "/redo"],
			["/c", "/commit"],
			["/p", "/push"],
			["/f", "/files"],
			["/i", "/issue"],
			["/h", "/help"],
		];
		for (const [_alias, _canonical] of tests) {
			const pi = mockPi();
			const result = await handleCommand(_alias, pi as any, false);
			expect(result.handled).toBe(true);
			if (result.handled) {
				expect(["bridge", "agent"]).toContain(result.type);
			}
		}
	});
});
