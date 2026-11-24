import type { InteractiveModeContext } from "../types";
import type { SetupScene, SetupWizardContext } from "./scenes/types";
import type { SetupWizardOutcome } from "./wizard-overlay";

/** `all` re-runs the full onboarding walkthrough; `providers` re-runs only the sign-in/web-search step. */
export type SetupWizardScope = "all" | "providers";

function scopeScenes(scenes: readonly SetupScene[], scope: SetupWizardScope): SetupScene[] {
	return scope === "all" ? [...scenes] : scenes.filter(scene => scene.id === "providers");
}

export async function runSetupWizardScope(ctx: InteractiveModeContext, scope: SetupWizardScope): Promise<void> {
	// Deferred on purpose: this module exists so interactive mode never pulls the wizard
	// (and its scenes, OAuth selector and theme previews) into the startup graph.
	const { ALL_SCENES, runSetupWizard, SETUP_CANCELLED_NOTICE } = await import("./index");
	const scenes = scopeScenes(ALL_SCENES, scope);
	if (scenes.length === 0) {
		ctx.showError("Setup is unavailable.");
		return;
	}
	// Only a full walkthrough can claim onboarding is done.
	const outcome = await runSetupWizard(ctx, scenes, { markComplete: scope === "all" });
	if (outcome === "cancelled") ctx.showWarning(SETUP_CANCELLED_NOTICE);
}

/**
 * ACP terminal auth shows only the sign-in step and exits on how it ended, so the outcome comes back to
 * the caller instead of surfacing as a notice, and onboarding is never recorded as done. Input still in
 * flight (the release of the key that ended the step) is drained while the step covers the screen, so
 * the caller can stop the UI as soon as this resolves, before another frame is drawn.
 */
export async function runProvidersSetupStep(ctx: SetupWizardContext): Promise<SetupWizardOutcome> {
	const { ALL_SCENES, runSetupWizard } = await import("./index");
	return runSetupWizard(ctx, scopeScenes(ALL_SCENES, "providers"), {
		markComplete: false,
		beforeClose: () => ctx.ui.terminal.drainInput(),
	});
}
