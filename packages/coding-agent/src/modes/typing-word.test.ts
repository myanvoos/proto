import { expect, test } from "bun:test";
import { TypingWordTracker } from "./typing-word";

test("typo suppression follows only the actively edited word and ends on caret departure or blur", () => {
	const tracker = new TypingWordTracker();
	tracker.update(0, ["restored"], 0, 8, true);
	expect(tracker.word).toBeUndefined();
	tracker.update(1, ["restored recieved"], 0, 17, true);
	expect(tracker.word).toEqual({ line: 0, start: 9, end: 17 });
	tracker.update(1, ["restored recieved"], 0, 12, true);
	expect(tracker.word).toEqual({ line: 0, start: 9, end: 17 });
	tracker.update(1, ["restored recieved"], 0, 8, true);
	expect(tracker.word).toBeUndefined();
	tracker.update(2, ["restored recievedx"], 0, 18, true);
	tracker.update(2, ["restored recievedx"], 0, 18, false);
	expect(tracker.word).toBeUndefined();
});
