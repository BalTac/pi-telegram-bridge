/**
 * pi-telegram-bridge — Extension Integration Tests
 *
 * Tests the full extension: tool registration, session lifecycle,
 * tool execution with mocked Telegram API.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const TEST_TOKEN = "111:test";
const TEST_CHAT_ID = "999";

// ── Mock Extension API ───────────────────────────────────────────

function createMockPI() {
	const tools: Record<string, any> = {};
	const listeners: Record<string, Array<(...args: any[]) => void>> = {};
	const entries: Array<{ type: string; customType?: string; data: unknown }> =
		[];

	return {
		registerTool: vi.fn((tool: any) => {
			tools[tool.name] = tool;
		}),
		on: vi.fn((event: string, handler: (...args: any[]) => void) => {
			if (!listeners[event]) listeners[event] = [];
			listeners[event].push(handler);
		}),
		sendUserMessage: vi.fn(),
		appendEntry: vi.fn((customType: string, data: unknown) => {
			entries.push({ type: "custom", customType, data });
		}),
		// Helpers for tests
		_tools: tools,
		_listeners: listeners,
		_entries: entries,
		_fireEvent(event: string, ...args: any[]) {
			for (const h of listeners[event] || []) {
				h(...args);
			}
		},
		_getTool(name: string) {
			return tools[name];
		},
		_reset() {
			Object.keys(tools).forEach((k) => delete tools[k]);
			Object.keys(listeners).forEach((k) => delete listeners[k]);
			entries.length = 0;
		},
	};
}

// We need to mock the helpers module. We'll import the extension
// but intercept its helper calls via module mocking.
let mockTelegramApi: any;
let mockSendMsg: any;
let mockPollReply: any;
let mockGetBotId: any;
let mockSeedLastUpdateId: any;
let mockPollUpdates: any;

vi.mock("../helpers", () => ({
	getToken: () => {
		if (!process.env.TELEGRAM_BOT_TOKEN)
			throw new Error("TELEGRAM_BOT_TOKEN not set");
		return process.env.TELEGRAM_BOT_TOKEN;
	},
	getChatId: () => {
		if (!process.env.TELEGRAM_CHAT_ID)
			throw new Error("TELEGRAM_CHAT_ID not set");
		return process.env.TELEGRAM_CHAT_ID;
	},
	telegramApi: (...args: any[]) => mockTelegramApi(...args),
	sendMsg: (...args: any[]) => mockSendMsg(...args),
	pollReply: (...args: any[]) => mockPollReply(...args),
	getBotId: () => mockGetBotId(),
	seedLastUpdateId: (...args: any[]) => mockSeedLastUpdateId(...args),
	pollUpdates: (...args: any[]) => mockPollUpdates(...args),
}));

// Import after mocks
import telegramBridge from "../index";

beforeEach(() => {
	vi.stubEnv("TELEGRAM_BOT_TOKEN", TEST_TOKEN);
	vi.stubEnv("TELEGRAM_CHAT_ID", TEST_CHAT_ID);

	mockTelegramApi = vi
		.fn()
		.mockResolvedValue({ ok: true, result: { id: 123, username: "testbot" } });
	mockSendMsg = vi.fn().mockResolvedValue(42);
	mockPollReply = vi.fn().mockResolvedValue("Yes");
	mockGetBotId = vi.fn().mockResolvedValue(123);
	mockSeedLastUpdateId = vi
		.fn()
		.mockImplementation((id: number) => Promise.resolve(id));
	mockPollUpdates = vi.fn(); // fire and forget, no-op
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.clearAllMocks();
});

// ── Tool Registration ─────────────────────────────────────────────

describe("extension registration", () => {
	it("registers all 7 tools", () => {
		const pi = createMockPI();
		telegramBridge(pi as any);

		expect(pi.registerTool).toHaveBeenCalledTimes(7);
		expect(pi._getTool("telegram_listen")).toBeDefined();
		expect(pi._getTool("telegram_send")).toBeDefined();
		expect(pi._getTool("telegram_ask")).toBeDefined();
		expect(pi._getTool("telegram_override")).toBeDefined();
		expect(pi._getTool("telegram_status")).toBeDefined();
		expect(pi._getTool("telegram_notify")).toBeDefined();
		expect(pi._getTool("telegram_send_photo")).toBeDefined();
	});

	it("registers session_start and session_shutdown handlers", () => {
		const pi = createMockPI();
		telegramBridge(pi as any);

		expect(pi.on).toHaveBeenCalledWith("session_start", expect.any(Function));
		expect(pi.on).toHaveBeenCalledWith(
			"session_shutdown",
			expect.any(Function),
		);
	});
});

// ── telegram_listen Tool ──────────────────────────────────────────

describe("telegram_listen tool", () => {
	it("returns no messages when update queue is empty", async () => {
		const pi = createMockPI();
		telegramBridge(pi as any);

		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ ok: true, result: [] }),
		});
		vi.stubGlobal("fetch", fetchMock);

		const tool = pi._getTool("telegram_listen");
		const result = await tool.execute();

		expect(result.content[0].text).toBe("No new messages.");
		expect(result.isError).toBeFalsy();
	});

	it("detects new text messages and returns them", async () => {
		const pi = createMockPI();
		telegramBridge(pi as any);

		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({
				ok: true,
				result: [
					{
						update_id: 42,
						message: {
							message_id: 1,
							chat: { id: Number(TEST_CHAT_ID) },
							from: { id: 999, is_bot: false },
							text: "Hello from Telegram!",
						},
					},
				],
			}),
		});
		vi.stubGlobal("fetch", fetchMock);

		const tool = pi._getTool("telegram_listen");
		const result = await tool.execute();

		expect(result.content[0].text).toContain("Hello from Telegram!");
		expect(result.details.message).toBe("Hello from Telegram!");
		// Should have persisted the update id
		expect(pi.appendEntry).toHaveBeenCalledWith("tg-last-update", {
			update_id: 42,
		});
	});

	it("returns error when Telegram is unreachable", async () => {
		const pi = createMockPI();
		telegramBridge(pi as any);

		const fetchMock = vi.fn().mockResolvedValue({
			ok: false,
			status: 500,
		});
		vi.stubGlobal("fetch", fetchMock);

		const tool = pi._getTool("telegram_listen");
		const result = await tool.execute();

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toBe("Could not reach Telegram.");
	});

	it("returns error on network failure", async () => {
		const pi = createMockPI();
		telegramBridge(pi as any);

		vi.stubGlobal(
			"fetch",
			vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
		);

		const tool = pi._getTool("telegram_listen");
		const result = await tool.execute();

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("ECONNREFUSED");
	});

	it("skips callback_query updates", async () => {
		const pi = createMockPI();
		telegramBridge(pi as any);

		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({
				ok: true,
				result: [
					{
						update_id: 10,
						callback_query: { id: "cb-1", data: "yes" },
					},
				],
			}),
		});
		vi.stubGlobal("fetch", fetchMock);

		const tool = pi._getTool("telegram_listen");
		const result = await tool.execute();

		expect(result.content[0].text).toBe("No new messages.");
	});
});

// ── telegram_send Tool ────────────────────────────────────────────

describe("telegram_send tool", () => {
	it("sends a message and returns success", async () => {
		const pi = createMockPI();
		telegramBridge(pi as any);

		const tool = pi._getTool("telegram_send");
		const result = await tool.execute("id-1", { message: "Test message" });

		// fork: the send tool asks Telegram to parse Markdown
expect(mockSendMsg).toHaveBeenCalledWith("Test message", undefined, "Markdown");
		expect(result.content[0].text).toContain("Sent");
		expect(result.isError).toBeFalsy();
	});

	it("returns error when sending fails", async () => {
		const pi = createMockPI();
		mockSendMsg = vi.fn().mockRejectedValue(new Error("Chat not found"));
		telegramBridge(pi as any);

		const tool = pi._getTool("telegram_send");
		const result = await tool.execute("id-1", { message: "Test" });

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Chat not found");
	});
});

// ── telegram_ask Tool ─────────────────────────────────────────────

describe("telegram_ask tool", () => {
	it("sends question and returns reply", async () => {
		const pi = createMockPI();
		mockPollReply = vi.fn().mockResolvedValue("No");
		telegramBridge(pi as any);

		const tool = pi._getTool("telegram_ask");
		const result = await tool.execute("id-1", { question: "Deploy?" });

		expect(mockSendMsg).toHaveBeenCalled();
		const sendCall = mockSendMsg.mock.calls[0];
		expect(sendCall[0]).toContain("Deploy?");
		// Should have inline keyboard markup
		expect(sendCall[1]).toBeDefined();
		expect(sendCall[1].inline_keyboard).toHaveLength(3); // Yes, No, Explain

		expect(result.content[0].text).toContain("No");
		expect(result.details.answer).toBe("No");
	});

	it("uses custom options for keyboard", async () => {
		const pi = createMockPI();
		mockPollReply = vi.fn().mockResolvedValue("Approve");
		telegramBridge(pi as any);

		const tool = pi._getTool("telegram_ask");
		await tool.execute("id-1", {
			question: "Merge?",
			options: ["Approve", "Reject", "Request changes"],
		});

		const sendCall = mockSendMsg.mock.calls[0];
		expect(sendCall[1].inline_keyboard).toEqual([
			[{ text: "Approve", callback_data: "Approve" }],
			[{ text: "Reject", callback_data: "Reject" }],
			[{ text: "Request changes", callback_data: "Request changes" }],
		]);
	});

	it("returns timeout when no reply", async () => {
		const pi = createMockPI();
		mockPollReply = vi.fn().mockResolvedValue(null);
		telegramBridge(pi as any);

		const tool = pi._getTool("telegram_ask");
		const result = await tool.execute("id-1", {
			question: "Hello?",
			timeoutMinutes: 1,
		});

		expect(result.details.timedOut).toBe(true);
		expect(result.content[0].text).toContain("Timeout");
		// Should send a timeout notification
		expect(mockSendMsg).toHaveBeenCalledTimes(2); // question + timeout msg
	});

	it("handles API errors", async () => {
		const pi = createMockPI();
		mockSendMsg = vi.fn().mockRejectedValue(new Error("API down"));
		telegramBridge(pi as any);

		const tool = pi._getTool("telegram_ask");
		const result = await tool.execute("id-1", { question: "Test" });

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("API down");
	});
});

// ── telegram_override Tool ────────────────────────────────────────

describe("telegram_override tool", () => {
	it("formats override message with command and reason", async () => {
		const pi = createMockPI();
		mockPollReply = vi.fn().mockResolvedValue("Yes, proceed");
		telegramBridge(pi as any);

		const tool = pi._getTool("telegram_override");
		const result = await tool.execute("id-1", {
			command: "git push --force",
			reason: "Force push detected",
		});

		const sendCall = mockSendMsg.mock.calls[0];
		expect(sendCall[0]).toContain("Supervisor blocked an action");
		expect(sendCall[0]).toContain("git push --force");
		expect(sendCall[0]).toContain("Force push detected");
		expect(sendCall[1].inline_keyboard).toHaveLength(3);
		expect(sendCall[1].inline_keyboard[0][0].text).toBe("Yes, proceed");

		expect(result.details.action).toBe("proceed");
		expect(result.details.choice).toBe("Yes, proceed");
		expect(result.details.timedOut).toBe(false);
	});

	it("returns abort for second option", async () => {
		const pi = createMockPI();
		mockPollReply = vi.fn().mockResolvedValue("No, cancel");
		telegramBridge(pi as any);

		const tool = pi._getTool("telegram_override");
		const result = await tool.execute("id-1", {
			command: "rm -rf /",
			reason: "Dangerous",
		});

		expect(result.details.action).toBe("abort");
		expect(result.details.choice).toBe("No, cancel");
	});

	it("returns explain for custom third+ options", async () => {
		const pi = createMockPI();
		mockPollReply = vi.fn().mockResolvedValue("Give me details");
		telegramBridge(pi as any);

		const tool = pi._getTool("telegram_override");
		const result = await tool.execute("id-1", {
			command: "test",
			reason: "test",
			options: ["Go", "Stop", "Give me details", "Do it differently"],
		});

		expect(result.details.action).toBe("explain");
		expect(result.details.choice).toBe("Give me details");
	});

	it("includes optional context in message", async () => {
		const pi = createMockPI();
		mockPollReply = vi.fn().mockResolvedValue("Yes, proceed");
		telegramBridge(pi as any);

		const tool = pi._getTool("telegram_override");
		await tool.execute("id-1", {
			command: "test",
			reason: "test",
			context: "User asked for a clean rebuild",
		});

		const sendCall = mockSendMsg.mock.calls[0];
		expect(sendCall[0]).toContain("User asked for a clean rebuild");
	});

	it("returns timeout when no reply", async () => {
		const pi = createMockPI();
		mockPollReply = vi.fn().mockResolvedValue(null);
		telegramBridge(pi as any);

		const tool = pi._getTool("telegram_override");
		const result = await tool.execute("id-1", {
			command: "test",
			reason: "test",
			timeoutMinutes: 1,
		});

		expect(result.details.timedOut).toBe(true);
		expect(result.details.action).toBe("abort");
		expect(mockSendMsg).toHaveBeenCalledTimes(2); // question + timeout
	});

	it("handles errors gracefully", async () => {
		const pi = createMockPI();
		mockSendMsg = vi.fn().mockRejectedValue(new Error("Token invalid"));
		telegramBridge(pi as any);

		const tool = pi._getTool("telegram_override");
		const result = await tool.execute("id-1", {
			command: "test",
			reason: "test",
		});

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Token invalid");
	});

	it("truncates long command in message", async () => {
		const pi = createMockPI();
		mockPollReply = vi.fn().mockResolvedValue("Yes, proceed");
		telegramBridge(pi as any);

		const longCommand = "x".repeat(500);
		const tool = pi._getTool("telegram_override");
		await tool.execute("id-1", {
			command: longCommand,
			reason: "test",
		});

		const sendCall = mockSendMsg.mock.calls[0];
		// Should truncate to 200 chars
		expect(sendCall[0]).toContain("x".repeat(200));
		expect(sendCall[0]).not.toContain("x".repeat(201));
	});
});

// ── telegram_status Tool ──────────────────────────────────────────

describe("telegram_status tool", () => {
	it("reports not configured when env vars missing", async () => {
		vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
		vi.stubEnv("TELEGRAM_CHAT_ID", "");
		const pi = createMockPI();
		telegramBridge(pi as any);

		const tool = pi._getTool("telegram_status");
		const result = await tool.execute();

		expect(result.content[0].text).toContain("Not configured");
	});

	it("reports active when configured and reachable", async () => {
		const pi = createMockPI();
		mockTelegramApi = vi.fn().mockResolvedValue({
			ok: true,
			result: { username: "mycoolbot" },
		});
		telegramBridge(pi as any);

		const tool = pi._getTool("telegram_status");
		const result = await tool.execute();

		expect(result.content[0].text).toContain("Active. Bot: @mycoolbot");
	});

	it("reports unreachable when API fails", async () => {
		const pi = createMockPI();
		mockTelegramApi = vi.fn().mockRejectedValue(new Error("timeout"));
		telegramBridge(pi as any);

		const tool = pi._getTool("telegram_status");
		const result = await tool.execute();

		expect(result.content[0].text).toContain("Token set but unreachable");
	});
});

// ── Session Lifecycle ─────────────────────────────────────────────

describe("session lifecycle", () => {
	it("starts listener on session_start", async () => {
		const pi = createMockPI();
		telegramBridge(pi as any);

		const ctx = {
			sessionManager: {
				getEntries: () => [],
			},
		};

		// Fire session_start
		await pi._listeners["session_start"][0]({}, ctx);

		// startListener() is fire-and-forget async — wait for it
		await new Promise((r) => setTimeout(r, 100));

		// pollUpdates should have been called (fire and forget)
		expect(mockPollUpdates).toHaveBeenCalledTimes(1);
		expect(mockSeedLastUpdateId).toHaveBeenCalledWith(
			0,
			expect.any(AbortSignal),
		);
	});

	it("restores lastUpdateId from session state", async () => {
		const pi = createMockPI();
		telegramBridge(pi as any);

		// Fire session_start with existing state
		const ctx = {
			sessionManager: {
				getEntries: () => [
					{
						type: "custom",
						customType: "tg-last-update",
						data: { update_id: 999 },
					},
				],
			},
		};

		await pi._listeners["session_start"][0]({}, ctx);
		await new Promise((r) => setTimeout(r, 100));

		// seedLastUpdateId should be called with 999
		expect(mockSeedLastUpdateId).toHaveBeenCalledWith(
			999,
			expect.any(AbortSignal),
		);
	});

	it("does not start listener twice on duplicate session_start", async () => {
		const pi = createMockPI();
		telegramBridge(pi as any);

		const ctx = {
			sessionManager: { getEntries: () => [] },
		};

		await pi._listeners["session_start"][0]({}, ctx);
		await new Promise((r) => setTimeout(r, 100));
		expect(mockPollUpdates).toHaveBeenCalledTimes(1);

		// Fire again — should not create another listener
		await pi._listeners["session_start"][0]({}, ctx);
		await new Promise((r) => setTimeout(r, 100));
		expect(mockPollUpdates).toHaveBeenCalledTimes(1);
	});
});
