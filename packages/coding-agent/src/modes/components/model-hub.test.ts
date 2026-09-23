import { beforeEach, expect, test, vi } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { type TUI, visibleWidth } from "@oh-my-pi/pi-tui";
import type { ModelRegistry } from "../../config/model-registry";
import { Settings } from "../../config/settings";
import { initThemeSync, theme } from "../theme/theme";
import { ModelHubComponent, resetProviderAutoRefreshGuard } from "./model-hub";
import { ModelPickerComponent } from "./model-picker";

beforeEach(() => initThemeSync());
const models = Array.from({ length: 20 }, (_, index) =>
	buildModel({
		id: `model-${String(index).padStart(2, "0")}`,
		name: `Model ${index}`,
		provider: "offline-provider",
		api: "openai-completions",
		baseUrl: "http://127.0.0.1:9",
		contextWindow: 128_000,
		maxTokens: 4096,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	} as never),
);
const scoped = models.map(model => ({ model }));
const registry = {} as ModelRegistry; // Scoped models never access the registry or network.
const plain = (lines: string[]) => lines.map(line => Bun.stripANSI(line));
const mouse = (col: number, row: number) => `\x1b[<0;${col + 1};${row + 1}M`;
function setup(rows = 24) {
	const terminal = { rows };
	const tui = { terminal, requestRender() {} } as unknown as TUI;
	const assignments: string[] = [];
	const hub = new ModelHubComponent(tui, Settings.isolated(), registry, scoped, {
		onAssign: model => {
			assignments.push(model.id);
		},
		onUnassign() {},
		onCancel() {},
	});
	return { hub, terminal, tui, assignments };
}
for (const width of [20, 32, 40, 60, 80]) {
	test(`model hub exposes the focused model at ${width} columns`, () => {
		const { hub } = setup();
		try {
			hub.render(width);
			hub.handleInput("\x1b[C");
			let lines = hub.render(width);
			expect(lines.every(line => visibleWidth(line) <= width)).toBe(true);
			expect(plain(lines).some(line => line.includes(theme.nav.cursor) && line.includes("model-19"))).toBe(true);
			hub.handleInput("\x1b[B");
			lines = hub.render(width);
			expect(plain(lines).some(line => line.includes(theme.nav.cursor) && line.includes("model-18"))).toBe(true);
			hub.handleInput("\r");
			expect(plain(hub.render(width)).some(line => line.includes("["))).toBe(true);
		} finally {
			hub.dispose();
		}
	});
}
for (const rows of [1, 2, 3, 4, 6, 8, 12, 24]) {
	test(`model hub keeps selection through resize to ${rows} rows`, () => {
		const { hub, terminal } = setup();
		try {
			hub.render(32);
			hub.handleInput("\x1b[C");
			for (let i = 0; i < 15; i++) hub.handleInput("\x1b[B");
			terminal.rows = rows;
			const lines = hub.render(32);
			expect(lines.length).toBeLessThanOrEqual(rows);
			expect(plain(lines).some(line => line.startsWith(theme.boxRound.vertical))).toBe(rows >= 3);
			expect(plain(lines).some(line => line.includes(`${theme.nav.cursor} model-04`))).toBe(true);
		} finally {
			hub.dispose();
		}
	});
}
test("compact Enter opens scope before activating; mouse targets rendered models and chips", () => {
	const { hub, assignments } = setup();
	try {
		hub.render(32);
		hub.handleInput("\r");
		let lines = plain(hub.render(32));
		expect(lines.some(line => line.includes(theme.nav.cursor) && line.includes("model-19"))).toBe(true);
		expect(lines.some(line => line.includes("["))).toBe(false);
		const second = lines.findIndex(line => line.includes("model-18"));
		hub.handleInput(mouse(5, second));
		lines = plain(hub.render(32));
		expect(lines[second]).toContain(`${theme.nav.cursor} model-18`);
		hub.handleInput(mouse(5, second));
		lines = plain(hub.render(32));
		const footer = lines.findIndex(line => line.includes("["));
		expect(footer).toBeGreaterThan(0);
		hub.handleInput(mouse(5, footer));
		hub.render(32);
		expect(assignments).toEqual(["model-18"]);
	} finally {
		hub.dispose();
	}
});
test("compact mouse scope navigation and back header use displayed coordinates", () => {
	const { hub } = setup();
	try {
		let lines = plain(hub.render(32));
		const provider = lines.findIndex(line => line.includes("offline-provider"));
		hub.handleInput(mouse(5, provider));
		lines = plain(hub.render(32));
		expect(lines.some(line => line.includes(theme.nav.cursor) && line.includes("model-19"))).toBe(true);
		hub.handleInput(mouse(4, 0));
		expect(plain(hub.render(32)).some(line => line.includes("Enter open"))).toBe(true);
	} finally {
		hub.dispose();
	}
});
for (const rows of [1, 2, 3, 4, 6, 12]) {
	test(`session model picker keeps current model visible at ${rows} rows`, () => {
		const { hub, tui } = setup(rows);
		hub.dispose();
		const picks: string[] = [];
		const picker = new ModelPickerComponent(
			tui,
			Settings.isolated(),
			registry,
			scoped,
			{ onPick: model => picks.push(model.id), onCancel() {} },
			{ currentSelector: "offline-provider/model-15" },
		);
		const lines = picker.render(32);
		expect(lines.length).toBeLessThanOrEqual(rows);
		expect(plain(lines).some(line => line.startsWith(theme.boxRound.vertical))).toBe(rows >= 3);
		expect(plain(lines).some(line => line.includes(`${theme.nav.cursor} model-15`))).toBe(true);
		const selected = plain(lines).findIndex(line => line.includes(`${theme.nav.cursor} model-15`));
		picker.handleInput(mouse(5, selected));
		expect(picks).toEqual(["model-15"]);
	});
}

for (const rows of [4, 6]) {
	test(`compact roles retain the focused actionable role at ${rows} rows`, () => {
		const { hub } = setup(rows);
		try {
			hub.render(32);
			hub.handleInput("\x1b[A");
			hub.handleInput("\x1b[C");
			let lines = plain(hub.render(32));
			expect(lines.length).toBeLessThanOrEqual(rows);
			expect(plain(lines).some(line => line.startsWith(theme.boxRound.vertical))).toBe(rows >= 3);
			expect(lines.some(line => line.includes(theme.nav.cursor) && line.includes("DEFAULT"))).toBe(true);
			hub.handleInput("\r");
			hub.render(32);
			hub.handleInput("\x1b[C");
			lines = plain(hub.render(32));
			expect(lines.some(line => line.includes(theme.nav.cursor) && line.includes("model-"))).toBe(true);
		} finally {
			hub.dispose();
		}
	});
}

test("twenty-column model identification and selected role chip stay readable", () => {
	const model = buildModel({ ...models[0], id: "discovery-alpha", name: "Discovery Alpha" } as never);
	const terminal = { rows: 24 };
	const hub = new ModelHubComponent(
		{ terminal, requestRender() {} } as unknown as TUI,
		Settings.isolated(),
		registry,
		[{ model }],
		{ onAssign() {}, onUnassign() {}, onCancel() {} },
	);
	try {
		hub.render(20);
		hub.handleInput("\x1b[C");
		let lines = plain(hub.render(20));
		expect(lines.some(line => line.includes("discovery-alpha"))).toBe(true);
		expect(lines.some(line => line.includes("Enter · ← back"))).toBe(true);
		hub.handleInput("\r");
		lines = plain(hub.render(20));
		expect(lines.some(line => line.includes("[default]"))).toBe(true);
		hub.handleInput("\x1b[C");
		lines = plain(hub.render(20));
		expect(lines.some(line => line.includes("[smol]"))).toBe(true);
		expect(lines.every(line => visibleWidth(line) <= 20)).toBe(true);
	} finally {
		hub.dispose();
	}
});

function setupRegistryHub(refreshProvider: ModelRegistry["refreshProvider"]) {
	resetProviderAutoRefreshGuard();
	const catalog = ["prov-a", "prov-b"].map(provider => buildModel({ ...models[0], provider } as never));
	const liveRegistry = {
		refresh: async () => {},
		refreshProvider,
		getError: () => undefined,
		getAll: () => catalog,
		getAvailable: () => catalog,
		getDiscoverableProviders: () => [],
		getProviderDiscoveryState: () => undefined,
		authStorage: { hasAuth: () => false },
	} as unknown as ModelRegistry;
	return new ModelHubComponent(
		{ terminal: { rows: 24 }, requestRender() {} } as unknown as TUI,
		Settings.isolated(),
		liveRegistry,
		[],
		{ onAssign() {}, onUnassign() {}, onCancel() {} },
	);
}
const F5 = "\x1b[15~";

test("F5 during the provider hover debounce upgrades the queued fetch to a credential refresh", async () => {
	const refreshProvider = vi.fn<ModelRegistry["refreshProvider"]>(async () => {});
	const hub = setupRegistryHub(refreshProvider);
	try {
		hub.handleInput("\x1b[B"); // All models -> prov-a queues a catalog-only fetch
		hub.handleInput(F5);
		await Bun.sleep(160);
		expect(refreshProvider.mock.calls).toEqual([["prov-a", "online", { refreshCommandCredentials: true }]]);
	} finally {
		hub.dispose();
	}
});

test("F5 behind an in-flight catalog fetch re-mints credentials even after leaving the provider", async () => {
	const gate = Promise.withResolvers<void>();
	const refreshProvider = vi.fn<ModelRegistry["refreshProvider"]>(() => gate.promise);
	const hub = setupRegistryHub(refreshProvider);
	try {
		hub.handleInput("\x1b[B");
		await Bun.sleep(160);
		expect(refreshProvider.mock.calls).toEqual([["prov-a", "online", undefined]]);
		hub.handleInput(F5);
		hub.handleInput("\x1b[A"); // back to All models
		expect(refreshProvider).toHaveBeenCalledTimes(1);
		gate.resolve();
		await Bun.sleep(0);
		expect(refreshProvider).toHaveBeenCalledTimes(2);
		expect(refreshProvider).toHaveBeenLastCalledWith("prov-a", "online", { refreshCommandCredentials: true });
	} finally {
		hub.dispose();
	}
});

test("t on a fallback-chain row pins that entry's thinking level and inherit restores the bare selector", () => {
	const reasoning = buildModel({
		...models[0],
		id: "model-r",
		provider: "prov-a",
		reasoning: true,
		thinking: { mode: "effort", efforts: ["low", "medium", "high"] },
	} as never);
	const settings = Settings.isolated({ "retry.fallbackChains": { default: ["PROV-A/Model-R@edge"] } });
	const chainChanges: string[][] = [];
	const hub = new ModelHubComponent(
		{ terminal: { rows: 24 }, requestRender() {} } as unknown as TUI,
		settings,
		{
			refresh: async () => {},
			refreshProvider: async () => {},
			getError: () => undefined,
			getAll: () => [reasoning],
			getAvailable: () => [reasoning],
			find: (provider: string, id: string) =>
				provider.toLowerCase() === "prov-a" && id.toLowerCase() === "model-r" ? reasoning : undefined,
			getDiscoverableProviders: () => [],
			getProviderDiscoveryState: () => undefined,
			authStorage: { hasAuth: () => false },
		} as unknown as ModelRegistry,
		[],
		{
			onAssign() {},
			onUnassign() {},
			onCancel() {},
			onFallbackChainChange: (role, chain) => {
				chainChanges.push(chain);
				settings.override("retry.fallbackChains", { [role]: chain });
			},
		},
	);
	try {
		hub.handleInput("\x1b[A"); // All models -> Roles
		hub.handleInput("\x1b[C"); // focus the roles list
		hub.handleInput("\x1b[B"); // default role -> its first fallback row
		expect(plain(hub.render(80)).join("\n")).toContain("t thinking");
		hub.handleInput("t");
		hub.handleInput("\x1b[C"); // Inherit -> Off
		hub.handleInput("\x1b[C"); // Off -> low
		hub.handleInput("\r");
		expect(chainChanges.at(-1)).toEqual(["prov-a/model-r@edge:low"]);

		hub.handleInput("t"); // reopens preselected on low
		hub.handleInput("\x1b[D");
		hub.handleInput("\x1b[D"); // back to Inherit
		hub.handleInput("\r");
		expect(chainChanges.at(-1)).toEqual(["prov-a/model-r@edge"]);
	} finally {
		hub.dispose();
	}
});
function reasoningHub(onAssign: () => void | boolean | Promise<void | boolean>) {
	const model = buildModel({
		...models[0],
		id: "model-r",
		provider: "prov-a",
		reasoning: true,
		thinking: { mode: "effort", efforts: ["low", "medium", "high"] },
	} as never);
	const hub = new ModelHubComponent(
		{ terminal: { rows: 24 }, requestRender() {} } as unknown as TUI,
		Settings.isolated(),
		registry,
		[{ model }],
		{ onAssign, onUnassign() {}, onCancel() {} },
	);
	const footer = () => plain(hub.render(100)).at(-2) ?? "";
	return { hub, footer };
}
test("an async role assignment holds input until it settles and confirming the preselected level does not reapply it", async () => {
	const assignment = Promise.withResolvers<boolean>();
	const onAssign = vi.fn(() => assignment.promise);
	const { hub, footer } = reasoningHub(onAssign);
	try {
		hub.handleInput("\r"); // Open the role strip.
		hub.handleInput("\r"); // Assign default.
		expect(plain(hub.render(100)).join("\n")).toContain("Applying model…");
		hub.handleInput("\r"); // Ignored while the assignment persists.
		expect(onAssign).toHaveBeenCalledTimes(1);

		assignment.resolve(true);
		await assignment.promise;
		await Promise.resolve();
		expect(footer()).toContain("[ inherit ]");
		hub.handleInput("\r"); // Confirm the committed level.
		expect(onAssign).toHaveBeenCalledTimes(1);
	} finally {
		hub.dispose();
	}
});
test("a rejected async role assignment does not open the thinking strip", async () => {
	const assignment = Promise.withResolvers<boolean>();
	const { hub, footer } = reasoningHub(() => assignment.promise);
	try {
		hub.handleInput("\r");
		hub.handleInput("\r");
		assignment.resolve(false);
		await assignment.promise;
		await Promise.resolve();
		expect(footer()).not.toContain("inherit");
		expect(plain(hub.render(100)).join("\n")).not.toContain("Applying model…");
	} finally {
		hub.dispose();
	}
});
test("a focused provider that vanishes on its refresh hands focus to its neighbour instead of the top", async () => {
	resetProviderAutoRefreshGuard();
	const catalog = ["alpha", "beta", "gamma"].map(provider => buildModel({ ...models[0], provider } as never));
	// Keyless local endpoint: visible while discovery reports "empty", hidden once its on-focus refresh finds it
	// unreachable.
	let localStatus = "empty";
	const hub = new ModelHubComponent(
		{ terminal: { rows: 24 }, requestRender() {} } as unknown as TUI,
		Settings.isolated(),
		{
			refresh: async () => {},
			refreshProvider: async (providerId: string) => {
				if (providerId === "delta-local") localStatus = "unavailable";
			},
			getError: () => undefined,
			getAll: () => catalog,
			getAvailable: () => catalog,
			getDiscoverableProviders: () => ["delta-local"],
			getProviderDiscoveryState: (providerId: string) =>
				providerId === "delta-local" ? { optional: true, status: localStatus } : undefined,
			authStorage: { hasAuth: () => false },
		} as unknown as ModelRegistry,
		[],
		{ onAssign() {}, onUnassign() {}, onCancel() {} },
	);
	try {
		for (let i = 0; i < 3; i++) hub.handleInput("\x1b[B"); // All models -> alpha -> beta -> delta-local
		const focusedLine = () => plain(hub.render(100)).find(line => line.includes(theme.nav.cursor)) ?? "";
		expect(focusedLine()).toContain("delta-local");
		await Bun.sleep(160);
		expect(focusedLine()).toContain("gamma");
	} finally {
		hub.dispose();
	}
});
