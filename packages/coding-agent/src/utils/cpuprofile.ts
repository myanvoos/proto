import { formatPct, mergeInto, type ProfileNode, type RenderTreeContext, renderProfileNode } from "./profile-tree";

export function isCpuProfilePath(filePath: string): boolean {
	return /\.cpuprofile$/i.test(filePath);
}

interface CpuProfileCallFrame {
	functionName: string;
	url?: string;
	lineNumber?: number;
}

interface CpuProfileNode {
	id: number;
	callFrame: CpuProfileCallFrame;
	hitCount?: number;
	children?: number[];
}

interface CpuProfile {
	nodes: CpuProfileNode[];
	startTime: number;
	endTime: number;
	samples?: number[];
	timeDeltas?: number[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function parseCpuProfile(text: string): CpuProfile | null {
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch {
		return null;
	}
	if (isRecord(data) && !("nodes" in data) && isRecord(data.profile)) data = data.profile;
	if (!isRecord(data)) return null;
	const { nodes, startTime, endTime, samples, timeDeltas } = data;
	if (!Array.isArray(nodes) || nodes.length === 0) return null;
	if (typeof startTime !== "number" || typeof endTime !== "number") return null;
	for (const node of nodes) {
		if (!isRecord(node) || typeof node.id !== "number") return null;
		if (!isRecord(node.callFrame) || typeof node.callFrame.functionName !== "string") return null;
	}
	return {
		nodes: nodes as unknown as CpuProfileNode[],
		startTime,
		endTime,
		samples: Array.isArray(samples) ? (samples as number[]) : undefined,
		timeDeltas: Array.isArray(timeDeltas) ? (timeDeltas as number[]) : undefined,
	};
}

const PRUNE_FRACTION = 0.02;
const TOP_FUNCTIONS = 20;

function shortUrl(url: string): string {
	let u = url.startsWith("file://") ? url.slice("file://".length) : url;
	const nm = u.lastIndexOf("node_modules/");
	if (nm > 0) return u.slice(nm);
	const parts = u.split("/");
	if (parts.length > 4) u = `…/${parts.slice(-3).join("/")}`;
	return u;
}

function frameLabel(frame: CpuProfileCallFrame): string {
	const name = frame.functionName || "(anonymous)";
	if (!frame.url) return name;
	const line = typeof frame.lineNumber === "number" && frame.lineNumber >= 0 ? `:${frame.lineNumber + 1}` : "";
	return `${name} (${shortUrl(frame.url)}${line})`;
}

function selfMicros(profile: CpuProfile): Map<number, number> {
	const self = new Map<number, number>();
	const { samples, timeDeltas } = profile;
	if (samples && timeDeltas && samples.length > 0) {
		const n = Math.min(samples.length, timeDeltas.length);
		for (let i = 0; i < n; i++) {
			const delta = timeDeltas[i];

			if (typeof delta !== "number" || delta <= 0) continue;
			const id = samples[i];
			self.set(id, (self.get(id) ?? 0) + delta);
		}
		return self;
	}
	let totalHits = 0;
	for (const node of profile.nodes) totalHits += node.hitCount ?? 0;
	if (totalHits === 0) return self;
	const interval = (profile.endTime - profile.startTime) / totalHits;
	for (const node of profile.nodes) {
		if (node.hitCount) self.set(node.id, node.hitCount * interval);
	}
	return self;
}

const IDLE_FRAME = "(idle)";
const ROOT_FRAME = "(root)";

function formatMs(micros: number): string {
	return (micros / 1000).toFixed(1);
}

export function renderCpuProfile(text: string): string | null {
	const profile = parseCpuProfile(text);
	if (!profile) return null;

	const byId = new Map<number, CpuProfileNode>();
	const referenced = new Set<number>();
	for (const node of profile.nodes) {
		byId.set(node.id, node);
		for (const child of node.children ?? []) referenced.add(child);
	}
	const self = selfMicros(profile);

	const visited = new Set<number>();
	const build = (node: CpuProfileNode): ProfileNode => {
		visited.add(node.id);
		const children: ProfileNode[] = [];
		for (const childId of node.children ?? []) {
			const rawChild = byId.get(childId);
			if (!rawChild || visited.has(childId)) continue;
			const child = build(rawChild);
			const existing = children.find(c => c.key === child.key);
			if (existing) mergeInto(existing, child);
			else children.push(child);
		}
		const isIdle = node.callFrame.functionName === IDLE_FRAME;
		let value = isIdle ? 0 : (self.get(node.id) ?? 0);
		for (const child of children) value += child.value;
		const label = frameLabel(node.callFrame);
		return { key: label, label, value, recursion: 0, children };
	};

	const roots: ProfileNode[] = [];
	for (const node of profile.nodes) {
		if (referenced.has(node.id) || visited.has(node.id)) continue;
		const built = build(node);
		if (node.callFrame.functionName === ROOT_FRAME) roots.push(...built.children);
		else roots.push(built);
	}

	const totalCpu = roots.reduce((sum, root) => sum + root.value, 0);
	if (totalCpu <= 0) return null;
	const duration = Math.max(0, profile.endTime - profile.startTime);
	const sampleCount = profile.samples?.length ?? 0;
	const avgInterval = sampleCount > 0 ? duration / sampleCount : 0;

	const out: string[] = [];
	let header = `V8 CPU profile: ${(duration / 1e6).toFixed(2)} s wall clock`;
	if (sampleCount > 0) header += `, ${sampleCount} samples (avg interval ${Math.round(avgInterval)} µs)`;
	out.push(header);
	out.push(
		`On-CPU total: ${(totalCpu / 1e6).toFixed(2)} s (${formatPct(totalCpu, duration)} of wall clock). Values below are on-CPU milliseconds (idle time excluded).`,
	);

	const ctx: RenderTreeContext = {
		out,
		total: totalCpu,
		minValue: Math.max(3 * avgInterval, totalCpu * PRUNE_FRACTION),
		formatValue: formatMs,
		valueWidth: Math.max(8, formatMs(totalCpu).length),
	};
	out.push("");
	out.push("## Hot paths");
	const kept = roots.filter(root => root.value >= ctx.minValue).sort((a, b) => b.value - a.value);
	for (const root of kept) renderProfileNode(root, 0, ctx);
	if (kept.length === 0) out.push(`  (no call path above ${formatMs(ctx.minValue)} ms on-CPU)`);

	const totals = new Map<string, number>();
	for (const node of profile.nodes) {
		const micros = self.get(node.id) ?? 0;
		if (micros <= 0) continue;
		const name = node.callFrame.functionName;
		if (name === IDLE_FRAME || name === ROOT_FRAME) continue;
		const label = frameLabel(node.callFrame);
		totals.set(label, (totals.get(label) ?? 0) + micros);
	}
	const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]);
	if (ranked.length > 0) {
		out.push("");
		out.push("## Top functions by self time (idle time excluded)");
		for (const [label, micros] of ranked.slice(0, TOP_FUNCTIONS)) {
			out.push(`${formatMs(micros).padStart(ctx.valueWidth)} ${formatPct(micros, totalCpu).padStart(6)}  ${label}`);
		}
	}

	out.push("");
	out.push("[Summarized view of a V8 .cpuprofile. Use ':raw' to read the original JSON.]");
	return out.join("\n");
}
