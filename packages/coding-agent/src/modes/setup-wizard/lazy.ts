import type { InteractiveModeContext } from "../types";

/** `all` re-runs the full onboarding walkthrough; `providers` re-runs only the sign-in/web-search step. */
export type SetupWizardScope = "all" | "providers";

export async function runSetupWizardScope(ctx: InteractiveModeContext, scope: SetupWizardScope): Promise<void> {
	// Deferred on purpose: this module exists so interactive mode never pulls the wizard
	// (and its scenes, OAuth selector and theme previews) into the startup graph.
	const { ALL_SCENES, runSetupWizard, SETUP_CANCELLED_NOTICE } = await import("./index");
	const scenes = scope === "all" ? [...ALL_SCENES] : ALL_SCENES.filter(scene => scene.id === "providers");
	if (scenes.length === 0) {
		ctx.showError("Setup is unavailable.");
		return;
	}
	// Only a full walkthrough can claim onboarding is done.
	const outcome = await runSetupWizard(ctx, scenes, { markComplete: scope === "all" });
	if (outcome === "cancelled") ctx.showWarning(SETUP_CANCELLED_NOTICE);
}
