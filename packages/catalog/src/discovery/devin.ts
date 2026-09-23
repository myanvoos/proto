import { logger } from "@oh-my-pi/pi-utils";
import { Effort, THINKING_EFFORTS } from "../effort";
import type { DevinCompat, FetchImpl, ModelCost, ModelSpec } from "../types";
import { discoveryFetch } from "../utils";
import { collapseEffortVariants, DEVIN_VARIANT_COLLAPSE_TABLE, type EffortVariantFamily } from "../variant-collapse";
import { DEVIN_DEFAULT_BASE_URL, devinDiscoveryMetadata } from "../wire/devin";
import { decodeDevinUnaryMessage } from "../wire/devin-proto";
import {
	type ClientModelConfig,
	DisplayOption,
	GetCliModelConfigsRequestSchema,
	GetCliModelConfigsResponseSchema,
	type Metadata,
	MetadataSchema,
	ModelDimensionKind,
} from "./devin-proto";
import { create, toBinary } from "./protobuf";

const DEVIN_GET_CLI_MODEL_CONFIGS_PATH = "/exa.api_server_pb.ApiServerService/GetCliModelConfigs";

const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_TOKENS = 64_000;

// The vendored descriptor stops at QUICK_REVIEW (4); display options are plain int32 on the
// wire, so the newer slots round-trip faithfully through a cast.
const DEVIN_DISPLAY_OPTION_INTERNAL_DEFAULT = 6 as DisplayOption;
const DEVIN_DISPLAY_OPTION_UNCLASSIFIED = 7 as DisplayOption;
const DEVIN_DISPLAY_OPTION_NORMAL = 8 as DisplayOption;

// Advertising the internal slots is what makes the server return its full catalog; the
// internal ones are then filtered client-side, exactly as the native CLI does.
const DEVIN_SUPPORTED_MODEL_DISPLAYS: readonly DisplayOption[] = [
	DisplayOption.MODEL_ROUTER,
	DisplayOption.QUICK_REVIEW,
	DEVIN_DISPLAY_OPTION_INTERNAL_DEFAULT,
	DEVIN_DISPLAY_OPTION_UNCLASSIFIED,
	DEVIN_DISPLAY_OPTION_NORMAL,
];

const DEVIN_INTERNAL_MODEL_DISPLAYS: ReadonlySet<DisplayOption> = new Set([
	DisplayOption.QUICK_REVIEW,
	DEVIN_DISPLAY_OPTION_INTERNAL_DEFAULT,
]);

const REASONING_LABEL_PATTERN = /think|thinking|minimal|high|medium|low|xhigh|max|reasoning/i;
const NO_REASONING_LABEL_PATTERN = /\bno thinking\b/i;

function supportsDevinThinking(config: ClientModelConfig): boolean {
	const features = config.modelInfo?.modelFeatures;
	if (features !== undefined) {
		return features.supportsThinking;
	}
	if (NO_REASONING_LABEL_PATTERN.test(config.label)) return false;
	return REASONING_LABEL_PATTERN.test(config.label);
}

const DEVIN_COST_LABEL_INPUT = "input";
const DEVIN_COST_LABEL_CACHE_READ = "cached input";
const DEVIN_COST_LABEL_OUTPUT = "output";
const DEVIN_SIDEKICK_LABEL = "sidekick";

const DEVIN_COST_DENOMINATOR_PATTERN = /(\d+(?:\.\d+)?)\s*([kmb])?/i;
const DEVIN_COST_DENOMINATOR_SCALE: Readonly<Partial<Record<string, number>>> = {
	k: 1_000,
	m: 1_000_000,
	b: 1_000_000_000,
};

function devinCostDenominatorTokens(denominator: string): number {
	const match = DEVIN_COST_DENOMINATOR_PATTERN.exec(denominator);
	if (match === null) return 1_000_000;
	const suffix = match[2];
	const scale = suffix === undefined ? 1 : (DEVIN_COST_DENOMINATOR_SCALE[suffix.toLowerCase()] ?? 1);
	const tokens = Number(match[1]) * scale;
	return tokens > 0 ? tokens : 1_000_000;
}

// `COST_FUZZY` is an estimated rate, not a different unit. Cascade has no cache-write
// dimension (writes bill at the input rate), so `cacheWrite` stays 0. Composite configs
// (`fusion`) flatten every dispatched component's rate card after a `Sidekick` marker
// dimension; reading stops there so the composite keeps its own headline card.
function devinModelCost(config: ClientModelConfig): ModelCost {
	const cost: ModelCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	for (const dimension of config.modelDimensions) {
		const label = dimension.label.trim().toLowerCase();
		if (label === DEVIN_SIDEKICK_LABEL) {
			break;
		}
		if (dimension.kind !== ModelDimensionKind.COST && dimension.kind !== ModelDimensionKind.COST_FUZZY) {
			continue;
		}
		// Float32 dimension values decode with noise (0.1 -> 0.10000000149011612).
		const perMillion =
			Math.round(((dimension.value * 1_000_000) / devinCostDenominatorTokens(dimension.denominator)) * 1e6) / 1e6;
		switch (label) {
			case DEVIN_COST_LABEL_INPUT:
				cost.input = perMillion;
				break;
			case DEVIN_COST_LABEL_CACHE_READ:
				cost.cacheRead = perMillion;
				break;
			case DEVIN_COST_LABEL_OUTPUT:
				cost.output = perMillion;
				break;
		}
	}
	return cost;
}

const SWE_2_PROMO_COST: ModelCost = { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0.75 };
const SWE_2_LIST_COST: ModelCost = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3 };
const SWE_2_LIST_PRICE_FROM = Date.parse("2027-01-01T00:00:00Z");
const SWE_1_7_LIST_COST: ModelCost = { input: 0.5, output: 2.5, cacheRead: 0.2, cacheWrite: 0.5 };
const GLM_5_2_LIST_COST: ModelCost = { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 1.4 };

// Plan-included models on lower tiers report no cost dimensions (PRO shows $0 for SWE-2,
// SWE-1.7 and GLM-5.2 High). Seed the enterprise list price only when upstream reported no
// token price at all, so accounts whose discovery carries real rates keep them. SWE-2's 75%-off
// promo ends 2026-12-31; list pricing applies from 2027-01-01.
function devinFallbackCost(id: string, now: number): ModelCost | undefined {
	if (id.startsWith("swe-2")) return now >= SWE_2_LIST_PRICE_FROM ? SWE_2_LIST_COST : SWE_2_PROMO_COST;
	if (id === "swe-1-7" || id === "swe-1-7-medium") return SWE_1_7_LIST_COST;
	if (id === "glm-5-2") return GLM_5_2_LIST_COST;
	return undefined;
}

function applyDevinCostFallback(spec: ModelSpec<"devin-agent">, now: number): ModelSpec<"devin-agent"> {
	const cost = spec.cost;
	if (cost.input !== 0 || cost.output !== 0 || cost.cacheRead !== 0 || cost.cacheWrite !== 0) return spec;
	const fallback = devinFallbackCost(spec.id, now);
	return fallback === undefined ? spec : { ...spec, cost: { ...fallback } };
}

const DEVIN_FAMILY_EFFORT_KEYS: Readonly<Partial<Record<string, true>>> = { effort: true, "reasoning effort": true };
const DEVIN_FAMILY_FAST_KEY = "fast mode";
const DEVIN_FAMILY_FAST_ORDER = 1;
const DEVIN_FAMILY_THINKING_KEY = "thinking";
const DEVIN_FAMILY_THINKING_ORDER = 1;
const DEVIN_FAMILY_CONTEXT_1M_KEY = "1m context";
const DEVIN_FAMILY_CONTEXT_1M_ORDER = 1;

const DEVIN_FAMILY_EFFORT_BY_NAME: Readonly<Partial<Record<string, Effort | "off">>> = {
	none: "off",
	nothinking: "off",
	minimal: Effort.Minimal,
	low: Effort.Low,
	medium: Effort.Medium,
	high: Effort.High,
	xhigh: Effort.XHigh,
	max: Effort.Max,
};

// Fast service and 1M context are separate logical models; reasoning effort stays the lane's
// only selectable axis.
interface DevinFamilyLane {
	id: string;
	name: string;
	members: string[];
	defaultMember?: string;
	routing: Partial<Record<Effort | "off", string>>;
}

function collectDevinFamilyLane(lanes: Map<string, DevinFamilyLane>, config: ClientModelConfig, uid: string): void {
	const metadata = config.modelFamilyMetadata;
	if (metadata === undefined) return;
	const label = metadata.modelFamilyLabel.trim();
	if (!label) return;

	let effort: Effort | "off" | undefined;
	let thinking: boolean | undefined;
	let fast = false;
	let oneMillionContext = false;
	for (const entry of metadata.entries) {
		const value = entry.value;
		if (value === undefined) continue;
		// Keys collapse punctuation to spaces ("Reasoning Effort" -> "reasoning effort"); effort
		// names drop it entirely ("X High" and "XHigh" -> "xhigh").
		const key = entry.key
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, " ")
			.trim();
		if (key === DEVIN_FAMILY_FAST_KEY) {
			fast = value.order === DEVIN_FAMILY_FAST_ORDER;
			continue;
		}
		if (key === DEVIN_FAMILY_THINKING_KEY) {
			thinking = value.order === DEVIN_FAMILY_THINKING_ORDER;
			continue;
		}
		if (key === DEVIN_FAMILY_CONTEXT_1M_KEY) {
			oneMillionContext = value.order === DEVIN_FAMILY_CONTEXT_1M_ORDER;
			continue;
		}
		if (DEVIN_FAMILY_EFFORT_KEYS[key]) {
			effort = DEVIN_FAMILY_EFFORT_BY_NAME[value.name.toLowerCase().replace(/[^a-z0-9]+/g, "")];
		}
	}
	// Claude's paired non-thinking and thinking configs share one "High" effort label; the
	// explicit Thinking axis decides whether the route is off.
	if (thinking === false) effort = "off";

	const baseId = label
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	if (!baseId) return;
	const laneId = `${baseId}${oneMillionContext ? "-1m" : ""}${fast ? "-fast" : ""}`;
	let lane = lanes.get(laneId);
	if (lane === undefined) {
		const name = `${label}${oneMillionContext ? " 1M" : ""}${fast ? " Fast" : ""}`;
		lane = { id: laneId, name, members: [], routing: {} };
		lanes.set(laneId, lane);
	}
	lane.members.push(uid);
	if (lane.defaultMember === undefined && (config.isDefaultModelInFamily || metadata.isDefaultModelInFamily)) {
		lane.defaultMember = uid;
	}
	if (effort !== undefined && lane.routing[effort] === undefined) {
		lane.routing[effort] = uid;
	}
}

function devinDynamicFamilies(lanes: Iterable<DevinFamilyLane>): EffortVariantFamily[] {
	const families: EffortVariantFamily[] = [];
	for (const lane of lanes) {
		const efforts = THINKING_EFFORTS.filter(effort => lane.routing[effort] !== undefined);
		// A lane with no effort route has nothing to route; its members stay standalone.
		if (efforts.length === 0) continue;
		const defaultMember = lane.defaultMember;
		const members =
			defaultMember === undefined
				? lane.members
				: [defaultMember, ...lane.members.filter(uid => uid !== defaultMember)];
		const defaultLevel =
			defaultMember === undefined ? undefined : efforts.find(effort => lane.routing[effort] === defaultMember);
		families.push({
			id: lane.id,
			name: lane.name,
			members,
			routing: lane.routing,
			...(defaultMember !== undefined ? { defaultMember } : {}),
			thinking: {
				mode: "effort",
				efforts,
				...(defaultLevel !== undefined ? { defaultLevel } : {}),
				// No wire id serves the family with thinking disabled, so effort is mandatory.
				...(lane.routing.off === undefined ? { requiresEffort: true } : {}),
			},
		});
	}
	return families;
}

export interface DevinModelDiscoveryOptions {
	apiKey?: string;

	baseUrl?: string;

	timeoutMs?: number;

	signal?: AbortSignal;

	fetch?: FetchImpl;
}

export async function fetchDevinModels(
	options: DevinModelDiscoveryOptions,
): Promise<ModelSpec<"devin-agent">[] | null> {
	const timeoutMs = options.timeoutMs ?? 5_000;
	const resolvedBaseUrl = options.baseUrl ?? DEVIN_DEFAULT_BASE_URL;
	const requestUrl = `${resolvedBaseUrl.replace(/\/+$/, "")}${DEVIN_GET_CLI_MODEL_CONFIGS_PATH}`;

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
	const fetchImpl = discoveryFetch(options.fetch);

	const fetchCatalog = async (metadata: Metadata): Promise<ModelSpec<"devin-agent">[] | null> => {
		try {
			const request = create(GetCliModelConfigsRequestSchema, { metadata });
			const response = await fetchImpl(requestUrl, {
				method: "POST",
				headers: {
					"content-type": "application/proto",
					"connect-protocol-version": "1",
					accept: "*/*",
				},
				body: toBinary(GetCliModelConfigsRequestSchema, request),
				signal,
			});
			if (!response.ok) return null;

			const decoded = decodeDevinUnaryMessage(
				GetCliModelConfigsResponseSchema,
				new Uint8Array(await response.arrayBuffer()),
			);
			return decoded ? normalizeDevinModels(decoded.clientModelConfigs, options.baseUrl) : null;
		} catch {
			return null;
		}
	};

	try {
		const nativeModels = await fetchCatalog(
			create(MetadataSchema, {
				...devinDiscoveryMetadata(options.apiKey),
				supportedModelDisplays: [...DEVIN_SUPPORTED_MODEL_DISPLAYS],
			}),
		);
		const nativeIsSeedOnly =
			nativeModels !== null &&
			nativeModels.length > 0 &&
			nativeModels.every(model => model.id === "swe-1-6" || model.id === "swe-1-6-fast");
		if (nativeModels !== null && nativeModels.length > 0 && !nativeIsSeedOnly) {
			return nativeModels;
		}

		// Legacy Windsurf Enterprise seats expose their full credential-scoped roster only to the
		// editor identity with the raw key; native chisel discovery returns just the SWE-1.6 seed.
		const legacyModels = await fetchCatalog(
			create(MetadataSchema, {
				apiKey: options.apiKey ?? "",
				ideName: "windsurf",
				ideVersion: "3.2.23",
				extensionName: "windsurf",
				extensionVersion: "1.48.2",
				locale: "en",
			}),
		);
		const models =
			legacyModels !== null && (nativeModels === null || legacyModels.length > nativeModels.length)
				? legacyModels
				: nativeModels;
		if (models === null || models.length === 0) {
			// An empty-but-200 catalog is the failure signature of a stale pinned client identity;
			// failing discovery keeps the static seed instead of pruning the provider.
			logger.warn("Devin returned an empty model catalog; the pinned client identities may be stale", {
				metadata: devinDiscoveryMetadata(undefined),
			});
			return null;
		}
		return models;
	} finally {
		clearTimeout(timer);
	}
}

// SWE-1.6 configs advertise `supports_images`, but the backend silently drops
// `ChatMessagePrompt.images` for them (verified live; every other Cascade model reads it).
const DEVIN_IMAGE_BLIND_UIDS = new Set(["swe-1-6", "swe-1-6-fast"]);

function devinModelSpec(
	config: ClientModelConfig,
	uid: string,
	baseUrl: string,
	isAssignModelRouter: boolean,
): ModelSpec<"devin-agent"> {
	const features = config.modelInfo?.modelFeatures;
	const supportsImages =
		(features !== undefined ? features.supportsImages : config.supportsImages) && !DEVIN_IMAGE_BLIND_UIDS.has(uid);
	const compat: DevinCompat = {};
	if (isAssignModelRouter) compat.modelRouter = true;
	if (features?.supportsParallelToolCalls === true) compat.supportsParallelToolCalls = true;
	const maxOutputTokens = config.modelInfo?.maxOutputTokens ?? 0;
	const spec: ModelSpec<"devin-agent"> = {
		id: uid,
		name: config.label.trim() || uid,
		api: "devin-agent",
		provider: "devin",
		baseUrl,
		reasoning: supportsDevinThinking(config),
		input: supportsImages ? ["text", "image"] : ["text"],
		// Router configs ship no features; Cascade only serves tool-calling models.
		supportsTools: features !== undefined ? features.supportsToolCalls : true,
		cost: devinModelCost(config),
		contextWindow: config.maxTokens > 0 ? config.maxTokens : DEFAULT_CONTEXT_WINDOW,
		maxTokens: maxOutputTokens > 0 ? maxOutputTokens : DEFAULT_MAX_TOKENS,
		...(Object.keys(compat).length > 0 ? { compat } : {}),
	};
	const description = config.description?.trim();
	if (description) spec.description = description;
	if (config.isNew) spec.isNew = true;
	if (config.isBeta) spec.isBeta = true;
	if (config.isRecommended) spec.isRecommended = true;
	return spec;
}

function normalizeDevinModels(
	configs: readonly ClientModelConfig[],
	baseUrlOverride: string | undefined,
): ModelSpec<"devin-agent">[] {
	const baseUrl = baseUrlOverride ?? DEVIN_DEFAULT_BASE_URL;
	const specs: ModelSpec<"devin-agent">[] = [];
	const seen = new Set<string>();
	const lanes = new Map<string, DevinFamilyLane>();

	for (const config of configs) {
		if (config.disabled) {
			continue;
		}
		const displayOption = config.modelInfo?.displayOption ?? DisplayOption.UNSPECIFIED;
		if (DEVIN_INTERNAL_MODEL_DISPLAYS.has(displayOption)) {
			continue;
		}
		const uid = config.modelUid.trim();
		if (!uid || seen.has(uid)) {
			continue;
		}
		seen.add(uid);
		const isRouter = displayOption === DisplayOption.MODEL_ROUTER || config.modelInfo?.isModelRouter === true;
		// `isModelRouter` also marks harness-backed composites (`fusion`, `fusion-sidekick-*`)
		// that are valid chat uids themselves; only harness-less slots (`adaptive`) go through
		// `AssignModel`, which 404s for composites.
		const isAssignModelRouter = isRouter && (config.modelInfo?.harnessUids.length ?? 0) === 0;
		specs.push(devinModelSpec(config, uid, baseUrl, isAssignModelRouter));
		// A router is a dispatcher, not an effort tier: it stays standalone even when filed
		// under a family.
		if (!isRouter) {
			collectDevinFamilyLane(lanes, config, uid);
		}
	}

	// Server-declared families are live truth and collapse first; the static table then
	// handles families served without metadata and passes collapsed ones through.
	const families = devinDynamicFamilies(lanes.values());
	const dynamic = families.length > 0 ? collapseEffortVariants(specs, { families }) : specs;
	const now = Date.now();
	return collapseEffortVariants(dynamic, DEVIN_VARIANT_COLLAPSE_TABLE)
		.map(spec => applyDevinCostFallback(spec, now))
		.sort((a, b) => a.id.localeCompare(b.id));
}
