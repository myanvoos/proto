import { afterEach, expect, spyOn, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { computeDefaultSessionDir } from "./session-paths";
import { MemorySessionStorage } from "./session-storage";

const directories: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

test("a temp root nested in home recovers both home-relative and hashed-home transcripts into its temp bucket", () => {
	const sessions = fs.mkdtempSync(path.join(os.tmpdir(), "proto-temp-precedence-"));
	directories.push(sessions);
	const nestedTemp = path.join(os.homedir(), "proto-migration-fixture-temp");
	const cwd = path.join(nestedTemp, "project");
	const oldRelative = path.join(sessions, `-${path.relative(os.homedir(), cwd).replaceAll(path.sep, "-")}`);
	const oldHashed = path.join(sessions, `home-project-${Bun.SHA256.hash(cwd.replaceAll("\\", "/"), "hex")}`);
	fs.mkdirSync(oldRelative, { recursive: true });
	fs.mkdirSync(oldHashed, { recursive: true });
	fs.writeFileSync(path.join(oldRelative, "named.jsonl"), "named transcript");
	fs.writeFileSync(path.join(oldHashed, "hashed.jsonl"), "hashed transcript");
	spyOn(os, "tmpdir").mockReturnValue(nestedTemp);
	const destination = computeDefaultSessionDir(cwd, new MemorySessionStorage(), sessions);
	expect(path.basename(destination)).toBe("-tmp-project");
	expect(fs.readFileSync(path.join(destination, "named.jsonl"), "utf8")).toBe("named transcript");
	expect(fs.readFileSync(path.join(destination, "hashed.jsonl"), "utf8")).toBe("hashed transcript");
	expect(fs.existsSync(oldHashed)).toBe(false);
});
