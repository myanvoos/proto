import type { TUI } from "@oh-my-pi/pi-tui";
import { AgentRegistry } from "./packages/coding-agent/src/registry/agent-registry";
import { initThemeSync } from "./packages/coding-agent/src/modes/theme/theme";
import { AgentsViewComponent, type AgentsViewDeps } from "./packages/coding-agent/src/modes/components/agents-view/agents-view-mode";

initThemeSync();
const deps = (hideSubagents: boolean): AgentsViewDeps => ({
	ui: { terminal: { rows: 50 } } as unknown as TUI,
	keybindings: { getKeys: () => [] },
	currentSessionFile: null, cwd: process.cwd(), version: "bench", modelName: "m", providerName: "p",
	requestRender: () => {}, close: () => {}, openSession: async () => true, focusAgent: async () => {}, newSession: () => {},
	renameCurrentSession: async () => {}, deleteCurrentSession: async () => {}, promptAfterResume: async () => {},
	showError: () => {}, showStatus: () => {}, registry: AgentRegistry.global(), hideSubagents,
});
async function stalls(label: string, ms: number) {
	let maxGap = 0, total = 0, last = performance.now();
	const iv = setInterval(() => { const n = performance.now(); const g = n - last - 1; if (g > 5) total += g; maxGap = Math.max(maxGap, g); last = n; }, 1);
	await Bun.sleep(ms);
	clearInterval(iv);
	console.log(`${label}: max stall ${maxGap.toFixed(1)}ms, total stall>5ms ${total.toFixed(0)}ms over ${ms}ms`);
}
const view = new AgentsViewComponent(deps(true));
await stalls("global: first 2s (mount+seed)", 2000);
await stalls("global: 2-6s", 4000);
await stalls("global: steady 6-12s", 6000);
console.log("registry refs:", AgentRegistry.global().list().length);
view.dispose();
process.exit(0);
