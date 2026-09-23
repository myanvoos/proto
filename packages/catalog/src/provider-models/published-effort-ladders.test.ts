/**
 * Contract: a discovered reasoning model without a model-scoped effort ladder adopts the ladder
 * the shared catalog publishes for its id, while known ladders and non-reasoning rows stay as
 * they are. The shared catalog is the only extra source; nothing else is fetched.
 */
import { expect, test } from "bun:test";
import { buildModel } from "../build";
import { Effort } from "../effort";
import type { FetchImpl } from "../types";
import { novitaModelManagerOptions } from "./openai-compat";

const SHARED_CATALOG_URL = "https://catalog.stencil.so/models.json.zstd";
const NOVITA_BASE_URL = "https://api.novita.ai/openai/v1";
const NOVITA_MODELS_URL = `${NOVITA_BASE_URL}/models`;
const UNKNOWN_ID = "nebula-9b";

function catalogRow(ladder?: string[]): Record<string, unknown> {
	return {
		tool_call: true,
		reasoning: true,
		modalities: { input: ["text"] },
		limit: { context: 131_072, output: 32_768 },
		cost: { input: 1, output: 2 },
		...(ladder && { reasoning_options: [{ type: "effort", values: ladder }] }),
	};
}

interface NovitaEntry {
	id: string;
	features: string[];
	endpoints: string[];
	max_output_tokens: number;
}

function novitaEntry(id: string, reasoning = true): NovitaEntry {
	return {
		id,
		features: reasoning ? ["reasoning", "function-calling"] : ["function-calling"],
		endpoints: ["chat/completions"],
		max_output_tokens: 32_768,
	};
}

async function discover(catalog: unknown, ids: Array<string | NovitaEntry>, calls: string[] = []) {
	const fetchImpl = (async (input: string | URL | Request) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		calls.push(url);
		if (url === NOVITA_MODELS_URL) {
			return Response.json({ data: ids.map(id => (typeof id === "string" ? novitaEntry(id) : id)) });
		}
		if (url === SHARED_CATALOG_URL && catalog !== undefined) return Response.json(catalog);
		return new Response("not found", { status: 404 });
	}) as FetchImpl;
	const models = await novitaModelManagerOptions({
		apiKey: "novita-test-key",
		baseUrl: NOVITA_BASE_URL,
		fetch: fetchImpl,
	}).fetchDynamicModels?.();
	return models ?? [];
}

test("published tiers replace the guessed ladder of an unknown reasoning model", async () => {
	const calls: string[] = [];
	const models = await discover(
		{ novita: { models: { [UNKNOWN_ID]: catalogRow(["low", "high"]) } } },
		[UNKNOWN_ID],
		calls,
	);
	const model = models.find(candidate => candidate.id === UNKNOWN_ID)!;

	// The guess it replaced differs, so the adopted ladder cannot pass by accident.
	expect(buildModel({ ...model, thinking: undefined }).thinking?.efforts).not.toEqual([Effort.Low, Effort.High]);
	expect(buildModel(model).thinking?.efforts).toEqual([Effort.Low, Effort.High]);
	expect(calls.filter(url => url !== NOVITA_MODELS_URL)).toEqual([SHARED_CATALOG_URL]);
});

test("gateway prefixes are peeled to find the upstream host's ladder", async () => {
	const id = `acme/${UNKNOWN_ID}`;
	const models = await discover({ acme: { models: { [UNKNOWN_ID]: catalogRow(["low", "high"]) } } }, [id]);
	expect(models.find(candidate => candidate.id === id)?.thinking?.efforts).toEqual([Effort.Low, Effort.High]);
});

test("known ladders and non-reasoning rows are left alone, without a catalog request", async () => {
	const calls: string[] = [];
	const models = await discover(
		{ novita: { models: { "gpt-5.5": catalogRow(["minimal"]), "plain-chat-9b": catalogRow(["low", "high"]) } } },
		["gpt-5.5", novitaEntry("plain-chat-9b", false)],
		calls,
	);
	expect(models.find(candidate => candidate.id === "gpt-5.5")?.thinking).toBeUndefined();
	expect(models.find(candidate => candidate.id === "plain-chat-9b")?.thinking).toBeUndefined();
	expect(calls).toEqual([NOVITA_MODELS_URL]);
});

test("an unreachable catalog, or one that knows nothing about the id, leaves the guess in place", async () => {
	const unreachable = await discover(undefined, [UNKNOWN_ID]);
	expect(unreachable.find(candidate => candidate.id === UNKNOWN_ID)?.thinking).toBeUndefined();
	const unknown = await discover({ novita: { models: { "other-model": catalogRow(["low"]) } } }, [UNKNOWN_ID]);
	expect(unknown.find(candidate => candidate.id === UNKNOWN_ID)?.thinking).toBeUndefined();
});

test("the serving host's ladder wins over a bare id another host publishes differently", async () => {
	const models = await discover(
		{
			// Listed first, so a bare-id index would hand this ladder to Novita.
			acme: { models: { [UNKNOWN_ID]: catalogRow(["minimal", "low"]) } },
			novita: { models: { [UNKNOWN_ID]: catalogRow(["low", "high", "max"]) } },
		},
		[UNKNOWN_ID],
	);
	expect(models.find(candidate => candidate.id === UNKNOWN_ID)?.thinking?.efforts).toEqual([
		Effort.Low,
		Effort.High,
		Effort.Max,
	]);
});

test("a bare id stays unknown when its publishing hosts disagree or one publishes no dial", async () => {
	const id = `zeta/${UNKNOWN_ID}`;
	for (const catalog of [
		{ a: { models: { [UNKNOWN_ID]: catalogRow(["low"]) } }, b: { models: { [UNKNOWN_ID]: catalogRow(["high"]) } } },
		{ a: { models: { [UNKNOWN_ID]: catalogRow(["low"]) } }, b: { models: { [UNKNOWN_ID]: catalogRow() } } },
	]) {
		const models = await discover(catalog, [id]);
		expect(models.find(candidate => candidate.id === id)?.thinking).toBeUndefined();
	}
});
