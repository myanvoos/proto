import type { Context, Message, Tool } from "@oh-my-pi/pi-ai";
import { normalizeTools } from "./agent-loop";
import type { AgentContext } from "./types";

export interface StablePrefixSnapshot {
	systemPrompt: string[];
	tools: Tool[];
	fingerprint: string;
}

export interface BuildOptions {
	intentTracing: boolean;

	pruneToolDescriptions?: boolean;
}

export class StablePrefix {
	#snapshot: StablePrefixSnapshot | null = null;
	#version = 0;

	get fingerprint(): string {
		return this.#snapshot?.fingerprint ?? "<unbuilt>";
	}
	get version(): number {
		return this.#version;
	}
	get built(): boolean {
		return this.#snapshot !== null;
	}

	build(context: AgentContext, options: BuildOptions): boolean {
		const snapshot = takeSnapshot(context, options);
		if (this.#snapshot && this.#snapshot.fingerprint === snapshot.fingerprint) {
			return false;
		}
		this.#snapshot = snapshot;
		this.#version++;
		return true;
	}

	invalidate(): void {
		this.#snapshot = null;
	}

	toContext(): { systemPrompt: string[]; tools: Tool[] } {
		const s = this.#snapshot;
		if (!s) throw new Error("StablePrefix.toContext() called before build()");
		return { systemPrompt: s.systemPrompt, tools: s.tools };
	}
}

export class AppendOnlyLog {
	#entries: Message[] = [];

	get length(): number {
		return this.#entries.length;
	}

	append(message: Message): void {
		this.#entries.push(message);
	}

	extend(messages: readonly Message[]): void {
		for (const m of messages) this.#entries.push(m);
	}

	replaceTail(replacement: Message): void {
		const idx = this.#entries.length - 1;
		if (idx >= 0) this.#entries[idx] = replacement;
	}

	toMessages(): Message[] {
		return this.#entries.slice();
	}

	entries(): readonly Message[] {
		return this.#entries;
	}

	truncate(count: number): void {
		if (count < 0) count = 0;
		if (count >= this.#entries.length) return;
		this.#entries.length = count;
	}

	clear(): void {
		this.#entries = [];
	}
}

interface MessageDigestMemo {
	digest: number;
	payload: DigestPayload;
}

interface DigestArrayEntry {
	message: unknown;
	digest: number;
}

interface DigestArrayMemo {
	epoch: number;
	length: number;
	entries: Array<DigestArrayEntry | undefined>;
}

interface DigestPayload {
	r: unknown;
	c: unknown;
	pp: unknown;
	tc: unknown;
	tcid: unknown;
	tn: unknown;
	err: unknown;
	id: unknown;
}

export class AppendOnlyContextManager {
	readonly prefix = new StablePrefix();
	readonly log = new AppendOnlyLog();

	#lastSyncCount = 0;

	#messageDigests: number[] = [];
	// Nested message fields can be edited in place, so only primitive projections are memoized.
	#messageDigestMemo = new WeakMap<object, MessageDigestMemo>();
	#digestArrayMemo = new WeakMap<object, DigestArrayMemo>();

	build(context: AgentContext, options: BuildOptions): Context {
		this.prefix.build(context, options);
		const { systemPrompt, tools } = this.prefix.toContext();
		return { systemPrompt, messages: this.log.toMessages(), tools };
	}

	syncMessages(normalizedMessages: readonly Message[]): void {
		const digestMemo = this.#digestMemoFor(normalizedMessages);
		if (normalizedMessages.length < this.#lastSyncCount) {
			this.log.clear();
			this.#lastSyncCount = 0;
			this.#messageDigests = [];
		}

		if (this.#lastSyncCount > 0) {
			const stableCount = Math.min(this.#longestStablePrefix(normalizedMessages), this.log.length);
			if (stableCount < this.#lastSyncCount) {
				this.log.truncate(stableCount);
				this.#lastSyncCount = stableCount;
				this.#messageDigests.length = stableCount;
			}
		}

		for (let i = this.#lastSyncCount; i < normalizedMessages.length; i++) {
			const msg = normalizedMessages[i];
			const digest = this.#messageDigest(msg);
			this.log.append(msg);
			this.#messageDigests.push(digest);
			digestMemo.entries[i] = { message: msg, digest };
		}
		this.#lastSyncCount = normalizedMessages.length;
	}

	invalidateForModelChange(): void {
		this.prefix.invalidate();
		this.log.clear();
		this.#lastSyncCount = 0;
		this.#messageDigests = [];
	}

	resetSyncCursor(): void {
		this.log.clear();
		this.#lastSyncCount = 0;
		this.#messageDigests = [];
	}

	appendMessage(message: Message): void {
		this.log.append(message);
	}

	replaceTailMessage(message: Message): void {
		this.log.replaceTail(message);
	}

	invalidate(): void {
		this.prefix.invalidate();
	}

	reset(context: AgentContext, options: BuildOptions): void {
		this.prefix.invalidate();
		this.log.clear();
		this.#lastSyncCount = 0;
		this.#messageDigests = [];
		this.prefix.build(context, options);
	}

	#digestMemoFor(normalizedMessages: readonly unknown[]): DigestArrayMemo {
		const key = normalizedMessages as object;
		let memo = this.#digestArrayMemo.get(key);
		if (memo === undefined) {
			memo = { epoch: 0, length: normalizedMessages.length, entries: [] };
			this.#digestArrayMemo.set(key, memo);
			return memo;
		}
		if (normalizedMessages.length < memo.length) {
			memo.epoch++;
			memo.entries.length = normalizedMessages.length;
		}
		memo.length = normalizedMessages.length;
		return memo;
	}

	#longestStablePrefix(normalizedMessages: readonly unknown[]): number {
		const memo = this.#digestMemoFor(normalizedMessages);
		const bound = Math.min(this.#lastSyncCount, normalizedMessages.length);
		for (let i = 0; i < bound; i++) {
			const message = normalizedMessages[i];
			const digest = this.#messageDigest(message);
			const previous = memo.entries[i];
			if (previous !== undefined && (previous.message !== message || previous.digest !== digest)) {
				memo.epoch++;
				memo.entries.length = i;
			}
			memo.entries[i] = { message, digest };
			if (digest !== this.#messageDigests[i]) return i;
		}
		return bound;
	}

	#messageDigest(msg: unknown): number {
		if (!msg || typeof msg !== "object") return 0;
		const m = msg as Record<string, unknown>;
		const payload: DigestPayload = {
			r: m.role ?? null,
			c: m.content ?? null,
			pp: m.providerPayload ?? null,
			tc: m.toolCalls ?? m.tool_calls ?? null,
			tcid: m.toolCallId ?? m.tool_call_id ?? null,
			tn: m.toolName ?? m.name ?? null,
			err: m.isError ?? null,
			id: m.id ?? null,
		};
		const cacheable = hasOnlyPrimitiveDigestFields(payload);
		if (cacheable) {
			const cached = this.#messageDigestMemo.get(m);
			if (cached !== undefined && sameDigestPayload(payload, cached.payload)) return cached.digest;
		}
		const serialized = JSON.stringify(payload);
		let hash = 0;
		for (let j = 0; j < serialized.length; j++) {
			hash = ((hash << 5) - hash + serialized.charCodeAt(j)) | 0;
		}
		const digest = hash >>> 0;
		if (cacheable) this.#messageDigestMemo.set(m, { digest, payload });
		return digest;
	}
}

function hasOnlyPrimitiveDigestFields(payload: DigestPayload): boolean {
	return (
		(isPrimitiveDigestValue(payload.r) || payload.r === null) &&
		(isPrimitiveDigestValue(payload.c) || payload.c === null) &&
		(isPrimitiveDigestValue(payload.pp) || payload.pp === null) &&
		(isPrimitiveDigestValue(payload.tc) || payload.tc === null) &&
		(isPrimitiveDigestValue(payload.tcid) || payload.tcid === null) &&
		(isPrimitiveDigestValue(payload.tn) || payload.tn === null) &&
		(isPrimitiveDigestValue(payload.err) || payload.err === null) &&
		(isPrimitiveDigestValue(payload.id) || payload.id === null)
	);
}

function isPrimitiveDigestValue(value: unknown): value is string | number | boolean | undefined {
	return value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function sameDigestPayload(left: DigestPayload, right: DigestPayload): boolean {
	return (
		Object.is(left.r, right.r) &&
		Object.is(left.c, right.c) &&
		Object.is(left.pp, right.pp) &&
		Object.is(left.tc, right.tc) &&
		Object.is(left.tcid, right.tcid) &&
		Object.is(left.tn, right.tn) &&
		Object.is(left.err, right.err) &&
		Object.is(left.id, right.id)
	);
}

function takeSnapshot(context: AgentContext, options: BuildOptions): StablePrefixSnapshot {
	const systemPrompt = [...context.systemPrompt];
	const tools =
		normalizeTools(context.tools, {
			injectIntent: options.intentTracing,
			pruneDescriptions: options.pruneToolDescriptions,
		}) ?? [];
	return {
		systemPrompt,
		tools,
		fingerprint: computeFingerprint(systemPrompt, tools, options),
	};
}

function computeFingerprint(systemPrompt: string[], tools: Tool[], options: BuildOptions): string {
	const payload = JSON.stringify({
		s: systemPrompt,
		t: tools.map(t => ({
			n: t.name,
			d: t.description,
			p: t.parameters,
			s: t.strict,
			cf: t.customFormat,
			cw: t.customWireName,
		})),
		i: options.intentTracing,
		pd: options.pruneToolDescriptions,
	});
	let hash = 0;
	for (let i = 0; i < payload.length; i++) {
		hash = ((hash << 5) - hash + payload.charCodeAt(i)) | 0;
	}
	return (hash >>> 0).toString(36);
}
