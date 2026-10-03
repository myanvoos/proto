import { expect, test } from "bun:test";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import type { InteractiveModeContext } from "../modes/types";
import { runWithDetachedModeDraft } from "./builtin-modes";

function detachedHarness(draft: string, draftImages: ImageContent[]) {
	const errors: string[] = [];
	const editor = {
		text: draft,
		pendingImages: [...draftImages],
		pendingImageLinks: draftImages.map(() => undefined) as Array<string | undefined>,
		imageLinks: undefined as Array<string | undefined> | undefined,
		getText() {
			return this.text;
		},
		getExpandedText() {
			return this.text;
		},
		setCollapsedText(text: string) {
			this.text = text;
		},
		setText(text: string) {
			this.text = text;
		},
		clearDraft() {
			this.text = "";
		},
	};
	const ctx = { editor, showError: (message: string) => errors.push(message) } as unknown as InteractiveModeContext;
	return { ctx, editor, errors };
}

const image = (data: string): ImageContent => ({ type: "image", mimeType: "image/png", data });

test("a failed detached mode command returns beside a draft typed while it was pending", async () => {
	const newer = image("newer");
	const submitted = image("submitted");
	const { ctx, editor, errors } = detachedHarness("newer [Image #1]", [newer]);

	await runWithDetachedModeDraft(
		{ name: "goal", args: "ship it [Image #1]", text: "/goal ship it [Image #1]" },
		{ ctx, input: { images: [submitted] }, draftDetached: true },
		async () => {
			throw new Error("goal failed");
		},
	);

	expect(editor.text).toBe("/goal ship it [Image #2]\n\nnewer [Image #1]");
	expect(editor.pendingImages).toEqual([newer, submitted]);
	expect(errors).toEqual(["goal failed"]);
});
