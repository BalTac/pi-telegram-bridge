/**
 * pi-telegram-bridge — Helpers Tests
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const helpers = await import("../helpers");

const TEST_TOKEN = "123456:test-bot-token";
const TEST_CHAT_ID = "987654321";

beforeEach(() => {
  vi.stubEnv("TELEGRAM_BOT_TOKEN", TEST_TOKEN);
  vi.stubEnv("TELEGRAM_CHAT_ID", TEST_CHAT_ID);
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ── getToken ──────────────────────────────────────────────────────

describe("getToken", () => {
  it("returns the token when set", () => {
    expect(helpers.getToken()).toBe(TEST_TOKEN);
  });

  it("throws when TELEGRAM_BOT_TOKEN is not set", () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
    expect(() => helpers.getToken()).toThrow("TELEGRAM_BOT_TOKEN not set");
  });

  it("throws when TELEGRAM_BOT_TOKEN is undefined", () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", undefined);
    expect(() => helpers.getToken()).toThrow("TELEGRAM_BOT_TOKEN not set");
  });
});

// ── getChatId ─────────────────────────────────────────────────────

describe("getChatId", () => {
  it("returns chat id when set", () => {
    expect(helpers.getChatId()).toBe(TEST_CHAT_ID);
  });

  it("throws when TELEGRAM_CHAT_ID is not set", () => {
    vi.stubEnv("TELEGRAM_CHAT_ID", "");
    expect(() => helpers.getChatId()).toThrow("TELEGRAM_CHAT_ID not set");
  });
});

// ── telegramApi ───────────────────────────────────────────────────

describe("telegramApi", () => {
  it("makes POST to correct URL with JSON body", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: { id: 123 } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await helpers.telegramApi("getMe", { foo: "bar" });

    expect(fetchMock).toHaveBeenCalledWith(
      `https://api.telegram.org/bot${TEST_TOKEN}/getMe`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ foo: "bar" }),
      },
    );
    expect(result).toEqual({ ok: true, result: { id: 123 } });
  });

  it("throws on non-ok with status code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => "Unauthorized",
      }),
    );
    await expect(helpers.telegramApi("getMe", {})).rejects.toThrow(
      "Telegram API 401: Unauthorized",
    );
  });

  it("throws on network error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network down")));
    await expect(helpers.telegramApi("getMe", {})).rejects.toThrow("Network down");
  });
});

// ── sendMsg ────────────────────────────────────────────────────────

describe("sendMsg", () => {
  it("sends with Markdown parse mode and returns message_id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true, result: { message_id: 42 } }),
      }),
    );
    const mid = await helpers.sendMsg("Hello *world*");
    expect(mid).toBe(42);
  });

  it("includes reply_markup when provided", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: { message_id: 1 } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const markup = { inline_keyboard: [[{ text: "Yes", callback_data: "yes" }]] };
    await helpers.sendMsg("Q?", markup);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.reply_markup).toBe(JSON.stringify(markup));
  });

  it("omits reply_markup when not provided", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: { message_id: 1 } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await helpers.sendMsg("Plain");
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.reply_markup).toBeUndefined();
  });

  it("throws on API error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: async () => "chat not found",
      }),
    );
    await expect(helpers.sendMsg("test")).rejects.toThrow(
      "Telegram API 400: chat not found",
    );
  });
});

// ── pollReply ─────────────────────────────────────────────────────

describe("pollReply", () => {
  it("returns text reply when new message arrives after sentId", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ ok: true, result: [] }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            ok: true,
            result: [
              {
                update_id: 100,
                message: {
                  message_id: 50,
                  chat: { id: Number(TEST_CHAT_ID) },
                  text: "I approve!",
                },
              },
            ],
          }),
        }),
    );

    const reply = await helpers.pollReply(10, TEST_CHAT_ID, 60000);
    expect(reply).toBe("I approve!");
  });

  it("returns callback_query data when button clicked", async () => {
    // Mock fetch: drain + poll with callback_query + answerCallbackQuery POST
    const fetchMock = vi
      .fn()
      // drain
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, result: [] }),
      })
      // poll — returns callback_query
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          result: [
            {
              update_id: 200,
              callback_query: {
                id: "cb-1",
                message: {
                  message_id: 30,
                  chat: { id: Number(TEST_CHAT_ID) },
                },
                data: "Yes, proceed",
              },
            },
          ],
        }),
      })
      // answerCallbackQuery POST (triggered by callback_query above)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, result: true }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const reply = await helpers.pollReply(10, TEST_CHAT_ID, 60000);
    expect(reply).toBe("Yes, proceed");

    // Verify answerCallbackQuery was called
    const cbCall = fetchMock.mock.calls[2];
    expect(cbCall[0]).toContain("answerCallbackQuery");
    expect(JSON.parse(cbCall[1].body)).toEqual({
      callback_query_id: "cb-1",
    });
  });

  it("returns null on timeout (past deadline)", async () => {
    const reply = await helpers.pollReply(1, TEST_CHAT_ID, -1);
    expect(reply).toBeNull();
  });

  it("ignores messages with message_id <= sentId", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ ok: true, result: [] }),
        })
        .mockResolvedValue({
          ok: true,
          json: async () => ({
            ok: true,
            result: [
              {
                update_id: 1,
                message: {
                  message_id: 5,
                  chat: { id: Number(TEST_CHAT_ID) },
                  text: "old",
                },
              },
            ],
          }),
        }),
    );

    // sentId=10, message_id=5 → ignored → loops until timeout (-1 = immediate)
    const reply = await helpers.pollReply(10, TEST_CHAT_ID, -1);
    expect(reply).toBeNull();
  });

  it("survives drain errors gracefully", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockRejectedValueOnce(new Error("drain fail"))
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            ok: true,
            result: [
              {
                update_id: 300,
                message: {
                  message_id: 60,
                  chat: { id: Number(TEST_CHAT_ID) },
                  text: "still works",
                },
              },
            ],
          }),
        }),
    );

    const reply = await helpers.pollReply(10, TEST_CHAT_ID, 60000);
    expect(reply).toBe("still works");
  });

  it("retries on non-ok poll responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ ok: true, result: [] }),
        })
        .mockResolvedValueOnce({ ok: false, status: 500 })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            ok: true,
            result: [
              {
                update_id: 999,
                message: {
                  message_id: 70,
                  chat: { id: Number(TEST_CHAT_ID) },
                  text: "recovered",
                },
              },
            ],
          }),
        }),
    );

    const reply = await helpers.pollReply(10, TEST_CHAT_ID, 60000);
    expect(reply).toBe("recovered");
  });
});

// ── getBotId ──────────────────────────────────────────────────────

describe("getBotId", () => {
  it("returns bot ID from getMe", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true, result: { id: 123456 } }),
      }),
    );
    const id = await helpers.getBotId();
    expect(id).toBe(123456);
  });

  it("returns null on API error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("fail")));
    const id = await helpers.getBotId();
    expect(id).toBeNull();
  });
});

// ── seedLastUpdateId ──────────────────────────────────────────────

describe("seedLastUpdateId", () => {
  it("returns existing when non-zero", async () => {
    expect(await helpers.seedLastUpdateId(42)).toBe(42);
  });

  it("fetches latest update_id when 0", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          ok: true,
          result: [{ update_id: 5 }, { update_id: 15 }],
        }),
      }),
    );
    expect(await helpers.seedLastUpdateId(0)).toBe(15);
  });

  it("returns 0 when fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("fail")));
    expect(await helpers.seedLastUpdateId(0)).toBe(0);
  });

  it("returns 0 when result is empty", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true, result: [] }),
      }),
    );
    expect(await helpers.seedLastUpdateId(0)).toBe(0);
  });

  it("returns 0 on non-ok response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false }),
    );
    expect(await helpers.seedLastUpdateId(0)).toBe(0);
  });
});

// ── pollUpdates ───────────────────────────────────────────────────

describe("pollUpdates", () => {
  it("calls onMessage for valid text from configured chat", async () => {
    const controller = new AbortController();
    const onMessage = vi.fn();
    const onUpdateId = vi.fn();

    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => {
        calls++;
        if (calls === 1) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              ok: true,
              result: [
                {
                  update_id: 100,
                  message: {
                    message_id: 1,
                    chat: { id: Number(TEST_CHAT_ID) },
                    from: { id: 999, is_bot: false },
                    text: "Hello agent!",
                  },
                },
              ],
            }),
          });
        }
        controller.abort();
        return Promise.reject(
          Object.assign(new Error("aborted"), { name: "AbortError" }),
        );
      }),
    );

    // pollUpdates has 5s delay between polls — this test takes ~5s
    await helpers.pollUpdates(
      TEST_TOKEN, TEST_CHAT_ID, 12345, 0,
      controller.signal, onMessage, vi.fn(), vi.fn(), onUpdateId,
    );

    expect(onMessage).toHaveBeenCalledWith("Hello agent!");
    expect(onUpdateId).toHaveBeenCalledWith(100);
  }, 15000);

  it("ignores messages from the bot itself", async () => {
    const controller = new AbortController();
    const onMessage = vi.fn();
    const onUpdateId = vi.fn();

    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => {
        calls++;
        if (calls === 1) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              ok: true,
              result: [
                {
                  update_id: 200,
                  message: {
                    message_id: 2,
                    chat: { id: Number(TEST_CHAT_ID) },
                    from: { id: 12345, is_bot: true },
                    text: "Self message",
                  },
                },
              ],
            }),
          });
        }
        controller.abort();
        return Promise.reject(
          Object.assign(new Error("aborted"), { name: "AbortError" }),
        );
      }),
    );

    await helpers.pollUpdates(
      TEST_TOKEN, TEST_CHAT_ID, 12345, 0,
      controller.signal, onMessage, vi.fn(), vi.fn(), onUpdateId,
    );

    expect(onMessage).not.toHaveBeenCalled();
    expect(onUpdateId).toHaveBeenCalledWith(200);
  }, 15000);

  it("routes voice notes to onVoice and skips onMessage", async () => {
    const controller = new AbortController();
    const onMessage = vi.fn();
    const onVoice = vi.fn();
    const onUpdateId = vi.fn();
    globalThis.fetch = vi.fn(async () => {
      controller.abort();
      return new Response(
        JSON.stringify({
          ok: true,
          result: [{
            update_id: 150,
            message: {
              message_id: 1,
              chat: { id: TEST_CHAT_ID },
              from: { id: TEST_CHAT_ID, is_bot: false },
              voice: { file_id: "VOICE1", file_unique_id: "U1", duration: 7, mime_type: "audio/ogg" },
            },
          }],
        }),
        { status: 200 },
      );
    });
    await helpers.pollUpdates(
      TEST_TOKEN, TEST_CHAT_ID, 12345, 0,
      controller.signal, onMessage, vi.fn(), onVoice, onUpdateId,
    );
    expect(onVoice).toHaveBeenCalledWith("VOICE1", 7);
    expect(onMessage).not.toHaveBeenCalled();
  }, 15000);

  it("ignores messages from other chats", async () => {
    const controller = new AbortController();
    const onMessage = vi.fn();
    const onUpdateId = vi.fn();

    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => {
        calls++;
        if (calls === 1) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              ok: true,
              result: [
                {
                  update_id: 300,
                  message: {
                    message_id: 3,
                    chat: { id: 11111 },
                    from: { id: 999, is_bot: false },
                    text: "Wrong chat",
                  },
                },
              ],
            }),
          });
        }
        controller.abort();
        return Promise.reject(
          Object.assign(new Error("aborted"), { name: "AbortError" }),
        );
      }),
    );

    await helpers.pollUpdates(
      TEST_TOKEN, TEST_CHAT_ID, 12345, 0,
      controller.signal, onMessage, vi.fn(), vi.fn(), onUpdateId,
    );

    expect(onMessage).not.toHaveBeenCalled();
    expect(onUpdateId).toHaveBeenCalledWith(300);
  }, 15000);

  it("skips callback_query updates", async () => {
    const controller = new AbortController();
    const onMessage = vi.fn();
    const onUpdateId = vi.fn();

    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => {
        calls++;
        if (calls === 1) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              ok: true,
              result: [
                {
                  update_id: 400,
                  callback_query: { id: "cb-x", data: "yes" },
                },
              ],
            }),
          });
        }
        controller.abort();
        return Promise.reject(
          Object.assign(new Error("aborted"), { name: "AbortError" }),
        );
      }),
    );

    await helpers.pollUpdates(
      TEST_TOKEN, TEST_CHAT_ID, 12345, 0,
      controller.signal, onMessage, vi.fn(), vi.fn(), onUpdateId,
    );

    expect(onMessage).not.toHaveBeenCalled();
    expect(onUpdateId).toHaveBeenCalledWith(400);
  }, 15000);

  it("retries on non-ok responses", async () => {
    const controller = new AbortController();
    const onMessage = vi.fn();
    const onUpdateId = vi.fn();

    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => {
        calls++;
        if (calls === 1) {
          return Promise.resolve({ ok: false, status: 500 });
        }
        if (calls === 2) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              ok: true,
              result: [
                {
                  update_id: 500,
                  message: {
                    message_id: 5,
                    chat: { id: Number(TEST_CHAT_ID) },
                    from: { id: 999, is_bot: false },
                    text: "recovered",
                  },
                },
              ],
            }),
          });
        }
        controller.abort();
        return Promise.reject(
          Object.assign(new Error("aborted"), { name: "AbortError" }),
        );
      }),
    );

    await helpers.pollUpdates(
      TEST_TOKEN, TEST_CHAT_ID, 12345, 0,
      controller.signal, onMessage, vi.fn(), vi.fn(), onUpdateId,
    );

    expect(onMessage).toHaveBeenCalledWith("recovered");
  }, 20000);

  it("handles network errors with retry", async () => {
    const controller = new AbortController();
    const onMessage = vi.fn();
    const onUpdateId = vi.fn();

    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => {
        calls++;
        if (calls <= 2) return Promise.reject(new Error("ECONNRESET"));
        if (calls === 3) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              ok: true,
              result: [
                {
                  update_id: 600,
                  message: {
                    message_id: 6,
                    chat: { id: Number(TEST_CHAT_ID) },
                    from: { id: 999, is_bot: false },
                    text: "eventually",
                  },
                },
              ],
            }),
          });
        }
        controller.abort();
        return Promise.reject(
          Object.assign(new Error("aborted"), { name: "AbortError" }),
        );
      }),
    );

    await helpers.pollUpdates(
      TEST_TOKEN, TEST_CHAT_ID, 12345, 0,
      controller.signal, onMessage, vi.fn(), vi.fn(), onUpdateId,
    );

    expect(onMessage).toHaveBeenCalledWith("eventually");
  }, 25000);

  it("stops gracefully when aborted immediately", async () => {
    const controller = new AbortController();
    controller.abort();
    const onMessage = vi.fn();
    const onUpdateId = vi.fn();

    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(
        Object.assign(new Error("aborted"), { name: "AbortError" }),
      ),
    );

    await helpers.pollUpdates(
      TEST_TOKEN, TEST_CHAT_ID, 12345, 0,
      controller.signal, onMessage, vi.fn(), vi.fn(), onUpdateId,
    );

    expect(onMessage).not.toHaveBeenCalled();
  });

  it("handles !data.ok with retry", async () => {
    const controller = new AbortController();
    const onMessage = vi.fn();
    const onUpdateId = vi.fn();

    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => {
        calls++;
        if (calls === 1) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ ok: false, result: [] }),
          });
        }
        if (calls === 2) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              ok: true,
              result: [
                {
                  update_id: 700,
                  message: {
                    message_id: 7,
                    chat: { id: Number(TEST_CHAT_ID) },
                    from: { id: 999, is_bot: false },
                    text: "after not-ok",
                  },
                },
              ],
            }),
          });
        }
        controller.abort();
        return Promise.reject(
          Object.assign(new Error("aborted"), { name: "AbortError" }),
        );
      }),
    );

    await helpers.pollUpdates(
      TEST_TOKEN, TEST_CHAT_ID, 12345, 0,
      controller.signal, onMessage, vi.fn(), vi.fn(), onUpdateId,
    );

    expect(onMessage).toHaveBeenCalledWith("after not-ok");
  }, 20000);

  it("ignores messages without text field", async () => {
    const controller = new AbortController();
    const onMessage = vi.fn();
    const onUpdateId = vi.fn();

    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => {
        calls++;
        if (calls === 1) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              ok: true,
              result: [
                {
                  update_id: 800,
                  message: {
                    message_id: 8,
                    chat: { id: Number(TEST_CHAT_ID) },
                    from: { id: 999, is_bot: false },
                    // no text — e.g., photo, sticker
                  },
                },
              ],
            }),
          });
        }
        controller.abort();
        return Promise.reject(
          Object.assign(new Error("aborted"), { name: "AbortError" }),
        );
      }),
    );

    await helpers.pollUpdates(
      TEST_TOKEN, TEST_CHAT_ID, 12345, 0,
      controller.signal, onMessage, vi.fn(), vi.fn(), onUpdateId,
    );

    expect(onMessage).not.toHaveBeenCalled();
  }, 15000);
});
