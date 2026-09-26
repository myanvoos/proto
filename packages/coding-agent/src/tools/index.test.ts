import { describe, expect, test } from "bun:test";
import { AsyncJobManager } from "../async/job-manager";
import { Settings } from "../config/settings";
import { createTools, type ToolSession } from ".";
import { dispatchXdArgv } from "./xdev";

function enabledToolSession(): ToolSession {
	const settings = Settings.isolated({
		"ask.enabled": true,
		"autolearn.enabled": true,
		"bash.enabled": true,
		"browser.enabled": true,
		"checkpoint.enabled": true,
		"computer.enabled": true,
		"goal.enabled": false,
		"inspect_media.mode": "on",
		"monitor.enabled": true,
		"checklist.enabled": true,
		"tools.xdev": false,
		"web_search.enabled": true,
	});
	return {
		cwd: import.meta.dir,
		hasUI: false,
		canPromptUser: true,
		settings,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		getGoalModeState: () => undefined,
		getActiveModel: () => undefined,
		taskDepth: 0,
		asyncJobManager: new AsyncJobManager({}),
	} as unknown as ToolSession;
}

describe("unified control surface authorization", () => {
	for (const dispatch of ["native", "xd"] as const) {
		test(`${dispatch} preserves operation policy before side effects`, async () => {
			const session = enabledToolSession();
			session.enableIrc = false;
			session.getSessionSpawns = () => "";
			session.settings.set("monitor.enabled", false);
			session.settings.set("launch.enabled", false);
			const tools = await createTools(session, ["fleet", "jobs", "context"]);
			session.xdev = {
				tools: new Map(tools.map(tool => [tool.name, tool])),
				mountedNames: new Set(tools.map(tool => tool.name)),
				builtInNames: new Set(tools.map(tool => tool.name)),
				isActive: () => false,
			};
			for (const [name, args] of [
				["fleet", { op: "spawn", message: "must not start" }],
				["fleet", { op: "message", to: "peer", message: "must not deliver" }],
				["jobs", { op: "watch", command: "printf must-not-run" }],
				["jobs", { op: "start", name: "must-not-start", application: "/bin/true" }],
			] as const) {
				const tool = tools.find(candidate => candidate.name === name)!;
				const result =
					dispatch === "native"
						? await tool.execute("denied", args)
						: await dispatchXdArgv(session, name, ["--json", JSON.stringify(args)], undefined, undefined, {
								toolCallId: "denied",
							});
				expect(result.isError, `${name} ${args.op}`).toBe(true);
				expect(session.asyncJobManager!.getRunningJobs()).toEqual([]);
			}
		});
	}

	test("watch creation requires an owner even when enabled", async () => {
		const session = enabledToolSession();
		const tools = await createTools(session, ["jobs"]);
		const result = await tools
			.find(tool => tool.name === "jobs")!
			.execute("unowned", {
				op: "watch",
				command: "printf READY",
			});
		expect(result.isError).toBe(true);
		expect(session.asyncJobManager!.getRunningJobs()).toEqual([]);
	});
});
