// Traversal state lives in weak side tables, never on the schema: caller-owned schemas may be
// sealed, frozen, or deep-frozen (via Reflect.ownKeys, which reaches symbol slots) after a first visit.
const memos = new WeakMap<object, Map<symbol, unknown>>();

export function stamp<T extends object, V>(target: T, key: symbol, compute: (target: T) => V): V {
	let slots = memos.get(target);
	if (!slots) {
		slots = new Map();
		memos.set(target, slots);
	}
	const existing = slots.get(key) as V | undefined;
	if (existing !== undefined) return existing;
	const value = compute(target);
	slots.set(key, value);
	return value;
}

const epochs = new WeakMap<object, number>();
let __epoch = 0;

export function epochNext(): number {
	return ++__epoch;
}

export function once<T extends object>(target: T, epoch: number): boolean {
	const cur = epochs.get(target);
	if (cur !== undefined && cur >= epoch) return false;
	epochs.set(target, epoch);
	return true;
}

const depths = new WeakMap<object, number>();

export function enter<T extends object>(target: T): boolean {
	const cur = depths.get(target);
	if (cur !== undefined && cur !== 0) return false;
	depths.set(target, 1);
	return true;
}

export function exit<T extends object>(target: T): void {
	const cur = depths.get(target);
	if (cur === undefined) return;
	depths.set(target, cur - 1);
}
