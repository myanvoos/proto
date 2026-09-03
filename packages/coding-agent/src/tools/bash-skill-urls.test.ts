import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Skill } from "../extensibility/skills";
import { expandInternalUrls, expandSkillUrls } from "./bash-skill-urls";

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
		const command = [
			"cat > " + PLAN_URL + " <<'EOF'",
			`u = "${PLAN_URL}"`,
			"print(u)",
			"EOF",
			"python " + PLAN_URL,
		].join("\n");
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

test("kernel cell bodies referencing proto_path keep their scheme URLs", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "skill-urls-"));
	try {
		const command = ["python <<'PYEOF'", `p = proto_path("${X_URL}")`, "print(p)", "PYEOF"].join("\n");
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

test("here-strings keep expanding: the word after <<< is command syntax, not body", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "skill-urls-"));
	try {
		const command = "grep pattern <<< " + INPUT_URL;
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
			"cat " + MID_URL,
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

test("skill URLs in heredoc bodies are preserved by expandSkillUrls", () => {
	const greetUrl = "skill" + "://greet";
	const command = ["cat > /tmp/skill-script <<'EOF'", `const url = "${greetUrl}"`, "EOF", greetUrl].join("\n");
	const expanded = expandSkillUrls(command, [skill]);
	const lines = expanded.split("\n");
	expect(lines[1]).toBe(`const url = "${greetUrl}"`);
	expect(lines[3]).toContain("/skills/greet");
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
				'echo "tail" ' + TAIL_URL,
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
