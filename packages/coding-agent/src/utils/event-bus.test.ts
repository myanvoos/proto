import { expect, test } from "bun:test";
import { EventBus } from "./event-bus";

test("detached event methods subscribe, deliver, unsubscribe and clear on the owning bus", () => {
	const { on, emit, clear } = new EventBus();
	const received: unknown[] = [];
	const unsubscribe = on("updates", value => {
		received.push(value);
	});
	emit("updates", "first");
	unsubscribe();
	emit("updates", "ignored");
	on("updates", value => {
		received.push(value);
	});
	clear();
	emit("updates", "cleared");
	expect(received).toEqual(["first"]);
});
