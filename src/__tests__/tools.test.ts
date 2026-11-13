/**
 * pi-telegram-bridge — Tool Schema Tests
 */
import { describe, it, expect } from "vitest";
import { Value } from "typebox/value";
import {
  listenSchema,
  sendSchema,
  askSchema,
  statusSchema,
  overrideSchema,
} from "../tools/telegram";

// ── listenSchema ──────────────────────────────────────────────────

describe("listenSchema", () => {
  it("accepts empty object", () => {
    expect(Value.Check(listenSchema, {})).toBe(true);
  });

  it("still checks ok with extra properties (by default)", () => {
    // TypeBox Object doesn't strip extra by default unless additionalProperties: false
    expect(Value.Check(listenSchema, { extra: 1 })).toBe(true);
  });
});

// ── sendSchema ────────────────────────────────────────────────────

describe("sendSchema", () => {
  it("accepts valid message", () => {
    expect(Value.Check(sendSchema, { message: "Hello" })).toBe(true);
  });

  it("accepts empty message", () => {
    expect(Value.Check(sendSchema, { message: "" })).toBe(true);
  });

  it("rejects missing message", () => {
    expect(Value.Check(sendSchema, {})).toBe(false);
    expect(Value.Check(sendSchema, { message: 123 })).toBe(false);
    expect(Value.Check(sendSchema, { message: null })).toBe(false);
  });

  it("accepts long messages", () => {
    expect(Value.Check(sendSchema, { message: "x".repeat(4096) })).toBe(true);
  });
});

// ── askSchema ─────────────────────────────────────────────────────

describe("askSchema", () => {
  it("accepts minimal valid input (question only)", () => {
    expect(Value.Check(askSchema, { question: "Deploy?" })).toBe(true);
  });

  it("accepts question with options", () => {
    expect(
      Value.Check(askSchema, {
        question: "Which?",
        options: ["A", "B", "C"],
      }),
    ).toBe(true);
  });

  it("accepts question with timeoutMinutes", () => {
    expect(
      Value.Check(askSchema, {
        question: "Go?",
        timeoutMinutes: 5,
      }),
    ).toBe(true);
  });

  it("accepts all fields", () => {
    expect(
      Value.Check(askSchema, {
        question: "Full test",
        options: ["Yes", "No"],
        timeoutMinutes: 10,
      }),
    ).toBe(true);
  });

  it("rejects missing question", () => {
    expect(Value.Check(askSchema, {})).toBe(false);
    expect(Value.Check(askSchema, { question: 123 })).toBe(false);
    expect(Value.Check(askSchema, { options: ["A"] })).toBe(false);
  });

  it("accepts empty options array", () => {
    expect(
      Value.Check(askSchema, {
        question: "test",
        options: [],
      }),
    ).toBe(true);
  });

  it("rejects non-array options", () => {
    expect(
      Value.Check(askSchema, {
        question: "test",
        options: "not-array",
      }),
    ).toBe(false);
  });

  it("rejects non-number timeoutMinutes", () => {
    expect(
      Value.Check(askSchema, {
        question: "test",
        timeoutMinutes: "30",
      }),
    ).toBe(false);
  });

  it("accepts timeoutMinutes as 0", () => {
    expect(
      Value.Check(askSchema, {
        question: "test",
        timeoutMinutes: 0,
      }),
    ).toBe(true);
  });
});

// ── statusSchema ──────────────────────────────────────────────────

describe("statusSchema", () => {
  it("accepts empty object", () => {
    expect(Value.Check(statusSchema, {})).toBe(true);
  });
});

// ── overrideSchema ────────────────────────────────────────────────

describe("overrideSchema", () => {
  it("accepts required fields only", () => {
    expect(
      Value.Check(overrideSchema, {
        command: "git push --force",
        reason: "Force push detected",
      }),
    ).toBe(true);
  });

  it("rejects missing command", () => {
    expect(
      Value.Check(overrideSchema, {
        reason: "test",
      }),
    ).toBe(false);
  });

  it("rejects missing reason", () => {
    expect(
      Value.Check(overrideSchema, {
        command: "rm -rf /",
      }),
    ).toBe(false);
  });

  it("accepts all optional fields", () => {
    expect(
      Value.Check(overrideSchema, {
        command: "rm -rf node_modules",
        reason: "Outside project boundary",
        context: "User requested clean reinstall",
        options: ["Yes", "No", "Maybe", "Explain"],
        timeoutMinutes: 15,
      }),
    ).toBe(true);
  });

  it("accepts empty options array", () => {
    expect(
      Value.Check(overrideSchema, {
        command: "test",
        reason: "test",
        options: [],
      }),
    ).toBe(true);
  });

  it("rejects non-string command", () => {
    expect(
      Value.Check(overrideSchema, {
        command: 123,
        reason: "test",
      }),
    ).toBe(false);
  });

  it("rejects non-string reason", () => {
    expect(
      Value.Check(overrideSchema, {
        command: "test",
        reason: null,
      }),
    ).toBe(false);
  });

  it("rejects non-string context", () => {
    expect(
      Value.Check(overrideSchema, {
        command: "test",
        reason: "test",
        context: 123,
      }),
    ).toBe(false);
  });

  it("rejects non-array options", () => {
    expect(
      Value.Check(overrideSchema, {
        command: "test",
        reason: "test",
        options: "yes,no",
      }),
    ).toBe(false);
  });

  it("rejects non-number timeoutMinutes", () => {
    expect(
      Value.Check(overrideSchema, {
        command: "test",
        reason: "test",
        timeoutMinutes: "10",
      }),
    ).toBe(false);
  });

  it("accepts timeoutMinutes as 0", () => {
    expect(
      Value.Check(overrideSchema, {
        command: "test",
        reason: "test",
        timeoutMinutes: 0,
      }),
    ).toBe(true);
  });

  it("accepts long command and reason strings", () => {
    expect(
      Value.Check(overrideSchema, {
        command: "x".repeat(1000),
        reason: "y".repeat(1000),
      }),
    ).toBe(true);
  });
});
