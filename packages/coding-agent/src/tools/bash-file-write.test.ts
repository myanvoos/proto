import { expect, test } from "bun:test";
import { findBashFileWrites } from "./bash-file-write";

test("extracts a plain truncate heredoc write", () => {
	expect(findBashFileWrites("cat > src/foo.ts <<'EOF'\nconst x: number = 1;\nEOF")).toEqual([
		{ path: "src/foo.ts", code: "const x: number = 1;", start: 25, end: 45 },
	]);
});

test("extracts an append heredoc write", () => {
	expect(findBashFileWrites("cat >> src/foo.ts <<EOF\nconst y = 2;\nEOF").map(write => write.code)).toEqual([
		"const y = 2;",
	]);
});

test("strips leading tabs for the tab-stripping heredoc form", () => {
	expect(
		findBashFileWrites("cat > src/foo.ts <<-EOF\n\tconst z = 3;\n\t\treturn z;\n\tEOF").map(write => write.code),
	).toEqual(["const z = 3;\nreturn z;"]);
});

test("retains quoted paths for the caller to normalize", () => {
	expect(
		findBashFileWrites("cat > 'src/quoted file.ts' <<EOF\nexport const value = 1;\nEOF").map(write => write.path),
	).toEqual(["'src/quoted file.ts'"]);
});

test("extracts cat with the redirect after the heredoc opener", () => {
	expect(
		findBashFileWrites("cat <<'EOF' > src/after.ts\nexport const after = true;\nEOF").map(write => write.code),
	).toEqual(["export const after = true;"]);
});

test("extracts tee append writes", () => {
	expect(findBashFileWrites("tee -a src/tee.ts <<'EOF'\nexport const tee = true;\nEOF")).toEqual([
		{ path: "src/tee.ts", code: "export const tee = true;", start: 26, end: 50 },
	]);
});

test("extracts multiple writes in source order", () => {
	const command = "cat > first.ts <<EOF\nfirst\nEOF\ntee -- second.ts <<EOF\nsecond\nEOF";
	expect(findBashFileWrites(command).map(write => [write.path, write.code])).toEqual([
		["first.ts", "first"],
		["second.ts", "second"],
	]);
});

test("does not report interpreter heredocs as file writes", () => {
	expect(findBashFileWrites("python <<'PY'\nprint('not a file write')\nPY")).toEqual([]);
	expect(findBashFileWrites("node <<'JS' > out.txt\nconsole.log(1)\nJS")).toEqual([]);
});

test("keeps an unterminated heredoc body through the end of the command", () => {
	expect(findBashFileWrites("cat > src/open.ts <<EOF\nexport const open = true;")).toEqual([
		{ path: "src/open.ts", code: "export const open = true;", start: 24, end: 49 },
	]);
});
