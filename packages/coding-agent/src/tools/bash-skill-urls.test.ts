import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Skill } from "../extensibility/skills";
import { InternalUrlRouter } from "../internal-urls/router";
import { expandInternalUrls } from "./bash-skill-urls";

// Scheme URLs are assembled at runtime: this source must not contain
// expandable literals, or the agent's own bash tool rewrites them.
const PLAN_URL = "fleet" + "://plan.py";
const X_URL = "fleet" + "://x.py";
const MID_URL = "fleet" + "://mid.txt";
const TAIL_URL = "fleet" + "://tail.txt";
const INPUT_URL = "fleet" + "://input.txt";

function optionsWith(artifactsDir: string) {
	return { skills: [], localOptions: { getArtifactsDir: () => artifactsDir } };
}

const skill: Skill = {
	name: "greet",
	description: "greets",
	filePath: "/skills/greet/SKILL.md",
	baseDir: "/skills/greet",
	source: "builtin",
};

test("scheme URLs inside quoted heredoc bodies are preserved; command-position URLs expand", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "skill-urls-"));
	try {
		const command = [`cat > ${PLAN_URL} <<'EOF'`, `u = "${PLAN_URL}"`, "print(u)", "EOF", `python ${PLAN_URL}`].join(
			"\n",
		);
		const expanded = await expandInternalUrls(command, optionsWith(path.join(dir, "artifacts")));
		const lines = expanded.split("\n");
		// Redirect target (command position) expands; body content does not.
		expect(lines[0]).toContain(path.join(dir, "artifacts", "fleet", "plan.py"));
		expect(lines[1]).toBe(`u = "${PLAN_URL}"`);
		expect(lines[4]).toContain(path.join(dir, "artifacts", "fleet", "plan.py"));
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("kernel cell bodies keep literal URI data unchanged", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "skill-urls-"));
	try {
		const command = ["python <<'PYEOF'", `url = "${X_URL}"`, "print(url)", "PYEOF"].join("\n");
		const expanded = await expandInternalUrls(command, optionsWith(path.join(dir, "artifacts")));
		expect(expanded).toBe(command);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("unquoted delimiters and <<- tab terminators are scoped as heredoc bodies", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "skill-urls-"));
	try {
		const artifacts = path.join(dir, "artifacts");
		const command = [
			"cat <<EOF > " + "fleet" + "://a.txt",
			"body " + "fleet" + "://not-expanded",
			"EOF",
			"cat <<-B > " + "fleet" + "://b.txt",
			"\tbody " + "fleet" + "://not-expanded-either",
			"\tB",
			"echo done",
		].join("\n");
		const expanded = await expandInternalUrls(command, optionsWith(artifacts));
		const lines = expanded.split("\n");
		expect(lines[0]).toContain(path.join(artifacts, "fleet", "a.txt"));
		expect(lines[1]).toBe("body " + "fleet" + "://not-expanded");
		expect(lines[3]).toContain(path.join(artifacts, "fleet", "b.txt"));
		expect(lines[4]).toBe("\tbody " + "fleet" + "://not-expanded-either");
		expect(lines[6]).toBe("echo done");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("shell-quoted command URLs expand while embedded quoted text stays literal", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "skill-urls-"));
	try {
		const artifacts = path.join(dir, "artifacts");
		const singleQuoted = await expandInternalUrls(`cat '${MID_URL}'`, optionsWith(artifacts));
		const doubleQuoted = await expandInternalUrls(`cat "${TAIL_URL}"`, optionsWith(artifacts));
		const standalone = await expandInternalUrls(`"${MID_URL}"`, optionsWith(artifacts));
		const embedded = `printf "%s" "prefix ${INPUT_URL}"`;
		const embeddedExpanded = await expandInternalUrls(embedded, optionsWith(artifacts));
		expect(singleQuoted).toContain(path.join(artifacts, "fleet", "mid.txt"));
		expect(doubleQuoted).toContain(path.join(artifacts, "fleet", "tail.txt"));
		expect(standalone).toContain(path.join(artifacts, "fleet", "mid.txt"));
		expect(embeddedExpanded).toBe(embedded);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("here-strings keep expanding: the word after <<< is command syntax, not body", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "skill-urls-"));
	try {
		const command = `grep pattern <<< ${INPUT_URL}`;
		const expanded = await expandInternalUrls(command, optionsWith(path.join(dir, "artifacts")));
		expect(expanded).toContain(path.join(dir, "artifacts", "fleet", "input.txt"));
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("multiple heredocs each keep their bodies while surrounding commands expand", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "skill-urls-"));
	try {
		const command = [
			"python <<'A'",
			"x = '" + "fleet" + "://first'",
			"A",
			`cat ${MID_URL}`,
			"node <<'B'",
			"const y = '" + "fleet" + "://second'",
			"B",
		].join("\n");
		const expanded = await expandInternalUrls(command, optionsWith(path.join(dir, "artifacts")));
		const lines = expanded.split("\n");
		expect(lines[1]).toBe("x = '" + "fleet" + "://first'");
		expect(lines[3]).toContain(path.join(dir, "artifacts", "fleet", "mid.txt"));
		expect(lines[5]).toBe("const y = '" + "fleet" + "://second'");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("skill URLs in heredoc bodies are preserved", async () => {
	const greetUrl = "skill" + "://greet";
	const command = ["cat > /tmp/skill-script <<'EOF'", `const url = "${greetUrl}"`, "EOF", greetUrl].join("\n");
	const expanded = await expandInternalUrls(command, { skills: [skill] });
	const lines = expanded.split("\n");
	expect(lines[1]).toBe(`const url = "${greetUrl}"`);
	expect(lines[3]).toContain("/skills/greet");
});

test("contained skills fail closed for bare and nested URLs that leave the plugin root", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "skill-urls-contain-"));
	try {
		const root = path.join(dir, "plugin");
		const outside = path.join(dir, "outside");
		await fs.mkdir(root);
		await fs.mkdir(outside);
		await fs.writeFile(path.join(outside, "SKILL.md"), "outside");
		await fs.symlink(outside, path.join(root, "escaped"));
		const escaped: Skill = {
			name: "escaped",
			description: "escapes its root",
			filePath: path.join(root, "escaped", "SKILL.md"),
			baseDir: path.join(root, "escaped"),
			source: "test",
			containRoot: root,
		};
		const url = "skill" + "://escaped";
		await expect(expandInternalUrls(`ls ${url}`, { skills: [escaped] })).rejects.toThrow("outside the plugin root");
		await expect(expandInternalUrls(`cat ${url}/SKILL.md`, { skills: [escaped] })).rejects.toThrow(
			"outside the plugin root",
		);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

describe("expansion stays scoped", () => {
	test("a heredoc whose delimiter never terminates swallows the rest of the command", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "skill-urls-"));
		try {
			const command = ["cat <<'UNTERMINATED'", "body " + "fleet" + "://still-data"].join("\n");
			const expanded = await expandInternalUrls(command, optionsWith(path.join(dir, "artifacts")));
			expect(expanded).toBe(command);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	test("quotes in a body do not desynchronize later command-line quoting", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "skill-urls-"));
		try {
			const command = [
				"cat <<'EOF'",
				"body with 'unbalanced quote and " + "fleet" + "://data-url",
				"EOF",
				`echo "tail" ${TAIL_URL}`,
			].join("\n");
			const expanded = await expandInternalUrls(command, optionsWith(path.join(dir, "artifacts")));
			const lines = expanded.split("\n");
			expect(lines[1]).toBe("body with 'unbalanced quote and " + "fleet" + "://data-url");
			expect(lines[3]).toContain(path.join(dir, "artifacts", "fleet", "tail.txt"));
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});

test("recognized internal arguments never silently fall through as local filenames", async () => {
	await expect(expandInternalUrls("cat skill://missing/file", { skills: [] })).rejects.toThrow("Unknown skill");
	await expect(expandInternalUrls("cat history://", { skills: [] })).rejects.toThrow("Use read");
	await expect(
		expandInternalUrls("cat custom://view", {
			skills: [],
			internalRouter: {
				canHandle: () => true,
				resolve: async url => ({ url, content: "generated", contentType: "text/plain" }),
			},
		}),
	).rejects.toThrow("without a filesystem path");
});

test("custom internal schemes rewrite real paths and preserve external URLs", async () => {
	const result = await expandInternalUrls("cat custom://file; curl https://example.com", {
		skills: [],
		internalRouter: {
			canHandle: () => true,
			resolve: async url => ({ url, content: "", contentType: "text/plain", sourcePath: "/tmp/a file" }),
		},
	});
	expect(result).toBe("cat '/tmp/a file'; curl https://example.com");
});

test("URLs of schemes the harness does not own reach the command as typed", async () => {
	// Cloud CLIs, database clients, and git take their own scheme URLs; ssh:// is
	// also a router scheme (read-only remote text) but must not hijack git/rsync.
	const command = [
		'aws s3 sync s3://bucket/ramd/ /tmp/out --exclude "*" --include "*outcome.json"',
		"psql postgres://user@db.invalid:5432/app",
		"git clone ssh://git@example.invalid/org/repo.git",
	].join("\n");
	const result = await expandInternalUrls(command, { skills: [], internalRouter: new InternalUrlRouter() });
	expect(result).toBe(command);
});
