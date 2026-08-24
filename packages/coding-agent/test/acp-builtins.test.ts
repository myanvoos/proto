import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Tokenizer } from "@oh-my-pi/pi-agent-core";
import type {
	ResetCreditAccountStatus,
	ResetCreditRedeemOutcome,
	ResetCreditTarget,
	UsageReport,
} from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { executeAcpBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import { setProjectDir } from "@oh-my-pi/pi-utils";

interface FakeAcpBuiltinSession {
	fastMode: boolean;
	forcedToolChoice: string | undefined;
	isStreaming: boolean;
	sessionFile: string | undefined;
	sessionId: string;
	sessionName: string;
	_todoPhases: Array<{ name: string; tasks: Array<{ content: string; status: string }> }>;
	_switchedTo: string | undefined;
	_movedFromEmptySessionFile: string | undefined;
	toggleFastMode(): boolean;
	setFastMode(enabled: boolean): boolean;
	isFastModeEnabled(): boolean;
	fetchUsageReports?: () => Promise<unknown>;
	getAsyncJobSnapshot: (opts?: { recentLimit?: number }) => { running: unknown[]; recent: unknown[] } | null;
	getLastAssistantText: () => string | undefined;
	messages: unknown[];
	settings: Settings;
	model: { provider: string; id: string } | undefined;
	newSession(opts?: { drop?: boolean; parentSession?: string }): Promise<boolean>;
	switchSession(sessionPath: string): Promise<boolean>;
	moveSession(newCwd: string, targetSessionDir?: string): Promise<void>;
	markMovedFromEmptySessionFile(sessionFile: string): void;
	fork(): Promise<boolean>;
	handoff(instr?: string): Promise<{ document: string; savedPath?: string } | undefined>;
	getTodoPhases(): Array<{ name: string; tasks: Array<{ content: string; status: string }> }>;
	setTodoPhases(phases: Array<{ name: string; tasks: Array<{ content: string; status: string }> }>): void;
	refreshBaseSystemPrompt(): Promise<void>;
	getToolByName(name: string): unknown;
	compact(args?: string): Promise<void>;
	getContextUsage(): { tokens?: number; contextWindow: number } | undefined;
	getAvailableModels(): Array<{ provider: string; id: string; contextWindow?: number }>;
	setModel(model: unknown): Promise<void>;
	listResetCredits: () => Promise<ResetCreditAccountStatus[]>;
	redeemResetCredit: (target: ResetCreditTarget) => Promise<ResetCreditRedeemOutcome>;
}

interface FakeAcpBuiltinSessionManager {
	_sessionFile: string | undefined;
	_cwd: string;
	_entries: { type: string }[];
	_customEntries: Array<{ customType: string; data: unknown }>;
	_movedTo: string | undefined;
	_flushed: boolean;
	_droppedSessions: string[];
	_sessionName: string | undefined;
	getSessionId(): string;
	getSessionFile(): string | undefined;
	getEntries(): { type: string }[];
	getBranch(): { type: string }[];
	appendCustomEntry(customType: string, data?: unknown): string;
	flush(): Promise<void>;
	moveTo(newCwd: string): Promise<void>;
	setSessionFile(sessionFile: string): Promise<void>;
	dropSession(sessionPath: string): Promise<void>;
	getCwd(): string;
	setSessionName(name: string, source: string): Promise<boolean>;
}

function createRuntime() {
	const settings = Settings.isolated();
	const output: string[] = [];
	let fakeSessionManager: FakeAcpBuiltinSessionManager | undefined;
	const session: FakeAcpBuiltinSession = {
		fastMode: false,
		forcedToolChoice: undefined as string | undefined,
		isStreaming: false,
		sessionFile: undefined,
		sessionId: "fake-session-id",
		sessionName: "Fake Session",
		_todoPhases: [],
		_switchedTo: undefined,
		_movedFromEmptySessionFile: undefined,
		toggleFastMode() {
			this.fastMode = !this.fastMode;
			return this.fastMode;
		},
		setFastMode(enabled: boolean) {
			this.fastMode = enabled;
			return true;
		},
		isFastModeEnabled() {
			return this.fastMode;
		},
		async listResetCredits() {
			return [];
		},
		async redeemResetCredit(_target) {
			return { ok: false, code: "no_credit" };
		},
		async newSession(_opts?: { drop?: boolean; parentSession?: string }) {
			return true;
		},
		async switchSession(sessionPath: string) {
			this._switchedTo = path.resolve(sessionPath);
			this.sessionFile = this._switchedTo;
			if (!fakeSessionManager) throw new Error("fake session manager not initialized");
			await fakeSessionManager.flush();
			await fakeSessionManager.setSessionFile(this._switchedTo);
			return true;
		},
		async moveSession(newCwd: string, _targetSessionDir?: string) {
			if (!fakeSessionManager) throw new Error("fake session manager not initialized");
			await fakeSessionManager.moveTo(newCwd);
		},
		markMovedFromEmptySessionFile(sessionFile: string) {
			this._movedFromEmptySessionFile = path.resolve(sessionFile);
		},
		async fork() {
			return true;
		},
		async handoff(_instr?: string) {
			return undefined;
		},
		getTodoPhases() {
			return this._todoPhases;
		},
		setTodoPhases(phases) {
			this._todoPhases = phases;
		},
		async refreshBaseSystemPrompt() {},
		getAsyncJobSnapshot: () => null,
		getLastAssistantText: () => undefined,
		messages: [],
		model: undefined,
		settings,
		getToolByName: (_name: string) => undefined,
		async compact(_args?: string) {},
		getContextUsage: () => undefined,
		getAvailableModels: () => [] as Array<{ provider: string; id: string; contextWindow?: number }>,
		async setModel(_model: unknown) {},
	};
	const typedSession = session as unknown as AgentSession & FakeAcpBuiltinSession;
	fakeSessionManager = {
		_sessionFile: undefined as string | undefined,
		_cwd: "/tmp/project",
		_entries: [] as { type: string }[],
		_customEntries: [] as Array<{ customType: string; data: unknown }>,
		_movedTo: undefined as string | undefined,
		_flushed: false,
		_droppedSessions: [] as string[],
		_sessionName: undefined as string | undefined,
		getSessionId(): string {
			return "fake-session-id";
		},
		getSessionFile(): string | undefined {
			return this._sessionFile;
		},
		getEntries(): { type: string }[] {
			return this._entries;
		},
		getBranch(): { type: string }[] {
			return this._entries;
		},
		appendCustomEntry(customType: string, data?: unknown): string {
			this._customEntries.push({ customType, data });
			return "fake-entry-id";
		},
		async flush() {
			this._flushed = true;
		},
		async moveTo(newCwd: string) {
			this._cwd = newCwd;
			this._movedTo = newCwd;
		},
		async setSessionFile(sessionFile: string) {
			this._sessionFile = path.resolve(sessionFile);
			const headerLine = (await Bun.file(this._sessionFile).text()).split("\n", 1)[0] ?? "{}";
			const header = JSON.parse(headerLine) as { cwd?: string };
			if (header.cwd) {
				this._cwd = path.resolve(header.cwd);
				this._movedTo = this._cwd;
			}
		},
		async dropSession(sessionPath: string) {
			this._droppedSessions.push(path.resolve(sessionPath));
			await fs.rm(sessionPath, { force: true });
		},
		getCwd(): string {
			return this._cwd;
		},
		async setSessionName(name: string, _source: string): Promise<boolean> {
			this._sessionName = name;
			return true;
		},
	};
	return {
		output,
		session,
		fakeSessionManager,
		runtime: {
			session: typedSession,
			sessionManager: fakeSessionManager as unknown as SessionManager,
			settings,
			cwd: "/tmp/project",
			output: (text: string) => {
				output.push(text);
			},
			refreshCommands: () => {},
			reloadPlugins: async () => {},
			notifyTitleChanged: undefined as (() => Promise<void> | void) | undefined,
			notifyConfigChanged: undefined as (() => Promise<void> | void) | undefined,
		},
	};
}

describe("ACP builtin slash commands", () => {
	it("consumes fast status without returning prompt text", async () => {
		const { output, runtime } = createRuntime();

		const result = await executeAcpBuiltinSlashCommand("/fast status", runtime);

		expect(result).toEqual({ consumed: true });
		expect(output).toEqual(["Fast mode is off."]);
	});

	it("toggles extended context with explicit controls and reports state", async () => {
		const { output, runtime } = createRuntime();

		expect(await executeAcpBuiltinSlashCommand("/extended-context off", runtime)).toEqual({ consumed: true });
		expect(runtime.settings.get("extendedContext")).toBe(false);
		expect(await executeAcpBuiltinSlashCommand("/extended-context on", runtime)).toEqual({ consumed: true });
		expect(runtime.settings.get("extendedContext")).toBe(true);
		expect(await executeAcpBuiltinSlashCommand("/extended-context", runtime)).toEqual({ consumed: true });
		expect(runtime.settings.get("extendedContext")).toBe(false);
		expect(await executeAcpBuiltinSlashCommand("/extended-context status", runtime)).toEqual({ consumed: true });
		expect(output).toEqual([
			"Extended context disabled.",
			"Extended context enabled.",
			"Extended context disabled.",
			"Extended context is off.",
		]);
	});

	it("renders provider usage reports when the session can fetch them", async () => {
		const { output, runtime } = createRuntime();
		runtime.session.fetchUsageReports = async () => [
			{
				provider: "openai-codex",
				fetchedAt: Date.now(),
				limits: [
					{
						id: "codex-5h",
						label: "5 hours",
						scope: { provider: "openai-codex", tier: "prolite", accountId: "account-1" },
						window: { id: "5h", label: "5 hours", resetsAt: Date.now() + 60 * 60 * 1000 },
						amount: { used: 0.24, usedFraction: 0.24, unit: "unknown" },
					},
				],
				metadata: { email: "user@example.com" },
			},
		];

		const result = await executeAcpBuiltinSlashCommand("/usage", runtime);

		expect(result).toEqual({ consumed: true });
		expect(output[0]).toContain("Openai Codex");
		expect(output[0]).toContain("5 hours (prolite)");
		expect(output[0]).toContain("user@example.com: 0.24 unknown used (76.0% left)");
		expect(output[0]).toContain("resets in");
	});

	it("suppresses redundant usage window suffixes while retaining legitimate ones", async () => {
		const { output, runtime } = createRuntime();
		runtime.session.fetchUsageReports = async () => [
			{
				provider: "anthropic",
				fetchedAt: Date.now(),
				limits: [
					{
						id: "anthropic:extra",
						label: "Claude Extra Usage",
						scope: { provider: "anthropic", windowId: "extra" },
						amount: { used: 123.45, unit: "usd" },
					},
					{
						id: "anthropic:daily",
						label: "Daily quota",
						scope: { provider: "anthropic", windowId: "24h" },
						window: { id: "24h", label: "24 hours" },
						amount: { used: 20, unit: "requests" },
					},
				],
				metadata: { email: "user@example.com" },
			},
		];

		const result = await executeAcpBuiltinSlashCommand("/usage", runtime);

		expect(result).toEqual({ consumed: true });
		expect(output[0]).toContain("Claude Extra Usage");
		expect(output[0]).not.toContain("Claude Extra Usage — extra");
		expect(output[0]).toContain("123.45 usd used");
		expect(output[0]).toContain("Daily quota — 24 hours");
	});
	it("/usage show renders the same report as plain /usage", async () => {
		const now = 1_700_000_000_000;
		const nowSpy = spyOn(Date, "now").mockReturnValue(now);
		try {
			const reports: UsageReport[] = [
				{
					provider: "openai-codex",
					fetchedAt: now - 5_000,
					limits: [
						{
							id: "codex-5h",
							label: "5 hours",
							scope: { provider: "openai-codex", tier: "prolite", accountId: "account-1" },
							window: { id: "5h", label: "5 hours", resetsAt: now + 60 * 60 * 1000 },
							amount: { used: 0.24, usedFraction: 0.24, unit: "unknown" },
						},
					],
					metadata: { email: "user@example.com" },
				},
			];
			const plain = createRuntime();
			const show = createRuntime();
			plain.runtime.session.fetchUsageReports = async () => reports;
			show.runtime.session.fetchUsageReports = async () => reports;

			const plainResult = await executeAcpBuiltinSlashCommand("/usage", plain.runtime);
			const showResult = await executeAcpBuiltinSlashCommand("/usage show", show.runtime);

			expect(showResult).toEqual(plainResult);
			expect(show.output).toEqual(plain.output);
		} finally {
			nowSpy.mockRestore();
		}
	});

	it("routes saved reset redemption through /usage reset", async () => {
		const { output, runtime } = createRuntime();
		let redeemedTarget: ResetCreditTarget | undefined;
		runtime.session.listResetCredits = async () => [
			{
				credentialId: 42,
				accountId: "account-1",
				email: "user@example.com",
				availableCount: 1,
				credits: [],
				active: true,
			},
		];
		runtime.session.redeemResetCredit = async target => {
			redeemedTarget = target;
			return { ok: true, code: "reset", email: target.email };
		};

		const result = await executeAcpBuiltinSlashCommand("/usage reset active", runtime);

		expect(result).toEqual({ consumed: true });
		expect(redeemedTarget).toEqual({ credentialId: 42, accountId: "account-1", email: "user@example.com" });
		expect(output).toEqual(["Reset applied for user@example.com — your rate-limit window has been refreshed."]);
	});

	it("does not dispatch the legacy /reset-usage command", async () => {
		const { output, runtime } = createRuntime();

		const result = await executeAcpBuiltinSlashCommand("/reset-usage active", runtime);

		expect(result).toBe(false);
		expect(output).toEqual([]);
	});

	it("returns false for unknown commands", async () => {
		const { runtime } = createRuntime();

		const result = await executeAcpBuiltinSlashCommand("/not-a-real-command-xyz", runtime);

		expect(result).toBe(false);
	});

	// /jobs
	it("jobs: shows informative message when snapshot is null", async () => {
		const { output, runtime } = createRuntime();
		const result = await executeAcpBuiltinSlashCommand("/jobs", runtime);
		expect(result).toEqual({ consumed: true });
		expect(output[0]).toContain("background jobs");
	});

	it("jobs: lists running and recent jobs from snapshot", async () => {
		const { output, runtime } = createRuntime();
		runtime.session.getAsyncJobSnapshot = () => ({
			running: [{ id: "j1", type: "bash", status: "running", label: "npm install", startTime: Date.now() - 5000 }],
			recent: [
				{ id: "j2", type: "worker", status: "completed", label: "build done", startTime: Date.now() - 60_000 },
			],
			delivery: { queued: 0, delivering: false, pendingJobIds: [] },
		});

		const result = await executeAcpBuiltinSlashCommand("/jobs", runtime);

		expect(result).toEqual({ consumed: true });
		expect(output[0]).toContain("npm install");
		expect(output[0]).toContain("build done");
		expect(output[0]).toContain("Running Jobs");
		expect(output[0]).toContain("Recent Jobs");
	});

	// /model
	it("model: returns current model when set", async () => {
		const { output, runtime } = createRuntime();
		runtime.session.model = { provider: "anthropic", id: "claude-opus-4-5" } as never;

		const result = await executeAcpBuiltinSlashCommand("/model", runtime);

		expect(result).toEqual({ consumed: true });
		expect(output[0]).toContain("anthropic/claude-opus-4-5");
	});

	it("model: returns no-selection message when undefined", async () => {
		const { output, runtime } = createRuntime();

		const result = await executeAcpBuiltinSlashCommand("/model", runtime);

		expect(result).toEqual({ consumed: true });
		expect(output[0]).toContain("No model");
	});

	it("model: returns ACP usage message when args provided", async () => {
		const { output, runtime } = createRuntime();

		const result = await executeAcpBuiltinSlashCommand("/model claude-3-5-sonnet", runtime);

		expect(result).toEqual({ consumed: true });
		expect(output[0]?.toLowerCase()).toContain("acp");
	});

	it("model: applies known id and emits both title + config change notifications", async () => {
		const { output, runtime, session } = createRuntime();
		const available = [{ provider: "anthropic", id: "claude-3-5-sonnet", contextWindow: 200_000 }];
		session.getAvailableModels = () => available;
		let titleNotified = 0;
		let configNotified = 0;
		runtime.notifyTitleChanged = () => {
			titleNotified++;
		};
		runtime.notifyConfigChanged = () => {
			configNotified++;
		};
		const setModelSpy = spyOn(session, "setModel").mockResolvedValue(undefined);

		const result = await executeAcpBuiltinSlashCommand("/model claude-3-5-sonnet", runtime);

		expect(result).toEqual({ consumed: true });
		expect(setModelSpy).toHaveBeenCalledWith(available[0]);
		expect(output[0]).toContain("Model set to anthropic/claude-3-5-sonnet");
		expect(titleNotified).toBe(1);
		expect(configNotified).toBe(1);
	});

	it("model: does not emit config change when id is unknown", async () => {
		const { runtime } = createRuntime();
		let configNotified = 0;
		runtime.notifyConfigChanged = () => {
			configNotified++;
		};

		await executeAcpBuiltinSlashCommand("/model nonexistent", runtime);

		expect(configNotified).toBe(0);
	});

	// Removed TUI-only and dropped commands fall through as false
	it("removed commands return false (fall through to model)", async () => {
		const removedCommands = [
			"/login",
			"/logout",
			"/resume",
			"/tree",
			"/branch",
			"/plan",
			"/loop",
			"/hotkeys",
			"/extensions",
			"/agents",
			"/copy",
			"/btw hi",
			"/new",
			"/drop",
			"/fork",
		];
		for (const cmd of removedCommands) {
			const { runtime } = createRuntime();
			const result = await executeAcpBuiltinSlashCommand(cmd, runtime);
			expect(result).toBe(false);
		}
	});
});

describe("session lifecycle commands", () => {
	it("/session delete: returns in-memory usage when no sessionFile", async () => {
		const { output, runtime } = createRuntime();
		const result = await executeAcpBuiltinSlashCommand("/session delete", runtime);
		expect(result).toEqual({ consumed: true });
		expect(output[0]).toContain("in-memory");
	});

	it("/session delete: refuses while streaming", async () => {
		const { output, session, fakeSessionManager, runtime } = createRuntime();
		session.isStreaming = true;
		fakeSessionManager._sessionFile = "/tmp/session.jsonl";
		const result = await executeAcpBuiltinSlashCommand("/session delete", runtime);
		expect(result).toEqual({ consumed: true });
		expect(output[0]).toContain("streaming");
	});

	it("/rename: renames and calls notifyTitleChanged on success", async () => {
		const { output, fakeSessionManager, runtime } = createRuntime();
		let notified = false;
		runtime.notifyTitleChanged = async () => {
			notified = true;
		};
		const result = await executeAcpBuiltinSlashCommand("/rename Project Apex", runtime);
		expect(result).toEqual({ consumed: true });
		expect(fakeSessionManager._sessionName).toBe("Project Apex");
		expect(output[0]).toBe("Session renamed to Project Apex.");
		expect(notified).toBe(true);
	});

	it("/rename: outputs precedence message when setSessionName returns false", async () => {
		const { output, fakeSessionManager, runtime } = createRuntime();
		let notified = false;
		runtime.notifyTitleChanged = async () => {
			notified = true;
		};
		fakeSessionManager.setSessionName = async () => false;
		const result = await executeAcpBuiltinSlashCommand("/rename Bar", runtime);
		expect(result).toEqual({ consumed: true });
		expect(output[0]).toContain("takes precedence");
		expect(notified).toBe(false);
	});

	it("/move: refuses while streaming", async () => {
		const { output, session, runtime } = createRuntime();
		session.isStreaming = true;
		const result = await executeAcpBuiltinSlashCommand("/move /tmp", runtime);
		expect(result).toEqual({ consumed: true });
		expect(output[0]).toContain("streaming");
	});
});

describe("wave 4 commands", () => {
	// /mcp
	it("/mcp (no args): outputs help text containing list, enable, disable, remove, reload", async () => {
		const { output, runtime } = createRuntime();
		const result = await executeAcpBuiltinSlashCommand("/mcp", runtime);
		expect(result).toEqual({ consumed: true });
		expect(output[0]).toContain("list");
		expect(output[0]).toContain("enable");
		expect(output[0]).toContain("disable");
		expect(output[0]).toContain("remove");
		expect(output[0]).toContain("reload");
	});

	it("/mcp help: outputs help text containing list, enable, disable, remove, reload", async () => {
		const { output, runtime } = createRuntime();
		const result = await executeAcpBuiltinSlashCommand("/mcp help", runtime);
		expect(result).toEqual({ consumed: true });
		expect(output[0]).toContain("list");
		expect(output[0]).toContain("enable");
		expect(output[0]).toContain("disable");
		expect(output[0]).toContain("remove");
		expect(output[0]).toContain("reload");
	});

	it("/mcp add (no args): returns usage string", async () => {
		const { output, runtime } = createRuntime();
		const result = await executeAcpBuiltinSlashCommand("/mcp add", runtime);
		expect(result).toEqual({ consumed: true });
		expect(output[0]).toContain("Usage");
	});

	it("/mcp reload: calls refreshCommands and outputs confirmation", async () => {
		let refreshCalled = false;
		const { output, runtime } = createRuntime();
		runtime.refreshCommands = () => {
			refreshCalled = true;
		};
		const result = await executeAcpBuiltinSlashCommand("/mcp reload", runtime);
		expect(result).toEqual({ consumed: true });
		expect(refreshCalled).toBe(true);
		expect(output[0]).toContain("reload");
	});

	it("/mcp resources: outputs server list or no-server message", async () => {
		const { output, runtime } = createRuntime();
		const result = await executeAcpBuiltinSlashCommand("/mcp resources", runtime);
		expect(result).toEqual({ consumed: true });
		// No servers configured in tmp project dir — should report that
		expect(output[0]).toMatch(/No MCP servers configured|No resources/);
	});

	it("/mcp unknown-verb: returns usage pointing to help", async () => {
		const { output, runtime } = createRuntime();
		const result = await executeAcpBuiltinSlashCommand("/mcp frobnicate", runtime);
		expect(result).toEqual({ consumed: true });
		expect(output[0]).toContain("Unknown");
	});

	// /ssh
	it("/ssh (no args): outputs help text containing list and remove", async () => {
		const { output, runtime } = createRuntime();
		const result = await executeAcpBuiltinSlashCommand("/ssh", runtime);
		expect(result).toEqual({ consumed: true });
		expect(output[0]).toContain("list");
		expect(output[0]).toContain("remove");
	});

	it("/ssh help: outputs help text containing list and remove", async () => {
		const { output, runtime } = createRuntime();
		const result = await executeAcpBuiltinSlashCommand("/ssh help", runtime);
		expect(result).toEqual({ consumed: true });
		expect(output[0]).toContain("list");
		expect(output[0]).toContain("remove");
	});

	it("/ssh add (no args): returns usage", async () => {
		const { output, runtime } = createRuntime();
		const result = await executeAcpBuiltinSlashCommand("/ssh add", runtime);
		expect(result).toEqual({ consumed: true });
		expect(output[0]).toContain("Usage");
	});

	it("/ssh unknown-verb: returns unknown subcommand message", async () => {
		const { output, runtime } = createRuntime();
		const result = await executeAcpBuiltinSlashCommand("/ssh frobnicate", runtime);
		expect(result).toEqual({ consumed: true });
		expect(output[0]).toContain("Unknown");
	});

	// /marketplace
	it("/marketplace help: outputs help text", async () => {
		const { output, runtime } = createRuntime();
		const result = await executeAcpBuiltinSlashCommand("/marketplace help", runtime);
		expect(result).toEqual({ consumed: true });
		expect(output[0]).toContain("Marketplace commands");
		expect(output[0]).toContain("install");
	});

	it("/marketplace install (no args): returns interactive picker usage", async () => {
		const { output, runtime } = createRuntime();
		const result = await executeAcpBuiltinSlashCommand("/marketplace install", runtime);
		expect(result).toEqual({ consumed: true });
		expect(output[0]).toContain("TUI-only");
	});

	it("/marketplace uninstall (no args): returns interactive picker usage", async () => {
		const { output, runtime } = createRuntime();
		const result = await executeAcpBuiltinSlashCommand("/marketplace uninstall", runtime);
		expect(result).toEqual({ consumed: true });
		expect(output[0]).toContain("TUI-only");
	});

	// /plugins

	// /todo start with in_progress status in fuzzy list
	it("/todo start: resolves ambiguous matches by preferring active tasks", async () => {
		const { output, session, runtime } = createRuntime();
		session._todoPhases = [
			{
				name: "Phase 1",
				tasks: [
					{ content: "Wire auth middleware", status: "pending" },
					{ content: "Wire session store", status: "completed" },
				],
			},
		];
		const result = await executeAcpBuiltinSlashCommand('/todo start "wire"', runtime);
		expect(result).toEqual({ consumed: true });
		expect(output[0]).toContain("Wire auth middleware");
	});
});

describe("wave 5 — adapters and polish", () => {
	// /mcp help lists new subcommands
	it("/mcp help: lists resources, prompts, test, add, smithery-search", async () => {
		const { output, runtime } = createRuntime();
		const result = await executeAcpBuiltinSlashCommand("/mcp help", runtime);
		expect(result).toEqual({ consumed: true });
		expect(output[0]).toContain("resources");
		expect(output[0]).toContain("prompts");
		expect(output[0]).toContain("test");
		expect(output[0]).toContain("add");
		expect(output[0]).toContain("smithery-search");
	});

	// /mcp add — verify parsing and output message
	it("/mcp add foo --url https://example.com --token X --scope project: outputs success or propagates write error", async () => {
		// Uses project scope so it writes to /tmp/project/.omp/mcp.json which test infra controls.
		// We verify the command either reports success or a meaningful error (not a parse error).
		const mcpModule = await import("@oh-my-pi/pi-coding-agent/mcp/config-writer");
		const spy = spyOn(mcpModule, "addMCPServer").mockResolvedValue(undefined);
		try {
			const { output, runtime } = createRuntime();
			const result = await executeAcpBuiltinSlashCommand(
				"/mcp add foo --url https://example.com --token X --scope project",
				runtime,
			);
			expect(result).toEqual({ consumed: true });
			expect(output[0]).toContain('Added MCP server "foo" (project).');
			expect(spy).toHaveBeenCalledTimes(1);
			// Lock in the parsed call shape so future regressions in
			// `--url` / `--token` / `--scope` parsing fail this test instead of
			// silently writing a different config.
			const [configPath, serverName, serverConfig] = spy.mock.calls[0]!;
			expect(configPath).toContain("project");
			expect(serverName).toBe("foo");
			expect(serverConfig).toMatchObject({
				type: "http",
				url: "https://example.com",
				headers: { Authorization: "Bearer X" },
			});
		} finally {
			spy.mockRestore();
		}
	});

	// /mcp test — spy on connectToServer
	it("/mcp test bogus: returns error when server not found in config", async () => {
		const { output, runtime } = createRuntime();
		// No servers in /tmp/project config — server not found
		const result = await executeAcpBuiltinSlashCommand("/mcp test bogus", runtime);
		expect(result).toEqual({ consumed: true });
		expect(output[0]).toContain("not found");
	});

	// /ssh add — spy on addSSHHost
	it("/ssh add foo --host x --user y --scope user: calls addSSHHost", async () => {
		const sshModule = await import("@oh-my-pi/pi-coding-agent/ssh/config-writer");
		const spy = spyOn(sshModule, "addSSHHost").mockResolvedValue(undefined);
		try {
			const { output, runtime } = createRuntime();
			const result = await executeAcpBuiltinSlashCommand("/ssh add foo --host x --user y --scope user", runtime);
			expect(result).toEqual({ consumed: true });
			expect(output[0]).toContain('Added SSH host "foo" (user).');
			// Without this assertion, the command could succeed via a side-effect-free
			// path that prints the success message without writing the host config.
			expect(spy).toHaveBeenCalledTimes(1);
			const [, name, hostConfig] = spy.mock.calls[0]!;
			expect(name).toBe("foo");
			expect(hostConfig).toMatchObject({ host: "x", username: "y" });
		} finally {
			spy.mockRestore();
		}
	});

	// /model with unknown id
	it("/model gpt-fake-9000: returns unknown-model message", async () => {
		const { output, runtime } = createRuntime();
		const result = await executeAcpBuiltinSlashCommand("/model gpt-fake-9000", runtime);
		expect(result).toEqual({ consumed: true });
		expect(output[0]).toContain("Unknown model");
	});

	// /model with known id (fake registry)
	it("/model known-id: reports model set and triggers notifyTitleChanged", async () => {
		const { output, session, runtime } = createRuntime();
		session.getAvailableModels = () => [{ provider: "anthropic", id: "claude-sonnet-test" }];
		let titleChanged = false;
		runtime.notifyTitleChanged = () => {
			titleChanged = true;
		};
		const result = await executeAcpBuiltinSlashCommand("/model claude-sonnet-test", runtime);
		expect(result).toEqual({ consumed: true });
		expect(output[0]).toContain("Model set to anthropic/claude-sonnet-test.");
		expect(titleChanged).toBe(true);
	});

	// /usage bar character
	it("/usage: includes bar character when usedFraction is 0.5", async () => {
		const { output, runtime } = createRuntime();
		runtime.session.fetchUsageReports = async () => [
			{
				provider: "test-provider",
				fetchedAt: Date.now(),
				limits: [
					{
						id: "test-limit",
						label: "Monthly",
						scope: { provider: "test-provider", tier: "pro", accountId: "acct-1" },
						window: { id: "monthly", label: "monthly", resetsAt: Date.now() + 30 * 86400_000 },
						amount: { used: 50, usedFraction: 0.5, unit: "requests" },
					},
				],
				metadata: {},
			},
		];
		const result = await executeAcpBuiltinSlashCommand("/usage", runtime);
		expect(result).toEqual({ consumed: true });
		expect(output[0]).toContain("█");
	});

	// /context breakdown
	it("/context: lists more than one breakdown line for session with messages", async () => {
		const { output, session, runtime } = createRuntime();
		// computeContextBreakdown needs model.contextWindow; fake session falls back gracefully
		(session as unknown as Record<string, unknown>).model = {
			provider: "anthropic",
			id: "claude-test",
			contextWindow: 200_000,
		};
		(session as unknown as Record<string, unknown>).skills = [];
		(session as unknown as Record<string, unknown>).agent = { state: { tools: [] }, tokenizer: new Tokenizer() };
		(session as unknown as Record<string, unknown>).systemPrompt = ["You are a helpful assistant."];
		session.messages = [
			{ role: "user", content: "Hello, how are you?" },
			{ role: "assistant", content: "I am doing well." },
		];
		const result = await executeAcpBuiltinSlashCommand("/context", runtime);
		expect(result).toEqual({ consumed: true });
		// Should show the breakdown with multiple lines (Messages category visible)
		const text = output[0] ?? "";
		expect(text).toContain("tokens");
		expect(text.split("\n").length).toBeGreaterThan(1);
	});

	// /jobs empty state
	it("/jobs: empty-state output mentions background jobs definition", async () => {
		const { output, runtime } = createRuntime();
		// Return empty snapshot (running=[], recent=[])
		runtime.session.getAsyncJobSnapshot = () => ({
			running: [],
			recent: [],
			delivery: { queued: 0, delivering: false, pendingJobIds: [] },
		});
		const result = await executeAcpBuiltinSlashCommand("/jobs", runtime);
		expect(result).toEqual({ consumed: true });
		expect(output[0]).toContain("background jobs");
	});

	// /marketplace discover bulleted list
	it("/marketplace discover: output is bulleted with '  - ' token", async () => {
		const { MarketplaceManager } = await import("@oh-my-pi/pi-coding-agent/extensibility/plugins/marketplace");
		const discoverSpy = spyOn(MarketplaceManager.prototype, "listAvailablePlugins").mockResolvedValue([
			{ name: "hello", version: "1.0.0", description: "A greeting plugin" } as never,
			{ name: "world", version: "2.0.0", description: undefined } as never,
		]);
		try {
			const { output, runtime } = createRuntime();
			const result = await executeAcpBuiltinSlashCommand("/marketplace discover", runtime);
			expect(result).toEqual({ consumed: true });
			expect(output[0]).toContain("  - ");
			expect(output[0]).toContain("hello@1.0.0");
		} finally {
			discoverSpy.mockRestore();
		}
	});
});

describe("/move preflight flush", () => {
	it("aborts text-mode /move when pending settings flush fails", async () => {
		const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-acp-move-"));
		try {
			const { output, fakeSessionManager, runtime } = createRuntime();
			spyOn(runtime.settings, "flush").mockRejectedValue(new Error("disk full"));

			const result = await executeAcpBuiltinSlashCommand(`/move ${targetDir}`, runtime);

			expect(result).toEqual({ consumed: true });
			expect(output[0]).toContain("disk full");
			expect(fakeSessionManager!._movedTo).toBeUndefined();
		} finally {
			await fs.rm(targetDir, { recursive: true, force: true });
		}
	});

	it("completes text-mode /move when flush succeeds", async () => {
		const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-acp-move-ok-"));
		const originalProjectDir = process.cwd();
		try {
			const { output, fakeSessionManager, runtime } = createRuntime();
			let flushed = false;
			spyOn(runtime.settings, "flush").mockImplementation(async () => {
				flushed = true;
			});

			const result = await executeAcpBuiltinSlashCommand(`/move ${targetDir}`, runtime);

			expect(result).toEqual({ consumed: true });
			expect(flushed).toBe(true);
			expect(fakeSessionManager!._movedTo).toBe(targetDir);
			expect(output[0]).toContain("Moved to");
		} finally {
			setProjectDir(originalProjectDir);
			await fs.rm(targetDir, { recursive: true, force: true });
		}
	});
});
