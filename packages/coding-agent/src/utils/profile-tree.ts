export interface ProfileNode {
	key: string;

	label: string;

	value: number;

	recursion: number;
	children: ProfileNode[];
}

const MAX_LABEL_CHARS = 160;

export function mergeInto(a: ProfileNode, b: ProfileNode): void {
	a.value += b.value;
	a.recursion = Math.max(a.recursion, b.recursion);
	for (const child of b.children) {
		const existing = a.children.find(c => c.key === child.key);
		if (existing) mergeInto(existing, child);
		else a.children.push(child);
	}
}

function flattenRecursion(node: ProfileNode): void {
	while (node.children.some(child => child.key === node.key)) {
		node.recursion++;
		const next: ProfileNode[] = [];
		for (const child of node.children) {
			const promoted = child.key === node.key ? child.children : [child];
			for (const item of promoted) {
				const existing = next.find(c => c.key === item.key);
				if (existing) mergeInto(existing, item);
				else next.push(item);
			}
		}
		node.children = next;
	}
}

export function formatPct(n: number, total: number): string {
	if (total <= 0) return "0%";
	return `${((100 * n) / total).toFixed(1)}%`;
}

export interface RenderTreeContext {
	out: string[];

	total: number;

	minValue: number;

	formatValue: (value: number) => string;

	valueWidth: number;
}

function decoratedLabel(node: ProfileNode): string {
	let label = node.label.length > MAX_LABEL_CHARS ? `${node.label.slice(0, MAX_LABEL_CHARS - 1)}…` : node.label;
	if (node.recursion > 0) label += ` [recursive ×${node.recursion + 1}]`;
	return label;
}

export function renderProfileNode(node: ProfileNode, indent: number, ctx: RenderTreeContext): void {
	const chain: ProfileNode[] = [node];
	let cur = node;
	for (;;) {
		flattenRecursion(cur);
		if (cur.recursion > 0) break;
		const kept = cur.children.filter(child => child.value >= ctx.minValue);
		if (kept.length !== 1 || cur.value - kept[0].value >= ctx.minValue) break;
		cur = kept[0];
		chain.push(cur);
	}
	flattenRecursion(cur);

	const labels = chain.map(decoratedLabel);
	const path =
		labels.length <= 4
			? labels.join(" › ")
			: `${labels[0]} › ⋯${labels.length - 2} frames⋯ › ${labels[labels.length - 1]}`;
	const value = ctx.formatValue(chain[0].value).padStart(ctx.valueWidth);
	const pct = formatPct(chain[0].value, ctx.total).padStart(6);
	ctx.out.push(`${value} ${pct}  ${"  ".repeat(indent)}${path}`);

	const kept = cur.children.filter(child => child.value >= ctx.minValue).sort((a, b) => b.value - a.value);
	for (const child of kept) renderProfileNode(child, indent + 1, ctx);
}
