import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as utils from "@oh-my-pi/pi-utils";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	cleanSpawnEnvForTests,
	clearDirenvCachesForTests,
	findEnvrc,
	loadDirenvEnv,
	parseDirenvExport,
} from "./direnv";

const tmpDirs: TempDir[] = [];
function tmp(): string {
	const dir = TempDir.createSync("@pi-direnv-");
	tmpDirs.push(dir);
	return dir.path();
}

afterEach(async () => {
	for (const dir of tmpDirs.splice(0)) await dir.remove();
	clearDirenvCachesForTests();
	vi.restoreAllMocks();
});

describe("findEnvrc", () => {
	it("walks up to the nearest .envrc above the start dir", async () => {
		const root = tmp();
		await Bun.write(path.join(root, ".envrc"), "export A=1\n");
		const nested = path.join(root, "a", "b");
		await fs.mkdir(nested, { recursive: true });

		expect(await findEnvrc(nested)).toBe(path.join(root, ".envrc"));
	});

	it("prefers the nearest .envrc when monorepo dirs nest them", async () => {
		const root = tmp();
		await Bun.write(path.join(root, ".envrc"), "export A=1\n");
		const sub = path.join(root, "pkg");
		await fs.mkdir(sub, { recursive: true });
		await Bun.write(path.join(sub, ".envrc"), "export B=2\n");

		expect(await findEnvrc(sub)).toBe(path.join(sub, ".envrc"));
	});

	it("returns null when no .envrc exists up the tree", async () => {
		const nested = path.join(tmp(), "x", "y");
		await fs.mkdir(nested, { recursive: true });

		expect(await findEnvrc(nested)).toBeNull();
	});
});

describe("cleanSpawnEnv versioning", () => {
	it("picks up Bun.env mutations after the first cached call", () => {
		const marker = `OMP_DIRENV_TEST_${process.pid}`;
		const previous = Bun.env[marker];
		delete Bun.env[marker];
		clearDirenvCachesForTests();
		expect(cleanSpawnEnvForTests()[marker]).toBeUndefined();
		// Deferred MCP discovery mutates Bun.env mid-process (sdk.ts sets
		// EXA_API_KEY after the session is usable); a permanently cached
		// baseline would spawn direnv with stale values forever.
		Bun.env[marker] = "v1";
		try {
			expect(cleanSpawnEnvForTests()[marker]).toBe("v1");
		} finally {
			if (previous === undefined) delete Bun.env[marker];
			else Bun.env[marker] = previous;
			clearDirenvCachesForTests();
		}
	});
});

describe("parseDirenvExport", () => {
	it("splits set values from null unsets", () => {
		const out = parseDirenvExport('{"FOO":"bar","BAZ":null,"PATH":"/x:/y"}');

		expect(out.set).toEqual({ FOO: "bar", PATH: "/x:/y" });
		expect(out.unset).toEqual(["BAZ"]);
	});

	it("treats empty / whitespace output as no diff", () => {
		expect(parseDirenvExport("")).toEqual({ set: {}, unset: [] });
		expect(parseDirenvExport("  \n")).toEqual({ set: {}, unset: [] });
	});
});

/** A real subprocess speaks direnv's export protocol; only binary discovery is replaced. */
async function fakeDirenv(root: string): Promise<string> {
	const script = path.join(root, "direnv.ts");
	const executable = path.join(root, "direnv");
	await Bun.write(
		script,
		`
import { deflateSync } from "node:zlib";
import * as fs from "node:fs/promises";
const root = ${JSON.stringify(root)};
const envrc = root + "/.envrc";
const value = await Bun.file(envrc).text();
if (process.argv[2] === "status") {
 if (value === "old-version") process.exit(1);
 process.stdout.write(JSON.stringify({state:{foundRC:{allowed:2}}}));
 process.exit(0);
}
let count = 0;
try { count = Number(await Bun.file(root + "/count").text()); } catch {}
await Bun.write(root + "/count", String(count + 1));
const watches = await Promise.all([envrc,root+"/watched"].map(async path => {
 try { const stat = await fs.stat(path); return {path,modtime:Math.floor(stat.mtimeMs/1000),exists:true}; }
 catch { return {path,modtime:0,exists:false}; }
}));
if (Bun.env.DIRENV_DIFF === value) process.stdout.write("{}");
else process.stdout.write(JSON.stringify({
 ...(value === "denied" || value === "old-version" ? {} : {PROTO_TEST_FEATURE:await Bun.file(root+"/watched").text()}),
 DIRENV_DIFF:value,
 DIRENV_WATCHES:deflateSync(JSON.stringify(watches)).toString("base64url")
}));
`,
	);
	await Bun.write(
		executable,
		`#!/bin/sh
exec '${process.execPath.replaceAll("'", "'\\''")}' '${script}' "$@"
`,
	);
	await fs.chmod(executable, 0o700);
	spyOn(utils, "$which").mockImplementation(name => (name === "direnv" ? executable : null));
	return root;
}

describe("direnv cached export protocol", () => {
	it("reuses a warm diff but reloads same-second watched-file edits", async () => {
		const root = await fakeDirenv(tmp());
		await Bun.write(path.join(root, ".envrc"), "allowed");
		await Bun.write(path.join(root, "watched"), "first");
		expect((await loadDirenvEnv(root))?.set.PROTO_TEST_FEATURE).toBe("first");
		expect((await loadDirenvEnv(root))?.set.PROTO_TEST_FEATURE).toBe("first");
		expect(await Bun.file(path.join(root, "count")).text()).toBe("1");
		await Bun.write(path.join(root, "watched"), "changed in the same second");
		expect((await loadDirenvEnv(root))?.set.PROTO_TEST_FEATURE).toBe("changed in the same second");
		expect(await Bun.file(path.join(root, "count")).text()).toBe("2");
	});

	it.each(["denied", "old-version"])(
		"honors denied status while accepting old direnv without JSON status: %s",
		async value => {
			const root = await fakeDirenv(tmp());
			await Bun.write(path.join(root, ".envrc"), value);
			const result = await loadDirenvEnv(root);
			if (value === "denied") expect(result).toBeNull();
			else expect(result?.set.DIRENV_DIFF).toBe("old-version");
		},
	);
});
