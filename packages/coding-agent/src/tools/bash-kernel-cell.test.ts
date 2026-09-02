import { expect, test } from "bun:test";
import { detectBashKernelCell } from "./bash-kernel-cell";

test("quoted heredoc python", () => {
	const c = detectBashKernelCell("python <<'EOF'\nedit('a.py','x','y')\nprint('ok')\nEOF");
	expect(c?.language).toBe("python");
	expect(c?.code).toBe("edit('a.py','x','y')\nprint('ok')");
});
test("python3 - heredoc with cd prefix", () => {
	const c = detectBashKernelCell("cd sub && python3 - <<EOF\nx = 1\nEOF");
	expect(c).toEqual({ language: "python", code: "x = 1", header: "cd sub && python3 - <<EOF" });
});
test("node heredoc", () => {
	expect(detectBashKernelCell("node <<'JS'\nconsole.log(1)\nJS")?.code).toBe("console.log(1)");
});
test("python -c single quoted, node -e double quoted", () => {
	expect(detectBashKernelCell('python -c \'edit("a","b","c")\'')?.code).toBe('edit("a","b","c")');
	expect(detectBashKernelCell('node -e "console.log(1)"')?.code).toBe("console.log(1)");
});
test("real-interpreter invocations are not cells", () => {
	expect(detectBashKernelCell("python foo.py")).toBeUndefined();
	expect(detectBashKernelCell("python3 foo.py <<EOF\nx\nEOF")).toBeUndefined();
	expect(detectBashKernelCell("python -c 'print(1)' extra")).toBeUndefined();
	expect(detectBashKernelCell("python -m http.server")).toBeUndefined();
	expect(detectBashKernelCell("python -e 'x'")).toBeUndefined();
	expect(detectBashKernelCell("node -c 'x'")).toBeUndefined();
});
test("plain shell is not a cell", () => {
	expect(detectBashKernelCell("rg -n foo src")).toBeUndefined();
	expect(detectBashKernelCell("sed -i 's/a/b/' f.py")).toBeUndefined();
});
test("<<- strips leading tabs on terminator", () => {
	expect(detectBashKernelCell("\tpython <<-EOF\n\ty = 2\n\tEOF")?.language).toBe("python");
});
