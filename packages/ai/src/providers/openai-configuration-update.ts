// Mid-conversation reasoning effort for models with `compat.supportsConfigurationUpdate` (GPT-6 Astra).
//
// The request-level `reasoning.effort` stays pinned to the session's first request so the cached prompt prefix
// survives an effort change. Each later change rides a `configuration_update` input item spliced at the tail of the
// transcript (before the user message it takes effect on, or after the latest tool result inside a tool loop) and is
// replayed at that position on every later request until another update overrides it.
//
// Wire constraints: only `gpt-6-astra` accepts the item type, consecutive updates are rejected, and
// `/responses/compact` rejects histories containing them — compaction requests never carry the items.

export interface ConfigurationUpdateItem {
	type: "configuration_update";
	reasoning: { effort: string };
}

interface EffortTransition<TEffort extends string> {
	// Input-array position the item is spliced into (before `input[index]`).
	index: number;
	// Fingerprint of `input[index - 1]` at record time; a mismatch means the history was rewritten.
	anchor: string;
	effort: TEffort;
}

export interface OpenAIEffortControlState<TEffort extends string = string> {
	baseEffort?: TEffort;
	currentEffort?: TEffort;
	transitions: EffortTransition<TEffort>[];
}

const MAX_EFFORT_CONTROL_STATES = 16;

// LRU lookup in a provider's bounded per-session map.
export function getOpenAIEffortControlState<TEffort extends string>(
	states: Map<string, OpenAIEffortControlState<TEffort>>,
	key: string,
): OpenAIEffortControlState<TEffort> {
	const existing = states.get(key);
	if (existing) {
		states.delete(key);
		states.set(key, existing);
		return existing;
	}
	const created: OpenAIEffortControlState<TEffort> = { transitions: [] };
	states.set(key, created);
	if (states.size > MAX_EFFORT_CONTROL_STATES) {
		const oldest = states.keys().next().value;
		if (oldest !== undefined) states.delete(oldest);
	}
	return created;
}

interface AnchorableItem {
	type?: string | null;
	role?: string;
	id?: string | null;
	status?: string | null;
}

// Output-only lifecycle fields are excluded: a live response item carries `id`/`status` that the sanitized replay
// of the same item drops.
function effortControlAnchor(input: readonly AnchorableItem[], index: number): string {
	if (index === 0) return "";
	const item = input[index - 1];
	if (!item) return "";
	const { id: _id, status: _status, ...stable } = item;
	return String(Bun.hash(JSON.stringify(stable)));
}

function resetOpenAIEffortControlState(state: OpenAIEffortControlState<string>): void {
	state.baseEffort = undefined;
	state.currentEffort = undefined;
	state.transitions = [];
}

// A history that shrank or was rewritten under a recorded transition (compaction, branch switch, `/clear`) no
// longer continues the baselined conversation; the next request re-baselines from its own effort.
function syncOpenAIEffortControlState(state: OpenAIEffortControlState<string>, input: readonly AnchorableItem[]): void {
	for (const transition of state.transitions) {
		if (transition.index > input.length || transition.anchor !== effortControlAnchor(input, transition.index)) {
			resetOpenAIEffortControlState(state);
			return;
		}
	}
}

// Pins the request-level effort to the session baseline and splices pending `configuration_update` items into
// `input` (mutated in place; it must not already contain any). Returns the effort to send at the request level.
export function planStableOpenAIEffort<TItem extends AnchorableItem, TEffort extends string>(
	state: OpenAIEffortControlState<TEffort>,
	input: Array<TItem | ConfigurationUpdateItem>,
	requested: TEffort,
): TEffort {
	syncOpenAIEffortControlState(state, input);
	if (state.baseEffort === undefined) {
		state.baseEffort = requested;
		state.currentEffort = requested;
		return requested;
	}
	if (state.currentEffort !== requested) {
		const last = input[input.length - 1];
		const index = last && "role" in last && last.role === "user" ? input.length - 1 : input.length;
		const existing = state.transitions.find(transition => transition.index === index);
		if (existing) {
			existing.effort = requested;
		} else {
			state.transitions.push({ index, anchor: effortControlAnchor(input, index), effort: requested });
		}
		// Changing back to the effort already in force at that position is a wire no-op; send no redundant item.
		let preceding = state.baseEffort;
		let precedingIndex = -1;
		for (const transition of state.transitions) {
			if (transition.index < index && transition.index > precedingIndex) {
				preceding = transition.effort;
				precedingIndex = transition.index;
			}
		}
		if (requested === preceding) {
			state.transitions = state.transitions.filter(transition => transition.index !== index);
		}
		state.currentEffort = requested;
	}
	// Ascending splice order: each insertion offsets only the ones after it.
	state.transitions.sort((a, b) => a.index - b.index);
	let offset = 0;
	for (const transition of state.transitions) {
		input.splice(transition.index + offset, 0, {
			type: "configuration_update",
			reasoning: { effort: transition.effort },
		});
		offset++;
	}
	return state.baseEffort;
}
