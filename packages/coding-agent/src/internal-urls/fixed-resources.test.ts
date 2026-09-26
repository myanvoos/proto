import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { gzipSync } from "node:zlib";

const docs = {
	"index.md": "# Overview\n",
	"tools/read.md": "# Read\nSearchable bundled documentation\n",
};

async function runFixture<T = unknown>(home: string, body: string, contents: typeof docs | null = docs): Promise<T> {
	const filenames = Object.keys(contents ?? {}).sort();
	const payload = `${JSON.stringify(filenames)}\n${gzipSync(
		JSON.stringify(filenames.map(filename => contents![filename as keyof typeof docs])),
	).toString("base64")}`;
	const script = `
		import * as fs from "node:fs/promises";
		import * as path from "node:path";
		import { parseFrontmatter } from "@oh-my-pi/pi-utils";
		import { HarnessProtocolHandler } from "./harness-protocol";
		import { RuleProtocolHandler } from "./rule-protocol";
		import { parseInternalUrl } from "./parse";
		import { BUILTIN_DEFAULTS_PROVIDER_ID, setActiveRules } from "../capability/rule";
		import { BUILTIN_RULE_SOURCES } from "../discovery/builtin-rules";
		const handler = new HarnessProtocolHandler();
		const resolve = input => handler.resolve(parseInternalUrl(input));
		${body}
	`;
	const child = Bun.spawn([process.execPath, "--eval", script], {
		cwd: import.meta.dir,
		env: {
			...process.env,
			HOME: home,
			PI_DOCS_EMBED: contents === null ? "" : payload,
			PROTO_PROFILE: "",
			PI_PROFILE: "",
			PI_CODING_AGENT_DIR: "",
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (exitCode !== 0) throw new Error(`Fixture failed (${exitCode}): ${stderr}`);
	return JSON.parse(stdout);
}

async function withHome(run: (home: string) => Promise<void>): Promise<void> {
	const home = await fs.mkdtemp(path.join(os.tmpdir(), "fixed-resources-"));
	try {
		await run(home);
	} finally {
		await fs.rm(home, { recursive: true, force: true });
	}
}

test("harness files, root, aliases and subdirectories expose read-only searchable cache paths", async () => {
	await withHome(async home => {
		const result = await runFixture(
			home,
			`
			const root = await resolve("harness://");
			const tools = await resolve("harness://tools/");
			const file = await resolve("harness://tools/read.md");
			const alias = await resolve("harness://docs/tools/read.md");
			const encoded = await resolve("harness://tools/%72ead.md");
			const search = Bun.spawn(["rg", "--files", root.sourcePath], { stdout: "pipe" });
			const found = await new Response(search.stdout).text();
			const searchExit = await search.exited;
			console.log(JSON.stringify({
				inCache: root.sourcePath.startsWith(path.join(process.env.HOME, ".proto/cache/docs") + path.sep),
				rootDirectory: (await fs.stat(root.sourcePath)).isDirectory() && root.isDirectory,
				toolsDirectory: (await fs.stat(tools.sourcePath)).isDirectory() && tools.isDirectory,
				toolsPath: tools.sourcePath === path.join(root.sourcePath, "tools"),
				bodyMatches: await fs.readFile(file.sourcePath, "utf8") === file.content,
				readOnly: ((await fs.stat(file.sourcePath)).mode & 0o222) === 0,
				aliasesMatch: alias.sourcePath === file.sourcePath && encoded.sourcePath === file.sourcePath,
				searchExit, searchable: found.includes("tools/read.md"),
			}));
		`,
		);
		expect(result).toEqual({
			inCache: true,
			rootDirectory: true,
			toolsDirectory: true,
			toolsPath: true,
			bodyMatches: true,
			readOnly: true,
			aliasesMatch: true,
			searchExit: 0,
			searchable: true,
		});
	});
});

test("bundled documentation persists across processes and changes keys with its content", async () => {
	await withHome(async home => {
		const body = `
			const file = await resolve("harness://index.md");
			const stat = await fs.stat(file.sourcePath);
			console.log(JSON.stringify({ path: file.sourcePath, inode: stat.ino, modified: stat.mtimeMs }));
		`;
		const first = await runFixture<{ path: string }>(home, body);
		expect(await runFixture<{ path: string }>(home, body)).toEqual(first);
		const changed = await runFixture<{ path: string }>(home, body, { ...docs, "index.md": "# Changed\n" });
		expect(changed.path).not.toBe(first.path);
		expect(await fs.readFile(first.path, "utf8")).toBe(docs["index.md"]);
	});
});

test("concurrent first access publishes one complete documentation tree", async () => {
	await withHome(async home => {
		const body = `
			const root = await resolve("harness://");
			const file = await resolve("harness://tools/read.md");
			console.log(JSON.stringify({ root: root.sourcePath, content: await fs.readFile(file.sourcePath, "utf8") }));
		`;
		const [first, second, third] = await Promise.all([
			runFixture(home, body),
			runFixture(home, body),
			runFixture(home, body),
		]);
		expect(second).toEqual(first);
		expect(third).toEqual(first);
		expect(first).toMatchObject({ content: docs["tools/read.md"] });
	});
});

test("harness rejects raw and encoded parent traversal before normalization", async () => {
	await withHome(async home => {
		const result = await runFixture(
			home,
			`
			const inputs = ["harness://tools/../index.md", "harness://tools/%2e%2e/index.md", "harness://tools/%2e%2e%5cindex.md"];
			const rejected = [];
			for (const input of inputs) {
				try { await resolve(input); rejected.push(false); }
				catch (error) { rejected.push(error.message.includes("Path traversal")); }
			}
			console.log(JSON.stringify(rejected));
		`,
		);
		expect(result).toEqual([true, true, true]);
	});
});

test("built-in rules expose persistent read-only bodies and custom rules retain their source path", async () => {
	await withHome(async home => {
		const result = await runFixture(
			home,
			`
			const source = BUILTIN_RULE_SOURCES[0];
			const virtualPath = BUILTIN_DEFAULTS_PROVIDER_ID + ":" + source.name + ".md";
			const rule = { name: source.name, content: parseFrontmatter(source.content).body, path: virtualPath,
				_source: { provider: BUILTIN_DEFAULTS_PROVIDER_ID, path: virtualPath, providerName: "Builtin", level: "user" } };
			const customPath = path.join(process.env.HOME, "custom.md");
			await fs.writeFile(customPath, "custom rule");
			setActiveRules([rule, { ...rule, name: "custom", content: "custom rule", path: customPath,
				_source: { ...rule._source, provider: "custom", path: customPath } }]);
			const rules = new RuleProtocolHandler();
			const builtin = await rules.resolve(parseInternalUrl("rule://" + rule.name));
			const custom = await rules.resolve(parseInternalUrl("rule://custom"));
			console.log(JSON.stringify({
				inCache: builtin.sourcePath.startsWith(path.join(process.env.HOME, ".proto/cache/docs") + path.sep),
				bodyMatches: await fs.readFile(builtin.sourcePath, "utf8") === builtin.content,
				readOnly: ((await fs.stat(builtin.sourcePath)).mode & 0o222) === 0,
				allUnpacked: (await fs.readdir(path.dirname(builtin.sourcePath))).length === BUILTIN_RULE_SOURCES.length,
				customPathPreserved: custom.sourcePath === customPath,
			}));
		`,
		);
		expect(result).toEqual({
			inCache: true,
			bodyMatches: true,
			readOnly: true,
			allUnpacked: true,
			customPathPreserved: true,
		});
	});
});

test("source checkout documentation reuses files and directories without creating a cache", async () => {
	await withHome(async home => {
		const result = await runFixture(
			home,
			`
			const docsRoot = path.resolve("../../../../docs");
			const original = await fs.stat(path.join(docsRoot, "tools/read.md"));
			const root = await resolve("harness://");
			const tools = await resolve("harness://tools/");
			const file = await resolve("harness://tools/read.md");
			const resolved = await fs.stat(file.sourcePath);
			let cacheCreated = true;
			try { await fs.access(path.join(process.env.HOME, ".proto/cache/docs")); }
			catch (error) { if (error.code !== "ENOENT") throw error; cacheCreated = false; }
			console.log(JSON.stringify({
				root: root.sourcePath === docsRoot,
				tools: tools.sourcePath === path.join(docsRoot, "tools"),
				file: file.sourcePath === path.join(docsRoot, "tools/read.md"),
				originalFile: original.ino === resolved.ino && original.mode === resolved.mode,
				content: file.content === await fs.readFile(file.sourcePath, "utf8"),
				cacheCreated,
			}));
		`,
			null,
		);
		expect(result).toEqual({
			root: true,
			tools: true,
			file: true,
			originalFile: true,
			content: true,
			cacheCreated: false,
		});
	});
});
