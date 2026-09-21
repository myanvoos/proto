import { describe, expect, test } from "bun:test";
import { splitShellCommands, stripShellWrapper } from "./bash-command-split";

describe("splitShellCommands", () => {
	test("splits on &&, ||, ;, | with separators recorded", () => {
		expect(splitShellCommands("a && b || c; d | e")).toEqual([
			{ raw: "a", separator: "" },
			{ raw: "b", separator: "&&" },
			{ raw: "c", separator: "||" },
			{ raw: "d", separator: ";" },
			{ raw: "e", separator: "|" },
		]);
	});

	test("does not split inside quotes", () => {
		expect(splitShellCommands(`echo "a && b" && echo 'c; d'`)).toEqual([
			{ raw: `echo "a && b"`, separator: "" },
			{ raw: `echo 'c; d'`, separator: "&&" },
		]);
	});

	test("does not split on fd duplication or &> redirect", () => {
		expect(splitShellCommands("make 2>&1 && cmd &> log")).toEqual([
			{ raw: "make 2>&1", separator: "" },
			{ raw: "cmd &> log", separator: "&&" },
		]);
	});

	test("splits on a lone & (background)", () => {
		expect(splitShellCommands("server & tail -f log")).toEqual([
			{ raw: "server", separator: "" },
			{ raw: "tail -f log", separator: "&" },
		]);
	});

	test("escaped separator stays in the segment", () => {
		expect(splitShellCommands("echo a\\;b && echo c")).toEqual([
			{ raw: "echo a\\;b", separator: "" },
			{ raw: "echo c", separator: "&&" },
		]);
	});

	test("newline separates script lines and blank lines do not reset the separator", () => {
		const segments = splitShellCommands("set -e\n\nnpm run build\nnpm test");
		expect(segments).toEqual([
			{ raw: "set -e", separator: "" },
			{ raw: "npm run build", separator: "\n" },
			{ raw: "npm test", separator: "\n" },
		]);
	});

	test("heredoc body stays attached to its segment and is not split", () => {
		const segments = splitShellCommands("cat > f <<'EOF'\nalpha && beta\nEOF\nnpm test");
		expect(segments).toEqual([
			{ raw: "cat > f <<'EOF'\nalpha && beta\nEOF", separator: "" },
			{ raw: "npm test", separator: "\n" },
		]);
	});

	test("<<- heredoc strips leading tabs when matching the delimiter", () => {
		const segments = splitShellCommands("cat <<-EOF\n\tbody | pipe\n\tEOF\ndone");
		expect(segments[0]).toEqual({ raw: "cat <<-EOF\n\tbody | pipe\n\tEOF", separator: "" });
		expect(segments).toHaveLength(2);
	});

	test("backslash continuation keeps one segment", () => {
		expect(splitShellCommands("echo one \\\n two && echo three")).toEqual([
			{ raw: "echo one \\\n two", separator: "" },
			{ raw: "echo three", separator: "&&" },
		]);
	});

	test("unwraps shell -c wrappers before splitting", () => {
		expect(splitShellCommands(`bash -lc "npm ci && npm test"`)).toEqual([
			{ raw: "npm ci", separator: "" },
			{ raw: "npm test", separator: "&&" },
		]);
	});

	test("single command yields one segment", () => {
		expect(splitShellCommands("rg -n foo src/")).toEqual([{ raw: "rg -n foo src/", separator: "" }]);
	});

	test("empty and whitespace-only input yield no segments", () => {
		expect(splitShellCommands("")).toEqual([]);
		expect(splitShellCommands("   \n  ")).toEqual([]);
	});
});

describe("stripShellWrapper", () => {
	test("unwraps bash -lc and sh -c with quotes", () => {
		expect(stripShellWrapper(`bash -lc "cd /tmp && ls"`)).toBe("cd /tmp && ls");
		expect(stripShellWrapper(`sh -c 'echo hi'`)).toBe("echo hi");
	});

	test("leaves plain commands untouched", () => {
		expect(stripShellWrapper("  git status  ")).toBe("git status");
	});
});
