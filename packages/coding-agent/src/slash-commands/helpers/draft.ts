import type { TuiSlashCommandRuntime } from "../types";

export function clearSubmittedText(runtime: TuiSlashCommandRuntime, clearAttachments = false): void {
	if (runtime.draftDetached) return;
	if (clearAttachments) runtime.ctx.editor.clearDraft();
	else runtime.ctx.editor.setText("");
}
