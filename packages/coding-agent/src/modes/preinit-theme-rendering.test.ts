import { describe, expect, it } from "bun:test";

const CHILD_ENV = {
	...Bun.env,
	KITTY_WINDOW_ID: "",
	GHOSTTY_RESOURCES_DIR: "",
	WEZTERM_PANE: "",
	ITERM_SESSION_ID: "",
	VSCODE_PID: "",
	ALACRITTY_WINDOW_ID: "",
	TERM_PROGRAM: "Apple_Terminal",
	TERM: "xterm-256color",
	COLORTERM: "",
	WT_SESSION: "",
};

async function expectFreshModuleRender(script: string): Promise<void> {
	const proc = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe", env: CHILD_ENV });
	const [code, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	expect(stderr).toBe("");
	expect(code).toBe(0);
	expect(stdout).toBe("ok");
}

// `bun test` shares one module registry across files, so a sibling's theme initialization hides
// pre-init failures. Each case renders in a fresh process, like an extension loading its own
// module graph before initTheme runs.
describe("rendering before theme initialization", () => {
	it("paints a magic-keyword gradient within the detected terminal color depth", async () => {
		const entry = new URL("./magic-keywords.ts", import.meta.url).pathname;
		await expectFreshModuleRender(`
			import { highlightMagicKeywords } from ${JSON.stringify(entry)};
			const text = "please ultrathink about this";
			const out = highlightMagicKeywords(text, undefined, 0);
			if (out.replaceAll(/\\x1b\\[[0-9;]*m/g, "") !== text) throw new Error("visible-text-changed");
			if (!out.includes("\\x1b[38;5;")) throw new Error("no-256-color-gradient");
			if (out.includes("\\x1b[38;2;")) throw new Error("unsupported-truecolor-gradient");
			process.stdout.write("ok");
		`);
	});

	it("constructs and renders a tool card", async () => {
		const entry = new URL("./components/tool-execution.ts", import.meta.url).pathname;
		await expectFreshModuleRender(`
			import { ToolExecutionComponent } from ${JSON.stringify(entry)};
			const ui = { requestRender() {}, requestComponentRender() {} };
			const component = new ToolExecutionComponent("bash", { command: "echo hi" }, {}, undefined, ui);
			const out = Bun.stripANSI(component.render(80).join("\\n"));
			if (!out.includes("echo hi")) throw new Error("tool-output-missing");
			process.stdout.write("ok");
		`);
	});

	it("constructs and renders assistant Markdown", async () => {
		const entry = new URL("./components/assistant-message.ts", import.meta.url).pathname;
		await expectFreshModuleRender(`
			import { AssistantMessageComponent } from ${JSON.stringify(entry)};
			const message = {
				role: "assistant",
				content: [{ type: "text", text: "hello" }],
				api: "openai-completions",
				provider: "test",
				model: "test",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "stop",
				timestamp: Date.now(),
			};
			const out = Bun.stripANSI(new AssistantMessageComponent(message).render(80).join("\\n"));
			if (!out.includes("hello")) throw new Error("assistant-output-missing");
			process.stdout.write("ok");
		`);
	});

	it("constructs and renders a user message", async () => {
		const entry = new URL("./components/user-message.ts", import.meta.url).pathname;
		await expectFreshModuleRender(`
			import { UserMessageComponent } from ${JSON.stringify(entry)};
			const out = Bun.stripANSI(new UserMessageComponent("hello").render(80).join("\\n"));
			if (!out.includes("hello")) throw new Error("user-output-missing");
			process.stdout.write("ok");
		`);
	});
});
