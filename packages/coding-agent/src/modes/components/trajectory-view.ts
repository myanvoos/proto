import { type Component, matchesKey, routeSgrMouseInput, ScrollView, type TUI } from "@oh-my-pi/pi-tui";
import { formatDuration, formatNumber } from "@oh-my-pi/pi-utils";
import type { Trajectory, TrajectorySource, TrajectoryStep } from "../../session/trajectory/model";
import { replaceTabs, truncateToWidth } from "../../tools/render-utils";
import type { ThemeColor } from "../theme/schema";
import { theme } from "../theme/theme";
import { DynamicBorder } from "./dynamic-border";

export interface TrajectoryViewDeps {
	trajectory: Trajectory;
	ui?: TUI;
	requestRender: () => void;
	close: () => void;
}

const FILTERS: ReadonlyArray<TrajectorySource | "all"> = [
	"all",
	"user",
	"assistant",
	"tool",
	"system",
	"compaction",
	"meta",
];

const BADGE_WIDTH = 9;

function badgeColor(source: TrajectorySource): ThemeColor {
	switch (source) {
		case "user":
			return "accent";
		case "assistant":
			return "success";
		case "tool":
			return "warning";
		default:
			return "dim";
	}
}

function sanitizeLine(text: string, maxWidth: number): string {
	return truncateToWidth(replaceTabs(text), Math.max(10, maxWidth));
}

function clockTime(ms: number): string {
	if (!ms) return "--:--:--";
	return new Date(ms).toLocaleTimeString([], { hour12: false });
}

export class TrajectoryView implements Component {
	#deps: TrajectoryViewDeps;
	#filter: TrajectorySource | "all" = "all";
	#mode: "ledger" | "inspector" = "ledger";
	#selectedStepIndex = 0;
	#scrollView = new ScrollView([], { height: 20 });

	constructor(deps: TrajectoryViewDeps) {
		this.#deps = deps;
		const lastAssistant = [...deps.trajectory.steps].reverse().find(step => step.kind === "chat");
		if (lastAssistant) this.#selectedStepIndex = lastAssistant.index;
	}

	#visibleSteps(): TrajectoryStep[] {
		const { steps } = this.#deps.trajectory;
		if (this.#filter === "all") return steps;
		return steps.filter(step => step.source === this.#filter);
	}

	#stepRows(steps: readonly TrajectoryStep[], width: number): Array<{ line: string; stepIndex: number }> {
		const rows: Array<{ line: string; stepIndex: number }> = [];
		const indexWidth = String(this.#deps.trajectory.steps.length).length;
		let lastTurn = -1;
		for (const step of steps) {
			if (step.turn !== lastTurn && step.turn > 0 && this.#filter === "all") {
				lastTurn = step.turn;
				rows.push({ line: this.#turnRule(step.turn, width), stepIndex: 0 });
			} else if (step.turn === 0 && lastTurn !== 0 && this.#filter === "all" && steps[0] === step) {
				rows.push({ line: this.#turnRule(0, width), stepIndex: 0 });
				lastTurn = 0;
			}
			const isSelected = step.index === this.#selectedStepIndex;
			const marker = isSelected ? "▸ " : "  ";
			const badge = theme.fg(badgeColor(step.source), step.title.padEnd(BADGE_WIDTH));
			const num = theme.fg("dim", String(step.index).padStart(indexWidth));
			const previewWidth = Math.max(10, width - marker.length - indexWidth - 1 - BADGE_WIDTH - 1);
			const suffix = step.durationMs != null ? theme.fg("dim", ` ${formatDuration(step.durationMs)}`) : "";
			const preview = sanitizeLine(step.preview || (step.resultText != null ? "(empty result)" : ""), previewWidth);
			const body = `${num} ${badge} ${step.isError ? theme.fg("error", preview) : preview}${suffix}`;
			rows.push({
				line: marker + (isSelected ? theme.fg("accent", body) : body),
				stepIndex: step.index,
			});
		}
		return rows;
	}

	#turnRule(turn: number, width: number): string {
		const traj = this.#deps.trajectory;
		let label: string;
		if (turn === 0) {
			label = "Preamble";
		} else {
			const turnData = traj.turns.find(candidate => candidate.index === turn);
			const secs = turnData ? formatDuration(Math.max(0, turnData.endMs - turnData.startMs)) : "?";
			label = `Turn ${turn}${turnData ? ` · ${secs}` : ""}`;
		}
		const text = theme.fg("muted", `━━ ${label} `);
		const used = label.length + 4;
		const rest = "━".repeat(Math.max(0, width - used));
		return text + theme.fg("muted", rest);
	}

	#cycleFilter(): void {
		const next = FILTERS[(FILTERS.indexOf(this.#filter) + 1) % FILTERS.length];
		this.#filter = next;
		const visible = this.#visibleSteps();
		if (visible.length > 0 && !visible.some(step => step.index === this.#selectedStepIndex)) {
			this.#selectedStepIndex = visible[Math.min(visible.length - 1, Math.floor(visible.length / 2))].index;
		}
	}

	#moveSelection(delta: number): void {
		const visible = this.#visibleSteps();
		if (visible.length === 0) return;
		const currentPos = visible.findIndex(step => step.index === this.#selectedStepIndex);
		const nextPos = Math.max(0, Math.min(visible.length - 1, (currentPos === -1 ? 0 : currentPos) + delta));
		this.#selectedStepIndex = visible[nextPos].index;
		this.#revealSelectedRow();
	}

	#revealSelectedRow(): void {
		const rows = this.#cachedRowPositions;
		const pos = rows.indexOf(this.#selectedStepIndex);
		if (pos === -1) return;
		const height = Math.max(1, this.#viewportHeight);
		const offset = this.#scrollView.getScrollOffset();
		if (pos < offset + 1) this.#scrollView.setScrollOffset(pos - 1);
		else if (pos >= offset + height - 1) this.#scrollView.setScrollOffset(pos - height + 2);
	}

	#cachedRowPositions: readonly number[] = [];
	#viewportHeight = 20;

	#selectedStep(): TrajectoryStep | undefined {
		return this.#deps.trajectory.steps.find(step => step.index === this.#selectedStepIndex);
	}

	handleInput(data: string): void {
		if (data.startsWith("\x1b[<")) {
			routeSgrMouseInput(data, event => {
				if (event.wheel !== null) {
					this.#scrollView.scroll(event.wheel * 3);
					this.#deps.requestRender();
				}
				return true;
			});
			return;
		}

		if (matchesKey(data, "escape")) {
			if (this.#mode === "inspector") {
				this.#mode = "ledger";
			} else {
				this.#deps.close();
			}
			this.#deps.requestRender();
			return;
		}
		if (matchesKey(data, "return")) {
			this.#mode = this.#mode === "inspector" ? "ledger" : "inspector";
			this.#scrollView.scrollToTop();
			this.#deps.requestRender();
			return;
		}
		if (matchesKey(data, "q")) {
			this.#deps.close();
			this.#deps.requestRender();
			return;
		}
		if (matchesKey(data, "f")) {
			this.#cycleFilter();
			this.#deps.requestRender();
			return;
		}

		if (this.#mode === "ledger") {
			if (matchesKey(data, "down") || matchesKey(data, "j")) {
				this.#moveSelection(1);
				this.#deps.requestRender();
				return;
			}
			if (matchesKey(data, "up") || matchesKey(data, "k")) {
				this.#moveSelection(-1);
				this.#deps.requestRender();
				return;
			}
			if (data === "G") {
				const visible = this.#visibleSteps();
				if (visible.length > 0) this.#selectedStepIndex = visible[visible.length - 1].index;
				this.#revealSelectedRow();
				this.#deps.requestRender();
				return;
			}
			if (data === "g") {
				const visible = this.#visibleSteps();
				if (visible.length > 0) this.#selectedStepIndex = visible[0].index;
				this.#revealSelectedRow();
				this.#deps.requestRender();
				return;
			}
		}

		if (this.#scrollView.handleScrollKey(data)) {
			this.#deps.requestRender();
		}
	}

	render(width: number): readonly string[] {
		const termHeight = process.stdout.rows || 40;
		const innerWidth = Math.max(20, width - 2);

		const headerLines = this.#headerLines(innerWidth);
		const footerLines = this.#footerLines(innerWidth);

		const steps = this.#visibleSteps();
		const stepRows = this.#stepRows(steps, innerWidth);
		this.#cachedRowPositions = stepRows.map(row => row.stepIndex);

		const chrome = headerLines.length + 2 + footerLines.length + 1;
		this.#viewportHeight = Math.max(3, termHeight - chrome);

		const content =
			this.#mode === "inspector"
				? this.#inspectorLines(steps.length > 0, innerWidth)
				: stepRows.map(row => row.line);

		this.#scrollView.setLines(content.length > 0 ? content : [theme.fg("dim", " (no matching steps)")]);
		this.#scrollView.setHeight(this.#viewportHeight);

		const lines: string[] = [];
		lines.push(...new DynamicBorder().render(width));
		for (const headerLine of headerLines) lines.push(` ${headerLine}`);
		lines.push(...new DynamicBorder().render(width));
		for (const row of this.#scrollView.render(width)) lines.push(row);
		lines.push(...new DynamicBorder().render(width));
		for (const footerLine of footerLines) lines.push(` ${footerLine}`);
		return lines;
	}

	#headerLines(width: number): string[] {
		const traj = this.#deps.trajectory;
		const title = traj.header?.title ?? traj.header?.id ?? "session";
		const wall = traj.endMs > traj.startMs ? formatDuration(traj.endMs - traj.startMs) : "?";
		const totals = traj.totals;
		const titleLine = `${theme.fg("accent", "Trajectory")} ${theme.fg("dim", `— ${sanitizeLine(title, Math.max(10, width - 16))}`)}`;
		const stats = [
			`${traj.turnCount} turns`,
			`${traj.steps.length} steps`,
			`in ${formatNumber(totals.input)}`,
			`out ${formatNumber(totals.output)}`,
			`cache ${formatNumber(totals.cacheRead)}/${formatNumber(totals.cacheWrite)}`,
			`${totals.costUsd.toFixed(4)} USD`,
			wall,
		].join(" · ");
		const statLines = [theme.fg("dim", truncateToWidth(stats, width))];
		if (traj.hasErrors) statLines.unshift(theme.fg("error", "! session contains errors"));
		return [truncateToWidth(titleLine, width), ...statLines];
	}

	#footerLines(width: number): string[] {
		if (this.#mode === "inspector") {
			return [theme.fg("dim", truncateToWidth(" [esc] back to ledger · ↑↓ scroll", width))];
		}
		const filterLabel = this.#filter.toUpperCase();
		return [
			theme.fg(
				"dim",
				truncateToWidth(
					` [↑↓/jk] select · [enter] inspect · [f] filter:${filterLabel} · [g/G] top/end · [q/esc] close`,
					width,
				),
			),
		];
	}

	#inspectorLines(hasSteps: boolean, width: number): string[] {
		const step = this.#selectedStep();
		if (!hasSteps || !step) return [theme.fg("dim", "(nothing selected)")];

		const metaParts = [`step ${step.index}`, step.kind];
		if (step.detail) metaParts.push(sanitizeLine(step.detail, 60));
		const lines: string[] = [
			`${theme.fg(badgeColor(step.source), step.title)} ${theme.fg("dim", truncateToWidth(metaParts.join(" · "), width))}`,
		];

		const timing: string[] = [clockTime(step.timestampMs)];
		if (step.durationMs != null) timing.push(`dur ${formatDuration(step.durationMs)}`);
		if (step.ttftMs != null) timing.push(`ttft ${formatDuration(step.ttftMs)}`);
		lines.push(theme.fg("dim", truncateToWidth(timing.join(" · "), width)));

		const usage = step.usage;
		if (usage) {
			const usageParts = [
				`in ${formatNumber(usage.input)}`,
				usage.cacheRead > 0 ? `+${formatNumber(usage.cacheRead)} cached` : undefined,
				usage.cacheWrite > 0 ? `+${formatNumber(usage.cacheWrite)} cache-write` : undefined,
				`out ${formatNumber(usage.output)}`,
				usage.reasoningTokens != null ? `(${formatNumber(usage.reasoningTokens)} reasoning)` : undefined,
				usage.cost ? `$${usage.cost.total.toFixed(4)}` : undefined,
			].filter(Boolean);
			lines.push(theme.fg("dim", truncateToWidth(usageParts.join(" · "), width)));
		}

		lines.push(theme.fg("muted", "─".repeat(Math.min(width, 40))));
		const wrapped = Bun.wrapAnsi(replaceTabs(step.content || "(no content)"), width, { hard: true }).split("\n");
		for (const line of wrapped) lines.push(line);
		return lines;
	}
}
