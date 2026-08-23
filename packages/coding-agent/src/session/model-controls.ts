import { type Agent, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Model, ProviderSessionState, ServiceTier, ServiceTierByFamily, ServiceTierFamily } from "@oh-my-pi/pi-ai";
import {
	clearAnthropicFastModeFallback,
	type Effort,
	isAnthropicFastModeFallbackDisabled,
	realizesPriorityServiceTier,
	resolveModelServiceTier,
	serviceTierFamily,
} from "@oh-my-pi/pi-ai";
import { isFireworksFastModelId } from "@oh-my-pi/pi-catalog/fireworks-model-id";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import { modelsAreEqual } from "@oh-my-pi/pi-catalog/models";
import type { ModelRegistry } from "../config/model-registry";
import {
	filterAvailableModelsByEnabledPatterns,
	formatModelStringWithRouting,
	getModelMatchPreferences,
	type ResolvedModelRoleValue,
	resolveModelRoleValue,
} from "../config/model-resolver";
import { getKnownRoleIds } from "../config/model-roles";
import type { Settings } from "../config/settings";
import {
	clampThinkingLevelToCeiling,
	resolveThinkingLevelForModel,
	shouldDisableReasoning,
	toReasoningEffort,
} from "../thinking";
import type { EditMode } from "../utils/edit-mode";
import type { AgentSessionEvent } from "./agent-session-events";
import type { ModelCycleResult, ResolvedRoleModel, RoleModelCycle, RoleModelCycleResult } from "./agent-session-types";
import { formatRoleModelValue, resolveRoleModelFull } from "./role-models";
import { EPHEMERAL_MODEL_CHANGE_ROLE } from "./session-entries";
import type { SessionManager } from "./session-manager";

/** Capabilities borrowed from the owning AgentSession. */
export interface ModelControlsHost {
	agent: Agent;
	settings: Settings;
	modelRegistry: ModelRegistry;
	sessionManager: SessionManager;
	providerSessionState: Map<string, ProviderSessionState>;
	model(): Model | undefined;
	sessionId(): string;
	promptGeneration(): number;
	resolveActiveEditMode(): EditMode;
	syncAfterModelChange(previousEditMode: EditMode): Promise<void>;
	setModelWithProviderSessionReset(model: Model): Promise<void>;
	clearActiveRetryFallback(): void;
	clearInheritedProviderPromptCacheKey(): void;
	magicKeywordEnabled(keyword: "ultrathink" | "workflow"): boolean;
	emit(event: AgentSessionEvent): void;
	emitSessionEvent(event: AgentSessionEvent): Promise<void>;
	emitNotice(level: "info" | "warning" | "error", message: string, source?: string): void;
}

/** Owns model selection, thinking effort, role cycling, and service tiers. */
export class ModelControls {
	readonly #host: ModelControlsHost;
	#scopedModels: Array<{ model: Model; thinkingLevel?: ThinkingLevel }>;
	#thinkingLevel: ThinkingLevel | undefined;
	/** Hard per-session effort ceiling (e.g. a worker spawn's `orchestrator.maxEffort` cap); recovery paths re-clamp to it. */
	readonly #thinkingLevelCeiling: Effort | undefined;
	#serviceTierByFamily: ServiceTierByFamily;

	constructor(
		host: ModelControlsHost,
		options: {
			scopedModels?: Array<{ model: Model; thinkingLevel?: ThinkingLevel }>;
			thinkingLevel?: ThinkingLevel;
			thinkingLevelCeiling?: Effort;
			serviceTierByFamily?: ServiceTierByFamily;
		},
	) {
		this.#host = host;
		this.#scopedModels = options.scopedModels ?? [];
		this.#serviceTierByFamily = options.serviceTierByFamily ?? {};
		this.#thinkingLevelCeiling = options.thinkingLevelCeiling;
		this.#thinkingLevel = clampThinkingLevelToCeiling(this.#model, options.thinkingLevel, this.#thinkingLevelCeiling);
		this.#applyThinkingLevelToAgent(this.#thinkingLevel);
	}

	get #model(): Model | undefined {
		return this.#host.model();
	}

	/** Effective metadata-clamped thinking level applied to the agent. */
	get thinkingLevel(): ThinkingLevel | undefined {
		return this.#thinkingLevel;
	}

	/** Hard per-session effort ceiling every thinking-level change is clamped to. */
	get thinkingLevelCeiling(): Effort | undefined {
		return this.#thinkingLevelCeiling;
	}

	/** Effective thinking level applied to the agent. */
	configuredThinkingLevel(): ThinkingLevel | undefined {
		return this.#thinkingLevel;
	}

	/** Models explicitly scoped to the session's cycle command. */
	get scopedModels(): ReadonlyArray<{ model: Model; thinkingLevel?: ThinkingLevel }> {
		return this.#scopedModels;
	}

	/**
	 * Replace the Ctrl+P cycle scope. Startup resolves the scope before background
	 * provider discovery runs; the CLI re-pushes the fuller list here once discovery
	 * completes so a newly-discovered `enabledModels` model joins the cycle and the
	 * scoped `/models` picker (issue #9220).
	 */
	setScopedModels(scopedModels: Array<{ model: Model; thinkingLevel?: ThinkingLevel }>): void {
		this.#scopedModels = scopedModels;
	}

	/** Live per-provider-family service-tier selection. */
	get serviceTierByFamily(): ServiceTierByFamily {
		return this.#serviceTierByFamily;
	}

	/** Restores thinking state from a transcript without persisting a new entry. */
	restoreThinkingLevel(level: ThinkingLevel | undefined): void {
		this.#thinkingLevel = resolveThinkingLevelForModel(
			this.#model,
			clampThinkingLevelToCeiling(this.#model, level, this.#thinkingLevelCeiling),
		);
		this.#applyThinkingLevelToAgent(this.#thinkingLevel);
	}

	/** Restores service tiers without persisting a duplicate transcript entry. */
	restoreServiceTiers(tiers: ServiceTierByFamily): void {
		this.#serviceTierByFamily = tiers;
	}
	resolveRoleModel(role: string): Model | undefined {
		return resolveRoleModelFull(this.#host.settings, role, this.#host.modelRegistry.getAvailable(), this.#model)
			.model;
	}

	resolveRoleModelWithThinking(role: string): ResolvedModelRoleValue {
		return resolveRoleModelFull(this.#host.settings, role, this.#host.modelRegistry.getAvailable(), this.#model);
	}

	resolveTemporaryModelThinkingLevel(model: Model): ThinkingLevel | undefined {
		const availableModels = this.#host.modelRegistry.getAvailable();
		if (availableModels.length === 0) return undefined;

		const matchPreferences = getModelMatchPreferences(this.#host.settings);
		for (const role of getKnownRoleIds(this.#host.settings)) {
			const roleValue = this.#host.settings.getModelRole(role);
			if (!roleValue) continue;

			const resolved = resolveModelRoleValue(roleValue, availableModels, {
				settings: this.#host.settings,
				matchPreferences,
			});
			if (!resolved.explicitThinkingLevel || resolved.thinkingLevel === undefined || !resolved.model) continue;
			if (modelsAreEqual(resolved.model, model)) return resolved.thinkingLevel;
		}

		return undefined;
	}

	async setModel(
		model: Model,
		role: string = "default",
		options?: {
			selector?: string;
			thinkingLevel?: ThinkingLevel;
			persist?: boolean;
		},
	): Promise<{ switched: boolean }> {
		const previousEditMode = this.#host.resolveActiveEditMode();
		if (!this.#host.modelRegistry.hasConfiguredAuth(model)) {
			throw new Error(`No API key for ${model.provider}/${model.id}`);
		}

		const targetModel = await this.#host.modelRegistry.refreshSelectedModelMetadata(model);

		this.#host.modelRegistry.clearSuppressedSelector(formatModelStringWithRouting(targetModel));
		this.#host.clearActiveRetryFallback();
		await this.#host.setModelWithProviderSessionReset(targetModel);
		this.#host.sessionManager.appendModelChange(`${targetModel.provider}/${targetModel.id}`, role);
		if (options?.persist) {
			this.#host.settings.setModelRole(
				role,
				formatRoleModelValue(
					this.#host.settings,
					this.#host.modelRegistry,
					role,
					targetModel,
					options.selector,
					options.thinkingLevel,
				),
			);
		}
		this.#host.settings.getStorage()?.recordModelUsage(`${targetModel.provider}/${targetModel.id}`);

		// Re-apply thinking for the newly selected model. Prefer the model's
		// configured defaultLevel; otherwise preserve the current level (or auto).
		this.#reapplyThinkingLevel(targetModel.thinking?.defaultLevel);
		await this.#host.syncAfterModelChange(previousEditMode);
		return { switched: true };
	}

	/**
	 * Set model temporarily (for this session only).
	 * Validates that a credential source is configured (synchronously, without
	 * refreshing OAuth or running command-backed key programs), saves to session
	 * log but NOT to settings.
	 * @throws Error if no API key available for the model
	 */
	async setModelTemporary(
		model: Model,
		thinkingLevel?: ThinkingLevel,
		options?: { ephemeral?: boolean },
	): Promise<void> {
		const previousEditMode = this.#host.resolveActiveEditMode();
		if (!this.#host.modelRegistry.hasConfiguredAuth(model)) {
			throw new Error(`No API key for ${model.provider}/${model.id}`);
		}

		const targetModel = await this.#host.modelRegistry.refreshSelectedModelMetadata(model);

		this.#host.modelRegistry.clearSuppressedSelector(formatModelStringWithRouting(targetModel));
		this.#host.clearActiveRetryFallback();
		await this.#host.setModelWithProviderSessionReset(targetModel);
		this.#host.sessionManager.appendModelChange(
			`${targetModel.provider}/${targetModel.id}`,
			options?.ephemeral ? EPHEMERAL_MODEL_CHANGE_ROLE : "temporary",
		);
		this.#host.settings.getStorage()?.recordModelUsage(`${targetModel.provider}/${targetModel.id}`);

		// Apply explicit thinking level if given; otherwise prefer the model's
		// configured defaultLevel; otherwise re-clamp the current level (or auto).
		if (thinkingLevel !== undefined) {
			this.setThinkingLevel(thinkingLevel);
		} else {
			this.#reapplyThinkingLevel(targetModel.thinking?.defaultLevel);
		}
		await this.#host.syncAfterModelChange(previousEditMode);
	}

	/**
	 * Cycle to next/previous model.
	 * Uses scoped models (from --models flag) if available, otherwise all available models.
	 * @param direction - "forward" (default) or "backward"
	 * @returns The new model info, or undefined if only one model available
	 */
	async cycleModel(direction: "forward" | "backward" = "forward"): Promise<ModelCycleResult | undefined> {
		if (this.#scopedModels.length > 0) {
			return this.#cycleScopedModel(direction);
		}
		return this.#cycleAvailableModel(direction);
	}

	/**
	 * Resolve the configured role models in the given order plus the index of
	 * the currently active one. Roles that have no configured model, or whose
	 * configured model is not currently available, are skipped. The `default`
	 * role falls back to the active model when no explicit assignment exists.
	 *
	 * Returns `undefined` only when there is no current model or no available
	 * models at all; an empty `models` array is never returned (callers should
	 * still guard on `models.length`).
	 */
	getRoleModelCycle(roleOrder: readonly string[]): RoleModelCycle | undefined {
		const availableModels = this.#host.modelRegistry.getAvailable();
		if (availableModels.length === 0) return undefined;

		const currentModel = this.#model;
		if (!currentModel) return undefined;
		const matchPreferences = getModelMatchPreferences(this.#host.settings);
		const models: ResolvedRoleModel[] = [];

		for (const role of roleOrder) {
			const roleModelStr =
				role === "default"
					? (this.#host.settings.getModelRole("default") ?? `${currentModel.provider}/${currentModel.id}`)
					: this.#host.settings.getModelRole(role);
			if (!roleModelStr) continue;

			const resolved = resolveModelRoleValue(roleModelStr, availableModels, {
				settings: this.#host.settings,
				matchPreferences,
			});
			if (!resolved.model) continue;

			models.push({
				role,
				model: resolved.model,
				thinkingLevel: resolved.thinkingLevel,
				explicitThinkingLevel: resolved.explicitThinkingLevel,
			});
		}

		if (models.length === 0) return undefined;

		// Trust the recorded role only while its resolved model still IS the
		// active model. A model switch through another surface (alt+m, retry
		// fallback, /model) or a role re-configuration leaves the recorded role
		// pointing at a model the session no longer runs; cycling from that
		// stale slot lands on the wrong neighbor and reads as a skipped entry.
		const lastRole = this.#host.sessionManager.getLastModelChangeRole();
		let currentIndex = lastRole ? models.findIndex(entry => entry.role === lastRole) : -1;
		if (currentIndex !== -1 && !modelsAreEqual(models[currentIndex].model, currentModel)) {
			currentIndex = -1;
		}
		if (currentIndex === -1) {
			currentIndex = models.findIndex(entry => modelsAreEqual(entry.model, currentModel));
		}
		if (currentIndex === -1) currentIndex = 0;

		return { models, currentIndex };
	}

	/**
	 * Apply a resolved role model as the active model without changing global
	 * settings. Shared with role cycling and the plan-approval model slider.
	 */
	async applyRoleModel(entry: ResolvedRoleModel): Promise<void> {
		await this.setModel(entry.model, entry.role);
		if (entry.explicitThinkingLevel && entry.thinkingLevel !== undefined) {
			this.setThinkingLevel(entry.thinkingLevel);
		}
	}

	/**
	 * Cycle through configured role models in a fixed order.
	 * Skips missing roles and changes only the active session model.
	 * @param roleOrder - Order of roles to cycle through (e.g., ["slow", "default", "smol"])
	 * @param direction - "forward" (default) or "backward"
	 */
	async cycleRoleModels(
		roleOrder: readonly string[],
		direction: "forward" | "backward" = "forward",
	): Promise<RoleModelCycleResult | undefined> {
		const cycle = this.getRoleModelCycle(roleOrder);
		if (!cycle || cycle.models.length <= 1) return undefined;

		const step = direction === "backward" ? -1 : 1;
		const next = cycle.models[(cycle.currentIndex + step + cycle.models.length) % cycle.models.length];

		await this.applyRoleModel(next);

		return { model: next.model, thinkingLevel: this.thinkingLevel, role: next.role };
	}

	async #getScopedModelsWithApiKey(): Promise<Array<{ model: Model; thinkingLevel?: ThinkingLevel }>> {
		const apiKeysByProvider = new Map<string, string | undefined>();
		const result: Array<{ model: Model; thinkingLevel?: ThinkingLevel }> = [];

		for (const scoped of this.#scopedModels) {
			const provider = scoped.model.provider;
			let apiKey: string | undefined;
			if (apiKeysByProvider.has(provider)) {
				apiKey = apiKeysByProvider.get(provider);
			} else {
				apiKey = await this.#host.modelRegistry.getApiKeyForProvider(provider, this.#host.sessionId());
				apiKeysByProvider.set(provider, apiKey);
			}

			if (apiKey) {
				result.push(scoped);
			}
		}

		return result;
	}

	async #cycleScopedModel(direction: "forward" | "backward"): Promise<ModelCycleResult | undefined> {
		const previousEditMode = this.#host.resolveActiveEditMode();
		const scopedModels = await this.#getScopedModelsWithApiKey();
		if (scopedModels.length <= 1) return undefined;

		const currentModel = this.#model;
		let currentIndex = scopedModels.findIndex(sm => modelsAreEqual(sm.model, currentModel));

		if (currentIndex === -1) currentIndex = 0;
		const len = scopedModels.length;
		const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		const next = scopedModels[nextIndex];

		// Apply model
		this.#host.modelRegistry.clearSuppressedSelector(formatModelStringWithRouting(next.model));
		this.#host.clearActiveRetryFallback();
		await this.#host.setModelWithProviderSessionReset(next.model);
		this.#host.sessionManager.appendModelChange(`${next.model.provider}/${next.model.id}`);
		this.#host.settings.getStorage()?.recordModelUsage(`${next.model.provider}/${next.model.id}`);

		// Apply the scoped model's configured thinking level.
		this.setThinkingLevel(next.thinkingLevel);
		await this.#host.syncAfterModelChange(previousEditMode);

		return { model: next.model, thinkingLevel: this.thinkingLevel, isScoped: true };
	}

	async #cycleAvailableModel(direction: "forward" | "backward"): Promise<ModelCycleResult | undefined> {
		const previousEditMode = this.#host.resolveActiveEditMode();
		const availableModels = this.#host.modelRegistry.getAvailable();
		if (availableModels.length <= 1) return undefined;

		const currentModel = this.#model;
		let currentIndex = availableModels.findIndex(m => modelsAreEqual(m, currentModel));

		if (currentIndex === -1) currentIndex = 0;
		const len = availableModels.length;
		const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		const nextModel = availableModels[nextIndex];

		const apiKey = await this.#host.modelRegistry.getApiKey(nextModel, this.#host.sessionId());
		if (!apiKey) {
			throw new Error(`No API key for ${nextModel.provider}/${nextModel.id}`);
		}

		this.#host.modelRegistry.clearSuppressedSelector(formatModelStringWithRouting(nextModel));
		this.#host.clearActiveRetryFallback();
		await this.#host.setModelWithProviderSessionReset(nextModel);
		this.#host.sessionManager.appendModelChange(`${nextModel.provider}/${nextModel.id}`);
		this.#host.settings.getStorage()?.recordModelUsage(`${nextModel.provider}/${nextModel.id}`);
		// Re-apply the current thinking level (or auto) for the newly selected model
		this.#reapplyThinkingLevel();
		await this.#host.syncAfterModelChange(previousEditMode);

		return { model: nextModel, thinkingLevel: this.thinkingLevel, isScoped: false };
	}

	/**
	 * Get all available models with valid API keys, filtered by `enabledModels` when configured.
	 * See {@link filterAvailableModelsByEnabledPatterns} for supported pattern forms and limitations.
	 */
	getAvailableModels(): Model[] {
		const all = this.#host.modelRegistry.getAvailable();
		const patterns = this.#host.settings.get("enabledModels");
		if (!patterns || patterns.length === 0) return all;
		return filterAvailableModelsByEnabledPatterns(all, patterns, this.#host.settings);
	}

	// =========================================================================
	// Thinking Level Management
	// =========================================================================

	#applyThinkingLevelToAgent(level: ThinkingLevel | undefined): void {
		this.#host.agent.setThinkingLevel(toReasoningEffort(level));
		this.#host.agent.setDisableReasoning(shouldDisableReasoning(level));
	}

	/**
	 * Set the thinking level.
	 */
	setThinkingLevel(level: ThinkingLevel | undefined, persist: boolean = false): void {
		const effectiveLevel = resolveThinkingLevelForModel(
			this.#model,
			clampThinkingLevelToCeiling(this.#model, level, this.#thinkingLevelCeiling),
		);
		const isChanging = effectiveLevel !== this.#thinkingLevel;

		this.#thinkingLevel = effectiveLevel;
		this.#applyThinkingLevelToAgent(effectiveLevel);

		if (isChanging) {
			this.#host.clearInheritedProviderPromptCacheKey();
			this.#host.sessionManager.appendThinkingLevelChange(effectiveLevel);
			if (persist && effectiveLevel !== undefined && effectiveLevel !== ThinkingLevel.Off) {
				this.#host.settings.set("defaultThinkingLevel", effectiveLevel);
			}
			this.#host.emit({ type: "thinking_level_changed", thinkingLevel: effectiveLevel });
		}
	}

	/**
	 * Re-apply the active thinking selection after a model change. Re-applies the
	 * preferred default or the current effective level.
	 */
	#reapplyThinkingLevel(preferredDefault?: ThinkingLevel): void {
		this.setThinkingLevel(preferredDefault ?? this.#thinkingLevel);
	}

	/**
	 * Cycle to next thinking level: off → minimal..max → off.
	 * @returns New selector, or undefined if model doesn't support thinking
	 */
	cycleThinkingLevel(): ThinkingLevel | undefined {
		if (!this.#model?.reasoning) return undefined;

		const levels: ThinkingLevel[] = [ThinkingLevel.Off, ...this.getAvailableThinkingLevels()];
		const currentLevel = this.#thinkingLevel === ThinkingLevel.Inherit ? ThinkingLevel.Off : this.#thinkingLevel;
		const currentIndex = currentLevel ? levels.indexOf(currentLevel) : -1;
		const nextIndex = (currentIndex + 1) % levels.length;
		const nextLevel = levels[nextIndex];
		if (!nextLevel) return undefined;

		this.setThinkingLevel(nextLevel);
		return nextLevel;
	}

	/**
	 * True when the currently selected model's family is set to `priority` — the
	 * `/fast` on/off state for the active model. Returns false when no model is
	 * selected or the model exposes no service-tier family (e.g. Fireworks, which
	 * has its own Providers › Fireworks Tier toggle).
	 *
	 * For "is priority actually applied to the next request?" use
	 * {@link isFastModeActive} instead.
	 */
	isFastModeEnabled(): boolean {
		const family = this.#model ? serviceTierFamily(this.#model) : undefined;
		return family ? this.#serviceTierByFamily[family] === "priority" : false;
	}

	/**
	 * True when `priority` is actually realized on the wire for the currently
	 * selected model (OpenAI/Google `service_tier`, direct Anthropic fast mode,
	 * or Fireworks priority). Returns false for tiers the active model can't
	 * realize and when no model is selected.
	 */
	isFastModeActive(): boolean {
		const model = this.#model;
		if (!model || !realizesPriorityServiceTier(this.effectiveServiceTier(model), model)) return false;
		if (model.provider === "anthropic") {
			return !isAnthropicFastModeFallbackDisabled(this.#host.providerSessionState, model);
		}
		return true;
	}

	/**
	 * Effective wire service-tier for a request to `model`. Fireworks models take
	 * the Priority serving path only when the Providers › Fireworks Tier setting
	 * is `"priority"` (and never for `-fast` variants, whose Fast serving path is
	 * mutually exclusive with Priority). Every other model resolves the live
	 * per-family tier map down to the entry for its family.
	 */
	effectiveServiceTier(model: Model | undefined = this.#model): ServiceTier | undefined {
		if (model?.provider === "fireworks") {
			return this.#host.settings.get("providers.fireworksTier") === "priority" && !isFireworksFastModelId(model.id)
				? "priority"
				: undefined;
		}
		if (!model) return undefined;
		return resolveModelServiceTier(this.#serviceTierByFamily, model);
	}

	/** The live per-family tier map, or `null` when empty (for session persistence). */
	serviceTierEntry(): ServiceTierByFamily | null {
		return Object.keys(this.#serviceTierByFamily).length > 0 ? this.#serviceTierByFamily : null;
	}

	/** Set one family's tier (or clear it with `undefined`); persists the change. */
	setServiceTierFamily(family: ServiceTierFamily, tier: ServiceTier | undefined): void {
		if (this.#serviceTierByFamily[family] === tier) return;
		const next: ServiceTierByFamily = { ...this.#serviceTierByFamily };
		if (tier) next[family] = tier;
		else delete next[family];
		this.#applyServiceTierByFamily(next);
	}

	/** Replace the whole per-family tier map; persists + re-arms Anthropic fast mode. */
	#applyServiceTierByFamily(next: ServiceTierByFamily): void {
		// Re-arming Anthropic priority clears the per-session fast-mode auto-disable
		// so the next request actually carries `speed: "fast"` again.
		if (next.anthropic === "priority" && this.#serviceTierByFamily.anthropic !== "priority") {
			clearAnthropicFastModeFallback(this.#host.providerSessionState);
		}
		this.#serviceTierByFamily = next;
		this.#host.sessionManager.appendServiceTierChange(this.serviceTierEntry());
	}

	/**
	 * `/fast on|off` targets the family of the currently selected model: it sets
	 * (or clears) that family's `priority` tier. Returns `false` when the model
	 * has no service-tier family, so callers can report that fast mode is
	 * unavailable instead of claiming success.
	 */
	setFastMode(enabled: boolean): boolean {
		const family = this.#model ? serviceTierFamily(this.#model) : undefined;
		if (!family) {
			this.#host.emitNotice(
				"info",
				"The current model has no service-tier control for /fast to toggle.",
				"priority",
			);
			return false;
		}
		if (!enabled) {
			if (this.#serviceTierByFamily[family] === "priority") this.setServiceTierFamily(family, undefined);
			return true;
		}
		if (family === "anthropic" && this.#serviceTierByFamily.anthropic === "priority") {
			clearAnthropicFastModeFallback(this.#host.providerSessionState);
		}
		this.setServiceTierFamily(family, "priority");
		return true;
	}

	toggleFastMode(): boolean {
		if (!this.setFastMode(!this.isFastModeEnabled())) return false;
		return this.isFastModeEnabled();
	}

	/**
	 * Get available thinking levels for current model.
	 */
	getAvailableThinkingLevels(): ReadonlyArray<Effort> {
		if (!this.#model) return [];
		return getSupportedEfforts(this.#model);
	}
}
