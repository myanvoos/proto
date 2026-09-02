import { expect, test } from "bun:test";
import { initTheme, theme } from "../modes/theme/theme";
import { toolRenderers } from "./renderers";

await initTheme(false, false, "dark-hybrid-slate-cool");

const bash = toolRenderers.bash as never as {
	renderCall: (a: unknown, o: unknown, t: unknown) => { render: (w: number) => string[] };
};
const render = (command: string, expanded: boolean) =>
	bash.renderCall({ command }, { expanded }, theme).render(100).join("\n");

test("collapsed python heredoc renders the AST outline; expanded shows raw", () => {
	const command =
		"python <<'EOF'\ndef greet(name):\n    return name\n\nclass Widget:\n    def run(self):\n        return 1\nEOF";
	const collapsed = render(command, false);
	expect(collapsed).toContain("Module");
	expect(collapsed).toContain("greet(name)");
	expect(collapsed).toContain("Widget");
	expect(render(command, true)).toContain("class Widget:");
});
test("node heredoc and python -c are previewed; plain shell is not", () => {
	expect(render("node <<'JS'\nfunction f(){ return 1 }\nJS", false)).toContain("f");
	expect(render('python -c \'edit("a","b","c")\'', false)).toContain("edit");
	expect(render("rg -n foo src", false)).toContain("rg");
});
