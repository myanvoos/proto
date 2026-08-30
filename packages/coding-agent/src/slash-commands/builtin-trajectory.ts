import { Text } from "@oh-my-pi/pi-tui";
import { formatDuration, formatNumber } from "@oh-my-pi/pi-utils";
import { trajectoryToOtlpJson } from "../session/trajectory/export-otel";
import type { Trajectory } from "../session/trajectory/model";
import { buildSessionTrajectory, defaultExportPath } from "../session/trajectory/session-source";
import { commandConsumed, errorMessage, parseSubcommand, usage } from "./helpers/parse";
import type {
	BuiltinSlashCommand,
	ParsedSlashCommand,
	SlashCommandResult,
	SlashCommandRuntime,
	SlashCommandSpec,
} from "./types";

const USAGE_TEXT = "Usage: /trajectory [view] | stats | export [<path>]";

const BADGE_PAD = 10;

interface ExportRequest {
	path?: string;
	error?: string;
}

function parseExportArgs(rest: string): ExportRequest {
	const tokens = rest.split(/\s+/).filter(Boolean);
	if (tokens.length > 1) return { error: "export takes at most one path" };
	return { path: tokens[0] };
}

async function writeExport(trajectory: Trajectory, request: ExportRequest, cwd: string): Promise<string> {
	const target = request.path ?? defaultExportPath(cwd, trajectory.header?.id ?? "session");
	await Bun.write(target, trajectoryToOtlpJson(trajectory));
	return `Wrote OTLP export (${trajectory.steps.length} steps) → ${target}`;
}

function formatStats(trajectory: Trajectory): string {
	const lines: string[] = [];
	const title = trajectory.header?.title ?? "(untitled)";
	lines.push(`Trajectory — ${title}`);
	lines.push(
		`${trajectory.turnCount} turns · ${trajectory.steps.length} steps · wall ${
			trajectory.endMs > trajectory.startMs ? formatDuration(trajectory.endMs - trajectory.startMs) : "?"
		}`,
	);
	const totals = trajectory.totals;
	lines.push(
		`tokens: in ${formatNumber(totals.input)} · out ${formatNumber(totals.output)} · cache read ${formatNumber(totals.cacheRead)} · cache write ${formatNumber(totals.cacheWrite)} · total ${formatNumber(totals.totalTokens)}`,
	);
	lines.push(`cost: $${totals.costUsd.toFixed(4)} across ${totals.requests} requests`);
	if (trajectory.hasErrors) lines.push("contains errors");
	lines.push("");
	for (const step of trajectory.steps.slice(-20)) {
		lines.push(`${String(step.index).padStart(4)}  ${step.title.padEnd(BADGE_PAD)}  ${step.preview.slice(0, 100)}`);
	}
	if (trajectory.steps.length > 20) lines.push(`… ${trajectory.steps.length - 20} earlier steps`);
	return lines.join("\n");
}

function resolveCommand(args: string): { verb: string; request?: ExportRequest } {
	const { verb, rest } = parseSubcommand(args);
	if (verb === "export") return { verb, request: parseExportArgs(rest) };
	return { verb };
}

async function handleText(command: ParsedSlashCommand, runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	const trajectory = buildSessionTrajectory(runtime.sessionManager);
	const { verb, request } = resolveCommand(command.args);

	if (verb === "" || verb === "view" || verb === "stats") {
		runtime.output(formatStats(trajectory));
		return commandConsumed();
	}
	if (verb === "export") {
		if (!request || request.error) {
			return usage(`/trajectory export: ${request?.error ?? "invalid arguments"}`, runtime);
		}
		try {
			runtime.output(await writeExport(trajectory, request, runtime.cwd));
		} catch (err) {
			return usage(`Export failed: ${errorMessage(err)}`, runtime);
		}
		return commandConsumed();
	}
	return usage(USAGE_TEXT, runtime);
}

const TRAJECTORY_SPEC: SlashCommandSpec = {
	name: "trajectory",
	description: "Inspect session trajectory",
	allowArgs: true,
	subcommands: [
		{ name: "view", description: "Open the fullscreen trajectory ledger" },
		{ name: "stats", description: "Print trajectory summary and recent steps" },
		{
			name: "export",
			description: "Export OTLP JSON",
			usage: "[<path>]",
		},
	],
	handle: handleText,
	handleTui: async (command, runtime) => {
		const ctx = runtime.ctx;
		ctx.editor.setText("");
		const trajectory = buildSessionTrajectory(ctx.sessionManager);
		const { verb, request } = resolveCommand(command.args);

		if (verb === "" || verb === "view") {
			ctx.showTrajectoryView();
			return;
		}
		if (verb === "stats") {
			ctx.presentCommandOutput(new Text(formatStats(trajectory)));
			return;
		}
		if (verb === "export") {
			if (!request || request.error) {
				ctx.showError(request?.error ?? USAGE_TEXT);
				return;
			}
			try {
				ctx.showStatus(await writeExport(trajectory, request, ctx.sessionManager.getCwd()));
			} catch (err) {
				ctx.showError(`Export failed: ${errorMessage(err)}`);
			}
			return;
		}
		ctx.showError(USAGE_TEXT);
	},
};

export const BUILTIN_TRAJECTORY_SLASH_COMMANDS: ReadonlyArray<BuiltinSlashCommand | SlashCommandSpec> = [
	TRAJECTORY_SPEC,
];
