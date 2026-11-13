import { describe, expect, it, vi } from "vitest";
import { deliverMode, forwardToAgent } from "../forward";

const busy = () =>
	new Error(
		"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
	);

describe("deliverMode", () => {
	it("defaults to followUp", () => {
		expect(deliverMode({} as NodeJS.ProcessEnv)).toBe("followUp");
		expect(deliverMode({ PI_TELEGRAM_DELIVER_AS: "nonsense" } as NodeJS.ProcessEnv)).toBe("followUp");
	});

	it("honours steer", () => {
		expect(deliverMode({ PI_TELEGRAM_DELIVER_AS: "Steer" } as NodeJS.ProcessEnv)).toBe("steer");
	});
});

describe("forwardToAgent", () => {
	it("sends plainly when the agent is idle", async () => {
		const sendUserMessage = vi.fn(async () => {});
		const result = await forwardToAgent({ sendUserMessage } as never, "ciao", {} as NodeJS.ProcessEnv);
		expect(result).toBe("sent");
		expect(sendUserMessage).toHaveBeenCalledWith("ciao");
	});

	it("queues as followUp when the agent is busy", async () => {
		const sendUserMessage = vi
			.fn()
			.mockRejectedValueOnce(busy())
			.mockResolvedValueOnce(undefined);
		const result = await forwardToAgent({ sendUserMessage } as never, "ciao", {} as NodeJS.ProcessEnv);
		expect(result).toBe("queued");
		expect(sendUserMessage).toHaveBeenNthCalledWith(2, "ciao", { deliverAs: "followUp" });
	});

	it("queues as steer when configured", async () => {
		const sendUserMessage = vi
			.fn()
			.mockRejectedValueOnce(busy())
			.mockResolvedValueOnce(undefined);
		await forwardToAgent({ sendUserMessage } as never, "urgente", {
			PI_TELEGRAM_DELIVER_AS: "steer",
		} as NodeJS.ProcessEnv);
		expect(sendUserMessage).toHaveBeenNthCalledWith(2, "urgente", { deliverAs: "steer" });
	});

	it("rethrows unrelated errors instead of hiding them", async () => {
		const sendUserMessage = vi.fn(async () => {
			throw new Error("network down");
		});
		await expect(
			forwardToAgent({ sendUserMessage } as never, "ciao", {} as NodeJS.ProcessEnv),
		).rejects.toThrow("network down");
	});
});
