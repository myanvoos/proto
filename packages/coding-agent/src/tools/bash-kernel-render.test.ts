import { expect, test } from "bun:test";
import { initTheme, theme } from "../modes/theme/theme";
import { toolRenderers } from "./renderers";

await initTheme(false, false, "dark-hybrid-slate-cool");

const bash = toolRenderers.bash as never as {
	renderCall: (a: unknown, o: unknown, t: unknown) => { render: (w: number) => string[] };
};
const strip = (x: string) => x.replace(/\x1b\[[0-9;]*m/g, "");
const renderCall = (command: string) =>
	strip(bash.renderCall({ command }, { expanded: false }, theme).render(100).join("\n"));

// renderCall is the live/pending phase; a kernel cell renders the eval-style
// running header + AST outline (raw code and settled output belong to
// renderResult, covered by the eval-parity comparison test).
test("kernel-cell bash render shows the eval-style running cell with AST outline", () => {
	const py = renderCall("python <<'EOF'\ndef greet(name):\n    return name\n\nclass Widget:\n    pass\nEOF");
	expect(py).toContain("· ast"); // eval-style header meta
	expect(py).toContain("Module");
	expect(py).toContain("greet(name)");
	expect(py).toContain("Widget");
	expect(renderCall("node <<'JS'\nfunction f(){ return 1 }\nJS")).toContain("f");
	expect(renderCall('python -c \'edit("a","b","c")\'')).toContain("edit");
});

test("plain shell commands keep the normal $ command rendering (no AST)", () => {
	const plain = renderCall("rg -n foo src");
	expect(plain).toContain("rg");
	expect(plain).toContain("foo");
	expect(plain).not.toContain("· ast");
	expect(plain).not.toContain("Module");
});
