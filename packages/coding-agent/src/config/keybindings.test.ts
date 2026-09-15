import { expect, test } from "bun:test";
import { KeybindingsManager } from "./keybindings";

test("effective config matches dispatch keys when a user binding claims the fallback", () => {
	const manager = KeybindingsManager.inMemory({ "app.retry": "shift+up" });
	const effective = manager.getEffectiveConfig();
	const dequeue = effective["app.message.dequeue"];
	const keys = Array.isArray(dequeue) ? dequeue : [dequeue];
	// Dispatch (getKeys) drops the shift+up fallback because app.retry claims
	// it; the diagnostics-visible config must agree.
	expect(keys).toEqual(manager.getKeys("app.message.dequeue"));
	expect(keys).not.toContain("shift+up");
});

test("the dequeue fallback stays in the effective config without a claiming binding", () => {
	const manager = KeybindingsManager.inMemory({});
	const dequeue = manager.getEffectiveConfig()["app.message.dequeue"];
	const keys = Array.isArray(dequeue) ? dequeue : [dequeue];
	expect(keys).toContain("shift+up");
});
